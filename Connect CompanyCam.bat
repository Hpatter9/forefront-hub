@echo off
title Connect CompanyCam to Forefront Hub
cd /d "%~dp0"
call npm run -s hub -- connect companycam
echo.
pause
