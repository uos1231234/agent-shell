# make-desktop-shortcut.ps1 — 在桌面创建 H/E 启动快捷方式（图标 = launcher\he.ico）。
# Run: powershell -ExecutionPolicy Bypass -File launcher\make-desktop-shortcut.ps1

$ErrorActionPreference = 'Stop'
$launcher = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')

$ws = New-Object -ComObject WScript.Shell

# Web 入口
$lnkPath = Join-Path $desktop 'H-E agent-shell.lnk'
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = (Join-Path $launcher 'he.cmd')
$sc.WorkingDirectory = $launcher
$sc.IconLocation = (Join-Path $launcher 'he.ico')
$sc.Description = 'agent-shell — Human/Engineering harness (H/E)'
$sc.Save()
Write-Host "[HE] desktop shortcut created: $lnkPath"

# CLI/TUI 入口（v0.26）
$cliPath = Join-Path $desktop 'H-E CLI.lnk'
$cli = $ws.CreateShortcut($cliPath)
$cli.TargetPath = (Join-Path $launcher 'he-cli.cmd')
$cli.WorkingDirectory = $launcher
$cli.IconLocation = (Join-Path $launcher 'he.ico')
$cli.Description = 'agent-shell CLI/TUI (H/E)'
$cli.Save()
Write-Host "[HE] desktop shortcut created: $cliPath"
