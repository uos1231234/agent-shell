# v0.26 Wave 1 — IME spike ConPTY harness (scratch, not shipped).
#
# Spawns a child under a real Windows pseudo-console (ConPTY), then injects
# IME-commit-equivalent text into the ConPTY input stream. Windows Terminal
# sits on a ConPTY and, after the user's IME commits a composition, writes
# the committed characters as UTF-8 into this exact stream. Round-tripping
# here verifies the *data path* (ConPTY -> console input records -> libuv
# raw mode -> stdin data events). It does NOT verify the human-facing IME
# composition window, which needs a person typing.
#
# Run from repo root:  powershell -NoProfile -ExecutionPolicy Bypass -File cli\scratch-conpty-ime.ps1
# Two child runs: (1) cmd.exe echo — proves the plumbing; (2) node raw-mode
# scratch script — the actual IME data-path probe.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class ConPTYNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct COORD { public short X; public short Y;
    public COORD(short x, short y) { X = x; Y = y; } }

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern int ClosePseudoConsole(IntPtr hPC);

  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES attrs, uint nSize);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnValue);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEXW {
    public uint cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
    public IntPtr lpAttributeList;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcessW(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEXW lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool PeekNamedPipe(IntPtr hNamedPipe, byte[] lpBuffer, uint nBufferSize, out uint lpBytesRead, out uint lpTotalBytesAvail, out uint lpBytesLeftThisMessage);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
'@

function New-PipePair {
  # Inheritable: ConPTY's internal OpenConsole must inherit these handles
  # (matches the official ConPTY sample's SECURITY_ATTRIBUTES).
  $sa = New-Object ConPTYNative+SECURITY_ATTRIBUTES
  $sa.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf($sa)
  $sa.bInheritHandle = 1
  $read = [IntPtr]::Zero; $write = [IntPtr]::Zero
  $ok = [ConPTYNative]::CreatePipe([ref]$read, [ref]$write, [ref]$sa, 0)
  if (-not $ok) { throw "CreatePipe failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  return @($read, $write)
}

function Read-ConPTYOutput {
  # Non-blocking poll: PeekNamedPipe first, only ReadFile when bytes exist.
  param([IntPtr]$handle, [int]$ms)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $sb = New-Object System.Text.StringBuilder
  $buf = New-Object byte[] 4096
  while ($sw.ElapsedMilliseconds -lt $ms) {
    $avail = [uint32]0; $left = [uint32]0; $readN = [uint32]0
    $peek = [ConPTYNative]::PeekNamedPipe($handle, $null, 0, [ref]$readN, [ref]$avail, [ref]$left)
    if ($peek -and $avail -gt 0) {
      $n = [uint32]0
      $ok = [ConPTYNative]::ReadFile($handle, $buf, $avail, [ref]$n, [IntPtr]::Zero)
      if ($ok -and $n -gt 0) {
        [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, [int]$n))
      }
    }
    Start-Sleep -Milliseconds 30
  }
  return $sb.ToString()
}

function Invoke-ConPTYChild {
  param(
    [string]$AppPath,
    [string]$CmdLine,
    [string]$WorkDir,
    [string]$InjectText,
    [int]$BootMs = 1500,
    [int]$CollectMs = 4000
  )
  $ptyIn  = New-PipePair   # we write -> ConPTY reads (child keyboard input)
  $ptyOut = New-PipePair   # ConPTY writes -> we read (child screen output)

  $hPC = [IntPtr]::Zero
  $rc = [ConPTYNative]::CreatePseudoConsole(
    (New-Object ConPTYNative+COORD -ArgumentList 100, 40),
    $ptyIn[0], $ptyOut[1], 0, [ref]$hPC)
  if ($rc -ne 0) { throw "CreatePseudoConsole failed: HRESULT $rc" }

  $attrSize = [IntPtr]::Zero
  [void][ConPTYNative]::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attrSize)
  $attrList = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($attrSize)
  [void][ConPTYNative]::InitializeProcThreadAttributeList($attrList, 1, 0, [ref]$attrSize)

  $PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = [IntPtr]0x00020016
  # lpValue must POINT AT the pseudoconsole handle (a location holding HPC).
  $pcSlot = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.IntPtr]::Size)
  [System.Runtime.InteropServices.Marshal]::WriteIntPtr($pcSlot, $hPC)
  $ok = [ConPTYNative]::UpdateProcThreadAttribute($attrList, 0, $PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, $pcSlot, [IntPtr][System.IntPtr]::Size, [IntPtr]::Zero, [IntPtr]::Zero)
  if (-not $ok) { throw "UpdateProcThreadAttribute failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

  $si = New-Object ConPTYNative+STARTUPINFOEXW
  $si.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($si)
  $si.lpAttributeList = $attrList
  $pi = New-Object ConPTYNative+PROCESS_INFORMATION

  $EXTENDED_STARTUPINFO_PRESENT = 0x00080000
  $ok = [ConPTYNative]::CreateProcessW($AppPath, $CmdLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, $EXTENDED_STARTUPINFO_PRESENT, [IntPtr]::Zero, $WorkDir, [ref]$si, [ref]$pi)
  if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    foreach ($h in @($ptyIn[0], $ptyIn[1], $ptyOut[0], $ptyOut[1])) { [void][ConPTYNative]::CloseHandle($h) }
    [void][ConPTYNative]::ClosePseudoConsole($hPC)
    throw "CreateProcessW failed: $err"
  }
  Write-Host "[harness] child pid=$($pi.dwProcessId) cmd=$CmdLine"

  $early = Read-ConPTYOutput -handle $ptyOut[0] -ms $BootMs
  if ($early.Length -gt 0) { Write-Host "[harness] boot output: $($early -replace "`x1b", '<ESC>' -replace "`r`n", ' | ')" }

  if ($InjectText -ne '') {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($InjectText)
    $n = [uint32]0
    $ok = [ConPTYNative]::WriteFile($ptyIn[1], $bytes, [uint32]$bytes.Length, [ref]$n, [IntPtr]::Zero)
    Write-Host "[harness] wrote $n bytes into ConPTY input: `"$($InjectText -replace "`r", '<CR>')`""
  }

  $rest = Read-ConPTYOutput -handle $ptyOut[0] -ms $CollectMs
  Write-Host "[harness] collected output ($($rest.Length) chars):"
  Write-Host ($rest -replace "`x1b", '<ESC>')

  $exited = [ConPTYNative]::WaitForSingleObject($pi.hProcess, 500)
  $exitCode = [uint32]0
  [void][ConPTYNative]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode)
  Write-Host "[harness] child signaled=$exited (0=exited) exitCode=$exitCode (259=still running)"

  [void][ConPTYNative]::TerminateProcess($pi.hProcess, 1)
  [void][ConPTYNative]::WaitForSingleObject($pi.hProcess, 2000)
  [void][ConPTYNative]::ClosePseudoConsole($hPC)
  [void][ConPTYNative]::DeleteProcThreadAttributeList($attrList)
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($attrList)
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pcSlot)
  foreach ($h in @($ptyIn[0], $ptyIn[1], $ptyOut[0], $ptyOut[1], $pi.hProcess, $pi.hThread)) { [void][ConPTYNative]::CloseHandle($h) }
}

$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "=== run 1: plumbing check (cmd.exe echo) ==="
$cmdExe = "$env:SystemRoot\System32\cmd.exe"
Invoke-ConPTYChild -AppPath $cmdExe -CmdLine 'cmd /c echo CONPTY-PIPEWORKS' -WorkDir $repoRoot -InjectText ''

Write-Host "`n=== run 2: node raw-mode scratch script + committed-IME-equivalent injection ==="
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$scriptPath = Join-Path $repoRoot 'cli\scratch-ime.mjs'
Remove-Item (Join-Path $repoRoot 'cli\scratch-ime.log') -ErrorAction SilentlyContinue
# "你好，世界！ABC\r" — the UTF-8 bytes Windows Terminal writes into the ConPTY
# input stream after an IME composition of 你好，世界！ commits (built from
# code points to keep this file pure ASCII).
$committed = [string][char]0x4F60 + [string][char]0x597D + [string][char]0xFF0C + [string][char]0x4E16 + [string][char]0x754C + [string][char]0xFF01 + 'ABC' + "`r"
Invoke-ConPTYChild -AppPath $nodeExe -CmdLine "`"$nodeExe`" `"$scriptPath`"" -WorkDir $repoRoot -InjectText $committed

Write-Host "`n[harness] child evidence log (cli/scratch-ime.log):"
Get-Content (Join-Path $repoRoot 'cli\scratch-ime.log') -ErrorAction SilentlyContinue | Select-Object -Last 20
