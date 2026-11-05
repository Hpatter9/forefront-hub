@echo off
setlocal
title Forefront Hub setup
rem Double-click this. It can sit anywhere (Downloads is fine): it puts the hub in C:\Games\forefront-hub,
rem next to the Estimator, sets it up, and adds a "Forefront Hub" icon to your desktop. Safe to run again.

set "HUB=C:\Games\forefront-hub"

rem ---- Git (to download the hub and keep it up to date)
where git >nul 2>nul
if errorlevel 1 (
  echo Installing Git...
  winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;C:\Program Files\Git\cmd"
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git didn't install. Install it from https://git-scm.com and double-click this again.
  start "" https://git-scm.com/download/win
  pause
  exit /b 1
)

rem ---- Download (first time) or update the hub
if exist "%HUB%\.git" (
  echo Updating the hub in %HUB%...
  git -C "%HUB%" pull --ff-only
) else (
  echo Downloading the hub to %HUB%. If a GitHub sign-in window opens, sign in as Hpatter9.
  if not exist "C:\Games" mkdir "C:\Games"
  git clone https://github.com/Hpatter9/forefront-hub.git "%HUB%"
)
if not exist "%HUB%\setup.ps1" (
  echo The download didn't work. Check your internet connection and GitHub sign-in, then double-click this again.
  pause
  exit /b 1
)

rem ---- Everything else
powershell -NoProfile -ExecutionPolicy Bypass -File "%HUB%\setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup stopped with the message above. Copy it to Claude.
  pause
  exit /b 1
)

echo.
echo Starting the hub now...
timeout /t 3 /nobreak >nul
start "" "%HUB%\Start Hub.bat"
exit /b 0
