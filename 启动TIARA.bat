@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0pet\Pet.exe" (
  echo [tiara] Pet.exe is missing. Please extract the full portable package.
  pause
  exit /b 1
)
start "" "%~dp0pet\Pet.exe"
