@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Bridge-Manager.ps1"
if errorlevel 1 (
  echo.
  echo Bridge Manager exited with an error.
  pause
)
endlocal

