@echo off
chcp 65001 >nul
title Mara Music - Fix and Start
rem ------------------------------------------------------------------
rem  يصلح جهازًا فيه نسختان من مارا ميوزك: يحذف المثبّتة القديمة
rem  ويشغّل نسخة المصدر الجديدة، ثم يثبت أيّهما يخدم الجوال فعلًا.
rem
rem  لا يمسّ الأغاني ولا الإعدادات ولا الرموز ولا المؤثرات.
rem
rem  الاسم بالإنجليزية عمدًا: الملف يمرّ بواتساب وفكّ ضغط، والأسماء
rem  العربية تتشوّه في بعض أدوات فك الضغط.
rem ------------------------------------------------------------------

rem ---- حذف برنامج من Program Files يحتاج صلاحية مسؤول، فنرفعها بأنفسنا
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   طلب صلاحية المسؤول... وافق على النافذة التي ستظهر.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   ===== إصلاح وتشغيل مارا ميوزك =====
echo.
echo   يحذف النسخة المثبّتة القديمة ويشغّل الجديدة.
echo   أغانيك وإعداداتك ورموزك تبقى كما هي.
echo.
pause

set "PS1=%~dp0fix-tablet.ps1"

if not exist "%PS1%" (
  echo.
  echo   [ERROR] fix-tablet.ps1 not found next to this file.
  echo   فك ضغط الملفين معًا في مجلد واحد ثم أعد المحاولة.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
pause
