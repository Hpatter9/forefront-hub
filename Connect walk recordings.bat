@echo off
title Connect walk recordings to Keystone
cd /d "%~dp0"
call npm run -s hub -- connect walks
echo.
pause
