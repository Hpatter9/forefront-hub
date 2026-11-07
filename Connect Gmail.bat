@echo off
title Connect Gmail to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect gmail
echo.
pause
