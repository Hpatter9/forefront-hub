@echo off
title Forefront Hub - keep this window open while you use it
cd /d "%~dp0"
if not exist "node_modules" (
  echo The hub isn't set up yet. Double-click "Setup Forefront Hub" first.
  pause
  exit /b 1
)

rem Already running? Just open it.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', 4317); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" http://127.0.0.1:4317
  exit /b 0
)

rem Get the latest version (skipped quietly when offline).
set GIT_TERMINAL_PROMPT=0
where git >nul 2>nul && git pull --ff-only --quiet >nul 2>nul && call npm install --no-audit --no-fund --loglevel=error >nul 2>nul

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://127.0.0.1:4317'"
echo Forefront Hub is running at http://127.0.0.1:4317
echo Close this window to stop it.
call npm run -s app
pause
