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
echo   مثال:  E:\MaraBackup
echo.

set /p DEST="   المسار: "

if "%DEST%"=="" (
  echo.
  echo   [خطأ] لم تكتب مسارًا.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\transfer.ps1" -Mode backup -Path "%DEST%"

echo.
pause
