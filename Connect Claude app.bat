@echo off
title Connect the Claude app to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect claude-app
echo.
pause
