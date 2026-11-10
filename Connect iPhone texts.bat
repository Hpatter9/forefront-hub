@echo off
title Connect iPhone texts to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect texts
echo.
pause
