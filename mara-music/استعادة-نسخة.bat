@echo off
chcp 65001 >nul
title Mara Music - استعادة نسخة
rem ------------------------------------------------------------------
rem  يستعيد الأغاني وبيانات البرنامج من نسخة احتياطية.
rem  شغّل البرنامج مرة واحدة على هذا الجهاز ثم أغلقه قبل الاستعادة.
rem ------------------------------------------------------------------

echo.
echo   ===== استعادة بيانات Mara Music =====
echo.
echo   تنبيه: أغلق برنامج Mara Music تمامًا قبل المتابعة،
echo          وإلا كتب فوق البيانات المستعادة.
echo.
echo   اكتب مسار مجلد النسخة الاحتياطية.
echo   مثال:  E:\MaraBackup
echo.

set /p SRC="   المسار: "

if "%SRC%"=="" (
  echo.
  echo   [خطأ] لم تكتب مسارًا.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\transfer.ps1" -Mode restore -Path "%SRC%"

echo.
pause
