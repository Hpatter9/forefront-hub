@echo off
title Move Keystone data to Google Drive
cd /d "%~dp0"
call npm run -s hub -- move-to-drive
echo.
pause
