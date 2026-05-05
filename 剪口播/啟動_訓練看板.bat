@echo off
chcp 65001 >nul
title 訓練看板 (port 8900)
cd /d "%~dp0scripts"

echo.
echo  ================================================
echo   訓練看板 ^| http://localhost:8900
echo  ================================================
echo.

:: 等 1 秒後開瀏覽器（背景非同步）
start "" cmd /c "timeout /t 1 >nul && start http://localhost:8900"

node training_server.js
pause
