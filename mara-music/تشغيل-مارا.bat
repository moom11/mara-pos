@echo off
chcp 65001 >nul
title Mara Music
rem ------------------------------------------------------------------
rem  تشغيل مارا ميوزك من المجلد مباشرة، بدون تثبيت Node.js على الجهاز.
rem  Electron يحمل بداخله كل ما يحتاجه.
rem ------------------------------------------------------------------

cd /d "%~dp0"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

rem ---- فحص اكتمال النسخة قبل التشغيل، لتظهر رسالة مفهومة بدل خطأ Electron

if not exist "%~dp0package.json" (
  echo.
  echo   [نسخة ناقصة] لم يُعثر على الملف package.json في:
  echo   %~dp0
  echo.
  if exist "%~dp0mara-music\package.json" (
    echo   يبدو أن المجلد مزدوج: يوجد mara-music داخل mara-music
    echo   الحل: انقل محتويات المجلد الداخلي إلى هنا، أو شغّل الملف من:
    echo   %~dp0mara-music
  ) else (
    echo   النسخ لم يكتمل. أعد نسخ مجلد mara-music كاملًا من الجهاز الأصلي.
  )
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0src\main\index.js" (
  echo.
  echo   [نسخة ناقصة] مجلد src مفقود أو غير مكتمل.
  echo   أعد نسخ مجلد mara-music كاملًا من الجهاز الأصلي.
  echo.
  pause
  exit /b 1
)

if not exist "%ELECTRON%" (
  echo.
  echo   [نسخة ناقصة] لم يُعثر على محرّك التشغيل:
  echo   %ELECTRON%
  echo.
  echo   تأكد من نسخ مجلد node_modules كاملًا مع المشروع.
  echo   حجمه حوالي 400 ميجا ويحتوي آلاف الملفات، فقد يكون النسخ توقف في منتصفه.
  echo.
  pause
  exit /b 1
)

start "" "%ELECTRON%" "%~dp0"
exit /b 0
