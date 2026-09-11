@echo off
chcp 65001 >nul
title Mara - تنظيف الجهاز

rem  يحتاج صلاحية مسؤول ليصل لملفات النظام (أكبر مكسب في المساحة)
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo.
  echo   يحتاج صلاحية مسؤول... سيُطلب منك التأكيد.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

echo.
echo   ===== تنظيف جهاز ويندوز =====
echo.
echo   يحذف: الملفات المؤقتة، ذاكرة التحديثات، ذاكرة المتصفحات،
echo          تقارير الأخطاء، سلة المحذوفات.
echo.
echo   لا يمس: مستنداتك، سطح المكتب، الصور، الموسيقى، التنزيلات،
echo           البرامج المثبتة، كلمات مرور المتصفحات ومفضلاتك.
echo.
echo   ---------- المعاينة ----------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\clean-pc.ps1"

echo.
echo   ---------- التنفيذ ----------
echo.
echo   اكتب  نعم  للتنظيف الفعلي. أي شيء آخر يلغي العملية.
echo.

set /p GO="   تنظيف؟ "

if /i not "%GO%"=="نعم" (
  echo.
  echo   أُلغيت العملية. لم يُحذف شيء.
  echo.
  pause
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\clean-pc.ps1" -Apply

echo.
pause
