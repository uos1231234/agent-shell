# he.ps1 — agent-shell (H/E) 一键启动器。
#
# 流程：检查 webapp 构建 → 找空闲端口 → 后台起 web-host（日志落
# launcher-data\host.log）→ 轮询日志抓 token → 打开浏览器（#token）→
# 前台跟随日志（关窗口 = 停止）。
# 无 ARK_KEY 时 web-host 自动进入 mock 模式（脚本化对话，可演示审批闭环）。
#
# 注意：不用 Receive-Job 转发 —— Windows PowerShell 5.1 在
# $ErrorActionPreference='Stop' 下会把 job 内 native 命令的 stderr 行
# 变成终止错误（NativeCommandError）。文件轮询是稳定路径。
#
# Run: powershell -ExecutionPolicy Bypass -File launcher\he.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'launcher-data'
$log = Join-Path $dataDir 'host.log'

Push-Location $root
try {
    # 1. webapp 构建产物检查
    if (-not (Test-Path "$root\webapp\dist\index.html")) {
        Write-Host '[HE] webapp dist missing - building (first run takes a minute)...'
        Push-Location "$root\webapp"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'webapp build failed' }
        Pop-Location
    }

    # 2. 数据目录 + 清旧日志
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    if (Test-Path $log) { Remove-Item $log -Force }

    # 2.5 清孤儿：点 X 直接关窗不会执行 finally（Stop-Job）。实测（2026-09-07）：
    #     main 被强杀后 node web-host 会在 ~2s 内被 job 子进程连带回收（端口
    #     只短暂残留），但 job 子 powershell 自身会永久残留（每点一次 X 泄漏
    #     一个空闲 PS 进程）。host.pid 记 (main,node) 两个 PID——main 确认
    #     已死才清理：先杀孤儿 job 子进程，node 若仍存活则一并杀（兜底）。
    $pidFile = Join-Path $dataDir 'host.pid'
    if (Test-Path $pidFile) {
        $stale = Get-Content $pidFile -Raw | ConvertFrom-Json
        $mainAlive = Get-Process -Id $stale.main -ErrorAction SilentlyContinue
        $mainReallyDead = ($null -eq $mainAlive) -or ($mainAlive.ProcessName -ne 'powershell')
        if ($mainReallyDead) {
            Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
                Where-Object { $_.ParentProcessId -eq $stale.main } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            $nodeAlive = Get-Process -Id $stale.node -ErrorAction SilentlyContinue
            if ($nodeAlive -and $nodeAlive.ProcessName -eq 'node') {
                Write-Host "[HE] killing stale host (node pid $($stale.node))"
                Stop-Process -Id $stale.node -Force
                Start-Sleep -Milliseconds 300
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }

    # 3. 找空闲端口（从 8787 往上）
    $port = 8787
    while (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue) { $port++ }

    # 4. 后台起 web-host（全部流追加进日志文件）
    $job = Start-Job -ScriptBlock {
        param($root, $port, $log)
        Set-Location $root
        npx tsx examples/web-host.ts --port $port --data-dir launcher-data --dist webapp/dist *>> $log
    } -ArgumentList $root, $port, $log

    # 5. 轮询日志抓 token
    $token = $null
    for ($i = 0; $i -lt 60 -and -not $token; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $log) {
            $raw = Get-Content $log -Raw -ErrorAction SilentlyContinue
            if ($raw -match 'token=([A-Za-z0-9_\-]+)') { $token = $Matches[1] }
            if ($raw -match 'fatal') { throw "web-host failed:`n$raw" }
        }
    }
    if (-not $token) {
        if (Test-Path $log) { Get-Content $log | Write-Host }
        throw 'web-host failed to start (no token in log)'
    }

    # 5.5 记录 (main, node) PID——node PID 即当前监听 $port 的进程，供下次
    #     启动清孤儿（见 2.5）；优雅退出路径由 finally 删除该文件。
    $nodePid = (Get-NetTCPConnection -LocalPort $port -State Listen |
        Select-Object -First 1).OwningProcess
    @{ main = $PID; node = $nodePid } | ConvertTo-Json | Set-Content $pidFile

    # 6. 打开浏览器
    $url = "http://127.0.0.1:$port/#token=$token"
    Write-Host "[HE] opening browser -> http://127.0.0.1:$port/"
    Start-Process $url

    # 7. 前台跟随日志（增量打印），关窗口 / Ctrl+C = 停止
    Write-Host '[HE] agent-shell running. Close this window to stop.'
    $shown = 0
    try {
        while ($job.State -eq 'Running') {
            if (Test-Path $log) {
                $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
                if ($lines.Count -gt $shown) {
                    $lines[$shown..($lines.Count - 1)] | ForEach-Object { Write-Host $_ }
                    $shown = $lines.Count
                }
            }
            Start-Sleep -Seconds 2
        }
    } finally {
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}
