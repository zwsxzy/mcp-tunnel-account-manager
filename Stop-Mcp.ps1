#Requires -Version 5.1
<#
  一键关闭 MCP 隧道与控制台。

  停止对象：
    - tunnel-client.exe（本部署 tunnel-client 目录下的实例，逐个识别）
    - 控制台 node.exe（由 launch-manager.mjs 启动，监听 127.0.0.1:17642）

  设计要点：
    - 复用 console\scripts\process-control.ps1 的审计式停止（要求可执行路径
      与创建时间双重匹配），不做裸 PID kill。
    - 只终止本部署路径下的隧道进程；不触碰 DeepSeek Harness、
      Antigravity IDE、Codex app-server 等无关宿主进程。
    - 不修改 %LOCALAPPDATA%\McpTunnelAccountManager 下的 manager.db / master.key。

  用法：
    powershell -File Stop-Mcp.ps1              # 停止隧道与控制台
    powershell -File Stop-Mcp.ps1 -TunnelsOnly # 只停隧道
    powershell -File Stop-Mcp.ps1 -ConsoleOnly # 只停控制台
    powershell -File Stop-Mcp.ps1 -DryRun      # 只列出将要停止的进程

  退出码：0 成功（含本就未运行）；1 有进程未能停止。
#>
param(
    [string]$BundleRoot = '',
    [switch]$TunnelsOnly,
    [switch]$ConsoleOnly,
    [ValidateRange(1, 65535)][int]$Port = 17642,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$taskExit = 0
$taskResults = New-Object System.Collections.ArrayList

function Write-Result {
    param([string]$Kind, [string]$Detail)
    $null = $taskResults.Add([PSCustomObject]@{ kind = $Kind; detail = $Detail })
    Write-Host ("  [{0}] {1}" -f $Kind, $Detail)
}

function Resolve-BundleRoot {
    if ($BundleRoot) {
        return (Resolve-Path -LiteralPath $BundleRoot -ErrorAction Stop).Path
    }
    $dir = $PSScriptRoot
    for ($i = 0; $i -lt 5 -and $dir; $i++) {
        if (Test-Path -LiteralPath (Join-Path $dir 'package-manifest.json') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $dir).Path
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    throw 'BUNDLE_ROOT_REQUIRED: 找不到包含 package-manifest.json 的部署根目录。'
}

function Stop-SingleProcess {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][string]$Helper,
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [Parameter(Mandatory = $true)][string]$CreationTimeFileTime
    )
    $label = ("{0} (PID {1})" -f $Process.Name, $Process.ProcessId)

    if ($DryRun) {
        Write-Result 'DRYRUN' ("将停止 {0}  {1}" -f $label, $ExpectedPath)
        return
    }

    try {
        $raw = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Helper `
            -Action Stop `
            -ProcessId $Process.ProcessId `
            -ExpectedExecutablePath $ExpectedPath `
            -ExpectedCreationTimeFileTime $CreationTimeFileTime 2>$null
        $res = ($raw | Out-String).Trim() | ConvertFrom-Json
        if ($res.success -and $res.stopped) {
            Write-Result 'STOPPED' $label
        } else {
            Write-Result 'FAILED' ("{0}  -> {1}" -f $label, $res.reason)
            $script:taskExit = 1
        }
    } catch {
        Write-Result 'FAILED' ("{0}  -> {1}" -f $label, $_.Exception.Message)
        $script:taskExit = 1
    }
}

function Get-AuditedIdentity {
    param([Parameter(Mandatory = $true)]$Process, [Parameter(Mandatory = $true)][string]$Helper)
    $raw = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Helper `
        -Action Inspect -ProcessId $Process.ProcessId 2>$null
    $obj = ($raw | Out-String).Trim() | ConvertFrom-Json
    if (-not $obj.success -or -not $obj.creationTimeFileTime) { return $null }
    return $obj
}

try {
    $taskRoot = Resolve-BundleRoot
    $taskHelper = Join-Path $taskRoot 'console\scripts\process-control.ps1'
    if (-not (Test-Path -LiteralPath $taskHelper -PathType Leaf)) {
        throw ('缺少审计式进程控制脚本：' + $taskHelper)
    }

    Write-Host ('部署根目录：' + $taskRoot)
    if ($DryRun) { Write-Host '*** DryRun：只列出，不停止 ***' }

    # ---------- 1) 隧道 ----------
    if (-not $ConsoleOnly) {
        Write-Host ''
        Write-Host '== 隧道 tunnel-client =='
        $taskTunnelExe = Join-Path $taskRoot 'tunnel-client\tunnel-client.exe'
        $taskTunnelExe = [IO.Path]::GetFullPath($taskTunnelExe)

        if (-not (Test-Path -LiteralPath $taskTunnelExe -PathType Leaf)) {
            Write-Result 'SKIP' ('未找到 ' + $taskTunnelExe)
        } else {
            $taskFound = @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $taskTunnelExe) })

            if ($taskFound.Count -eq 0) {
                Write-Result 'IDLE' '没有正在运行的隧道进程'
            } else {
                foreach ($taskProc in $taskFound) {
                    $taskId = Get-AuditedIdentity -Process $taskProc -Helper $taskHelper
                    if ($null -eq $taskId) {
                        Write-Result 'FAILED' ("无法核验身份：PID " + $taskProc.ProcessId)
                        $script:taskExit = 1
                        continue
                    }
                    Stop-SingleProcess -Process $taskProc -Helper $taskHelper `
                        -ExpectedPath $taskId.executablePath `
                        -CreationTimeFileTime $taskId.creationTimeFileTime
                }
            }
        }
    }

    # ---------- 2) 控制台 ----------
    if (-not $TunnelsOnly) {
        Write-Host ''
        Write-Host '== 控制台 =='
        $taskConsoleNode = Join-Path $taskRoot 'console\runtime\node.exe'
        $taskConsoleNode = [IO.Path]::GetFullPath($taskConsoleNode)

        # 优先用 pid 文件定位，回退到端口监听者；两者都要通过身份核验。
        $taskCandidates = @()

        $taskPidFile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) `
            ('McpTunnelAccountManager\console-{0}.pid.json' -f $Port)
        if (Test-Path -LiteralPath $taskPidFile -PathType Leaf) {
            try {
                $taskPidObj = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
                if ($taskPidObj.processId) {
                    $taskCandidates += [int]$taskPidObj.processId
                }
            } catch { }
        }

        $taskListenerPid = 0
        try {
            $taskListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -First 1
            if ($taskListener) { $taskListenerPid = [int]$taskListener.OwningProcess }
        } catch { }

        if ($taskListenerPid -gt 0 -and ($taskCandidates -notcontains $taskListenerPid)) {
            $taskCandidates += $taskListenerPid
        }

        $taskStoppedConsole = $false
        foreach ($taskPid in $taskCandidates) {
            $taskProc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $taskPid) -ErrorAction SilentlyContinue
            if (-not $taskProc) { continue }

            $taskExe = $null
            if ($taskProc.ExecutablePath) { $taskExe = [IO.Path]::GetFullPath($taskProc.ExecutablePath) }
            if ($null -eq $taskExe -or $taskExe -ine $taskConsoleNode) {
                Write-Result 'SKIP' ("PID {0} 不是本部署的控制台（{1}）" -f $taskPid, $taskExe)
                continue
            }

            $taskId = Get-AuditedIdentity -Process $taskProc -Helper $taskHelper
            if ($null -eq $taskId) {
                Write-Result 'FAILED' ("无法核验身份：PID " + $taskPid)
                $script:taskExit = 1
                continue
            }
            Stop-SingleProcess -Process $taskProc -Helper $taskHelper `
                -ExpectedPath $taskId.executablePath `
                -CreationTimeFileTime $taskId.creationTimeFileTime
            $taskStoppedConsole = $true
            break
        }

        if (-not $taskStoppedConsole) {
            if ($taskCandidates.Count -eq 0) {
                Write-Result 'IDLE' ('端口 {0} 无监听，且无 pid 文件记录' -f $Port)
            } else {
                Write-Result 'IDLE' ('端口 {0} 无监听（pid 文件为陈旧记录：{1}）' -f $Port, ($taskCandidates -join ','))
            }
        }
    }

    # ---------- 汇总 ----------
    Write-Host ''
    $taskSummary = ($taskResults | Group-Object kind | ForEach-Object {
        "{0}={1}" -f $_.Name, $_.Count
    }) -join '  '
    Write-Host ('结果：' + $taskSummary)

} catch {
    Write-Host ('一键关闭失败：' + $_.Exception.Message) -ForegroundColor Red
    $taskExit = 1
}
exit $taskExit
