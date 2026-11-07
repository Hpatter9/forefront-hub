@echo off
setlocal
title Keystone setup
rem Double-click this. It can sit anywhere (Downloads is fine): it puts Keystone in C:\Games\forefront-hub,
rem next to the Estimator, sets it up, and adds a "Keystone" icon to your desktop. Safe to run again.

set "HUB=C:\Games\forefront-hub"

rem ---- Git (to download Keystone and keep it up to date)
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

rem ---- Download (first time) or update Keystone
if exist "%HUB%\.git" (
  echo Updating Keystone in %HUB%...
  git -C "%HUB%" pull --ff-only
) else (
  echo Downloading Keystone to %HUB%. If a GitHub sign-in window opens, sign in as Hpatter9.
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
echo Starting Keystone now...
timeout /t 3 /nobreak >nul
start "" "%HUB%\Start Keystone.bat"
exit /b 0
