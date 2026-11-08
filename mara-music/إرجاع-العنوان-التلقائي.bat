@echo off
chcp 65001 >nul
title Mara Music - إرجاع العنوان التلقائي
rem ------------------------------------------------------------------
rem  يرجع الوحي للعنوان التلقائي من الراوتر (يلغي تثبيت العنوان).
rem  استعمله لو انتقلت لشبكة أخرى أو تعذّر الاتصال.
rem ------------------------------------------------------------------

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   طلب صلاحية المسؤول... وافق على النافذة التي ستظهر.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   ===== إرجاع العنوان التلقائي =====
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\pin-ip.ps1" -Undo

echo.
pause
