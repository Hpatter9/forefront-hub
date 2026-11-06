@echo off
title Connect Google Maps to Forefront Hub
cd /d "%~dp0"
call npm run -s hub -- connect maps
echo.
pause
