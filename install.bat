@echo off
chcp 65001 >nul
title dsh-mobile-remote installer
echo.
echo ============================================
echo   dsh-mobile-remote 安装器
echo   作者: AURORAL-极光实验室
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
