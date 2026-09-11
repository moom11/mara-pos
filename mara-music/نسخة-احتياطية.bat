@echo off
chcp 65001 >nul
title Mara Music - نسخة احتياطية
rem ------------------------------------------------------------------
rem  ينسخ الأغاني وبيانات البرنامج (القوائم والإعدادات والرموز)
rem  إلى مجلد تختاره — فلاشة أو قرص آخر.
rem ------------------------------------------------------------------

echo.
echo   ===== نسخة احتياطية لـ Mara Music =====
echo.
echo   اكتب مسار المجلد الذي تريد حفظ النسخة فيه.
echo   استخدم حروفًا إنجليزية في المسار. مثال:  E:\MaraBackup
echo   أو اتركه فارغًا واضغط Enter لحفظها على سطح المكتب.
echo.

set /p DEST="   المسار: "

if "%DEST%"=="" set "DEST=%USERPROFILE%\Desktop\MaraBackup"

echo.
echo   الوجهة: %DEST%

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\transfer.ps1" -Mode backup -Path "%DEST%"

echo.
pause
