@echo off
title Connect Gemini to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect gemini
echo.
pause
