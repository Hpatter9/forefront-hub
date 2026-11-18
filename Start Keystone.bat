@echo off
title Keystone - keep this window open while you use it
cd /d "%~dp0"
if not exist "node_modules" (
  echo Keystone isn't set up yet. Double-click "Setup Forefront Hub" first.
  pause
  exit /b 1
)
set GIT_TERMINAL_PROMPT=0

rem Already running? Open it, unless a newer version is waiting: then stop the old one and start fresh.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', 4317); exit 0 } catch { exit 1 }"
if errorlevel 1 goto fresh
if exist "scripts\update.mjs" (
  node "scripts\update.mjs" --check
  if errorlevel 10 (
    echo A newer Keystone is ready. Restarting it to update...
    powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul
    timeout /t 2 /nobreak >nul
    goto fresh
  )
)
start "" http://127.0.0.1:4317
exit /b 0

:fresh
rem The desktop icon: Keystone (replaces the old Forefront Hub one).
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $k=Join-Path $d 'Keystone.lnk'; if (-not (Test-Path $k)) { $l=(New-Object -ComObject WScript.Shell).CreateShortcut($k); $l.TargetPath='%~dp0Start Keystone.bat'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='%~dp0assets\keystone.ico'; $l.WindowStyle=7; $l.Save() }; Remove-Item (Join-Path $d 'Forefront Hub.lnk') -ErrorAction SilentlyContinue" >nul 2>nul

:run
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 8; Start-Process 'http://127.0.0.1:4317'"
echo.
echo Starting Keystone. It checks GitHub for a newer version first (the [update] lines below).
echo When it's running it opens at http://127.0.0.1:4317 . Close this window to stop it.
echo.
rem "npm run app" updates first (scripts\update.mjs), then starts Keystone.
call npm run -s app
rem Keystone asks for a restart with exit code 75 (the Update button inside it).
if %errorlevel%==75 goto run
pause
