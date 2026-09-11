@echo off
chcp 65001 >nul
title Mara - اختصارات سطح المكتب

echo.
echo   ===== اختصارات سطح المكتب =====
echo.
echo   سيُنشأ على سطح مكتبك:
echo     - مارا ميوزك
echo     - تنظيف الجهاز
echo     - ترتيب الوثائق
echo     - نسخة احتياطية لمارا
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-shortcuts.ps1"

echo.
pause
