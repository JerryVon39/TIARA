@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0pet\Pet.exe" start "" /wait "%~dp0pet\Pet.exe" --quit
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
"%NODE%" "%~dp0tools\panel_service.mjs" --stop
if errorlevel 1 (
  echo [tiara] Could not stop the panel. Check cache\server.log.
  pause
  exit /b 1
)
