@echo off
rem Double-click: install tunnel-client, overleaf-mcp and antigravity-mcp.
rem Installs into the current user profile; no administrator rights required.
rem On failure the window stays open and the non-zero exit code is returned.
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-components.ps1" %*
set "MCP_EXIT=%ERRORLEVEL%"
if not "%MCP_EXIT%"=="0" pause
exit /b %MCP_EXIT%