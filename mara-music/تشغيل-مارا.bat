@echo off
chcp 65001 >nul
title Mara Music
rem ------------------------------------------------------------------
rem  تشغيل مارا ميوزك من المجلد مباشرة، بدون تثبيت Node.js على الجهاز.
rem  Electron يحمل بداخله كل ما يحتاجه.
rem ------------------------------------------------------------------

cd /d "%~dp0"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo [خطأ] لم يُعثر على ملف التشغيل:
  echo %ELECTRON%
  echo.
  echo تأكد من نسخ مجلد node_modules كاملًا مع المشروع.
  echo.
  pause
  exit /b 1
)

start "" "%ELECTRON%" "%~dp0"
exit /b 0
