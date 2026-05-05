@echo off
chcp 65001 >nul
title 審核介面 (port 8899)
cd /d "%~dp0scripts"

echo.
echo  ================================================
echo   審核介面 ^| http://localhost:8899
echo  ================================================
echo.

:: 等 1 秒後開瀏覽器（背景非同步）
start "" cmd /c "timeout /t 1 >nul && start http://localhost:8899"

node review_server.js
pause
