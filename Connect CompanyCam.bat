@echo off
title Connect CompanyCam to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect companycam
echo.
pause
