@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Mcp.ps1" %*
echo.
pause
exit /b %ERRORLEVEL%
