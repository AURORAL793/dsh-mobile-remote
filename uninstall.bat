@echo off
chcp 65001 >nul
title dsh-mobile-remote uninstaller
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*
echo.
pause
