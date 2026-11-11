@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-overleaf-tunnel-auto.ps1"
exit /b %ERRORLEVEL%
