#Requires -Version 5.1
<#
  免输入启动 Overleaf 隧道。
  - Runtime API Key 从受保护的本地文件读取，只注入当前进程环境，不写入 YAML/日志。
  - 若存在受保护的 Overleaf Git token 文件，则注入 OVERLEAF_GIT_TOKEN；否则启动时提示。
  用法：双击 start-overleaf-tunnel-auto.cmd，或直接运行本脚本。
#>
param(
    [string]$ProfileFile = (Join-Path $PSScriptRoot 'overleaf-local.yaml'),
    [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
$taskExit = 1
$taskOriginalDirectory = (Get-Location).Path
$taskPrevious = @{}
$taskNames = @('CONTROL_PLANE_API_KEY','DEPLOYMENT_MCP_COMMAND','OVERLEAF_GIT_TOKEN','TUNNEL_CLIENT_CONFIG','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_BASE_URL')
try {
    $taskBundle = Split-Path -Parent $PSScriptRoot
    . (Join-Path $taskBundle 'launchers\Runtime-Helpers.ps1')

    $taskKeys = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\keys'
    $taskKeyFile = Join-Path $taskKeys 'antigravity-runtime.key'   # 同一 Runtime API Key 已验证可用于 Overleaf 隧道
    if (-not (Test-Path -LiteralPath $taskKeyFile -PathType Leaf)) { throw ('未找到 Key 文件：' + $taskKeyFile) }
    $taskKey = (Get-Content -LiteralPath $taskKeyFile -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($taskKey)) { throw 'Key 文件为空。' }

    $taskNode = Get-McpNode -BundleRoot $taskBundle -MinimumMajor 22
    $taskEntry = (Get-Item -LiteralPath (Join-Path $taskBundle 'servers\overleaf-mcp\node_modules\mcp-server-overleaf\dist\index.js')).FullName
    $taskCommand = Join-McpCommand -Arguments @($taskNode,$taskEntry,'--stdio')

    $taskTokenFile = Join-Path $taskKeys 'overleaf-git-token.key'
    $taskGitToken = $null
    if (Test-Path -LiteralPath $taskTokenFile -PathType Leaf) {
        $taskGitToken = (Get-Content -LiteralPath $taskTokenFile -Raw).Trim()
        if ([string]::IsNullOrWhiteSpace($taskGitToken)) { $taskGitToken = $null }
    } else {
        Write-Host '提示：未找到 overleaf-git-token.key，Overleaf 项目读写工具将不可用（隧道本身可启动）。' -ForegroundColor Yellow
        Write-Host ('      可把 Git token 保存到：' + $taskTokenFile)
    }

    foreach ($taskName in $taskNames) {
        $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process')
    }
    if ($taskGitToken) { $env:OVERLEAF_GIT_TOKEN = $taskGitToken }
    $env:CONTROL_PLANE_API_KEY = $taskKey
    $env:DEPLOYMENT_MCP_COMMAND = $taskCommand

    Write-Host 'Overleaf 隧道启动中（Key 来自受保护文件，不落日志）...' -ForegroundColor Cyan
    Write-Host ('配置：' + $ProfileFile)
    Write-Host ('MCP ：' + $taskCommand)
    Set-Location -LiteralPath $taskBundle
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
