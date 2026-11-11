@echo off
title Connect your phone to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect phone
echo.
pause
