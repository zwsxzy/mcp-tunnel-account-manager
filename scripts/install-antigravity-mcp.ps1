#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装 antigravity-mcp（固定源 https://github.com/zwsxzy/antigravity-mcp-fork）。
.DESCRIPTION
    等价于 install-components.ps1 -Component antigravity-mcp。
    需要 Python >= 3.9（推荐 3.12）。该 fork 的 dependencies 为空，安装器不执行 pip 构建，
    而是把固定 commit 的源码放入 %USERPROFILE%\.antigravity-mcp\app，并由独立 venv 通过 .pth 引用。
    同时写入 %APPDATA%\tunnel-client\antigravity-local.yaml。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-antigravity-mcp.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileRoot = $env:USERPROFILE,
    [string]$AppDataRoot = '',
    [switch]$Force,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$forward = @{ Component = @('antigravity-mcp'); ProfileRoot = $ProfileRoot; Force = $Force; VerifyOnly = $VerifyOnly }
if (-not [string]::IsNullOrWhiteSpace($AppDataRoot)) { $forward['AppDataRoot'] = $AppDataRoot }
$code = 1
try {
    & (Join-Path $PSScriptRoot 'install-components.ps1') @forward
    if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
} catch {
    Write-Host "执行失败：$($_.Exception.Message)" -ForegroundColor Red
    $code = 1
}
exit $code
