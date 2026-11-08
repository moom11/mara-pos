@echo off
chcp 65001 >nul
title Mara Music - تثبيت عنوان الوحي
rem ------------------------------------------------------------------
rem  يثبّت عنوان الوحي على الشبكة فلا يتغيّر بعدها.
rem  إن توقّفت الشبكة يرجع وحده للوضع التلقائي، فلا خطر.
rem
rem  لا يمس الأغاني ولا الإعدادات ولا الرموز.
rem ------------------------------------------------------------------

rem ---- تغيير إعدادات الشبكة يحتاج صلاحية مسؤول، فنرفعها بأنفسنا
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   طلب صلاحية المسؤول... وافق على النافذة التي ستظهر.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   ===== تثبيت عنوان الوحي =====
echo.
echo   بعد هذا لن يتغيّر العنوان الذي تفتحه من جوالك.
echo   إن تعذّر ذلك على شبكتك سيرجع كل شيء كما كان تلقائيًا.
echo.
pause

set "PS1=%~dp0tools\pin-ip.ps1"

if not exist "%PS1%" (
  echo.
  echo   [ERROR] pin-ip.ps1 not found in the tools folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
pause
