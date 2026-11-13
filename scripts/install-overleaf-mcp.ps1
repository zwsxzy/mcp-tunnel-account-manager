#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装 overleaf-mcp（npm mcp-server-overleaf@0.3.9）。
.DESCRIPTION
    等价于 install-components.ps1 -Component overleaf-mcp。
    需要 Node.js >= 22.14.0（mcp-server-overleaf 0.3.9 的 engines 要求）。
    安装到 %USERPROFILE%\.overleaf-mcp\runtime\，并写入 %APPDATA%\tunnel-client\overleaf.yaml。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-overleaf-mcp.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileRoot = $env:USERPROFILE,
    [string]$AppDataRoot = '',
    [switch]$Force,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$forward = @{ Component = @('overleaf-mcp'); ProfileRoot = $ProfileRoot; Force = $Force; VerifyOnly = $VerifyOnly }
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
