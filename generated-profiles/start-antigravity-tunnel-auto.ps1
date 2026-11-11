#Requires -Version 5.1
<#
  免输入启动 Antigravity 隧道。
  Runtime API Key 从受保护的本地文件读取，只注入当前进程环境，不写入 YAML、不写入日志。
  用法：双击 start-antigravity-tunnel-auto.cmd，或直接运行本脚本。
#>
param(
    [string]$ProfileFile = (Join-Path $PSScriptRoot 'antigravity-local.yaml'),
    [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
$taskExit = 1
$taskOriginalDirectory = (Get-Location).Path
$taskPrevious = @{}
$taskNames = @('CONTROL_PLANE_API_KEY','DEPLOYMENT_MCP_COMMAND','PYTHONDONTWRITEBYTECODE','TUNNEL_CLIENT_CONFIG','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_BASE_URL')
try {
    $taskBundle = Split-Path -Parent $PSScriptRoot
    . (Join-Path $taskBundle 'launchers\Runtime-Helpers.ps1')

    $taskKeyFile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\keys\antigravity-runtime.key'
    if (-not (Test-Path -LiteralPath $taskKeyFile -PathType Leaf)) { throw ('未找到 Key 文件：' + $taskKeyFile) }
    $taskKey = (Get-Content -LiteralPath $taskKeyFile -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($taskKey)) { throw 'Key 文件为空。' }
    if ($taskKey -match '[\r\n]') { throw 'Key 文件格式无效。' }

    $taskPython = Get-McpPython
    $taskWork = (Get-Item -LiteralPath (Join-Path $taskBundle 'servers\antigravity-mcp')).FullName
    $taskCommand = Join-McpCommand -Arguments @($taskPython,'-m','antigravity_mcp')

    foreach ($taskName in $taskNames) {
        $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process')
        [Environment]::SetEnvironmentVariable($taskName,$null,'Process')
    }
    $env:CONTROL_PLANE_API_KEY = $taskKey
    $env:DEPLOYMENT_MCP_COMMAND = $taskCommand
    $env:PYTHONDONTWRITEBYTECODE = '1'

    Write-Host 'Antigravity 隧道启动中（Key 来自受保护文件，不落日志）...' -ForegroundColor Cyan
    Write-Host ('配置：' + $ProfileFile)
    Write-Host ('MCP ：' + $taskCommand)
    Set-Location -LiteralPath $taskWork
    $ErrorActionPreference = 'Continue'
    & (Join-Path $taskBundle 'tunnel-client\tunnel-client.exe') run --config $ProfileFile
    $taskExit = $LASTEXITCODE
    if ($null -eq $taskExit) { $taskExit = 1 }
} catch {
    Write-Host ('隧道未能启动：' + $_.Exception.Message) -ForegroundColor Red
    $taskExit = 1
} finally {
    $ErrorActionPreference = 'Stop'
    foreach ($taskName in $taskNames) {
        if ($taskPrevious.ContainsKey($taskName)) {
            [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process')
        }
    }
    Set-Location -LiteralPath $taskOriginalDirectory
}
if ($taskExit -ne 0 -and -not $NoPause) {
    Write-Host '按回车关闭窗口...' -ForegroundColor Yellow
    $null = Read-Host
}
exit $taskExit

