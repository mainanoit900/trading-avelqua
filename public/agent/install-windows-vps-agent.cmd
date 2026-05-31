@echo off
setlocal
title Avelqua Windows VPS Agent Installer

if "%~1"=="" (
  echo.
  echo Usage: install-windows-vps-agent.cmd YOUR_AGENT_TOKEN
  echo.
  echo Get TOKEN from Admin -^> VPS -^> Edit -^> Agent TOKEN
  echo Run this file as Administrator.
  echo.
  pause
  exit /b 1
)

set "TOKEN=%~1"
set "PS1=%TEMP%\install-windows-vps-agent.ps1"

echo Downloading installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://trading.avelqua.com/agent/install-windows-vps-agent.ps1' -OutFile '%PS1%' -UseBasicParsing"
if errorlevel 1 (
  echo Download failed.
  pause
  exit /b 1
)

echo Running installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Token "%TOKEN%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Done.
) else (
  echo Installer exited with code %RC%
)
pause
exit /b %RC%
