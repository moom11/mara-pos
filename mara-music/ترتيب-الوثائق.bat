@echo off
chcp 65001 >nul
title Mara - ترتيب الوثائق
rem ------------------------------------------------------------------
rem  يرتّب وثائق العمل من مجلد التنزيلات إلى مجلدات منظّمة.
rem  يعرض الخطة أولًا، ولا ينقل شيئًا إلا بعد موافقتك.
rem ------------------------------------------------------------------

echo.
echo   ===== ترتيب وثائق مارا =====
echo.
echo   سيقرأ مجلد التنزيلات ويعرض خطة الترتيب.
echo   لن يتحرك أي ملف قبل أن توافق.
echo.
echo   وجهة الوثائق (اتركه فارغًا للوجهة الافتراضية D:\مارا-وثائق)
echo.

set /p DEST="   الوجهة: "

if "%DEST%"=="" set "DEST=D:\مارا-وثائق"

echo.
echo   ---------- المعاينة ----------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\organize-docs.ps1" -Destination "%DEST%"

echo.
echo   ---------- التنفيذ ----------
echo.
echo   إن أعجبتك الخطة أعلاه، اكتب  نعم  للتنفيذ الفعلي.
echo   أي شيء آخر يلغي العملية.
echo.

set /p GO="   تنفيذ؟ "

if /i not "%GO%"=="نعم" (
  echo.
  echo   أُلغيت العملية. لم يتحرك شيء.
  echo.
  pause
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\organize-docs.ps1" -Destination "%DEST%" -Apply

echo.
pause
