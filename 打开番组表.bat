@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
set "PORT="
for /f "usebackq delims=" %%P in (`""%NODE%" "%~dp0tools\panel_service.mjs" --port"`) do set "PORT=%%P"
if not defined PORT (
  echo [tiara] Panel unavailable. Check cache\server.log or extract the full portable package.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:%PORT%/"
