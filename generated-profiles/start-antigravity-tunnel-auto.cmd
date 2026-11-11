@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-antigravity-tunnel-auto.ps1"
exit /b %ERRORLEVEL%
