#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装 tunnel-client（OpenAI 官方固定兼容版本 v0.0.19）。
.DESCRIPTION
    等价于 install-components.ps1 -Component tunnel-client。安装到 %USERPROFILE%\.openai-tunnel\，
    只覆盖发行包内的程序与伴随资源，不会删除该目录下已有的 tunnel.env、启动脚本或个人文件。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-tunnel-client.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileRoot = $env:USERPROFILE,
    [string]$AppDataRoot = '',
    [switch]$Force,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$forward = @{ Component = @('tunnel-client'); ProfileRoot = $ProfileRoot; Force = $Force; VerifyOnly = $VerifyOnly }
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
