@echo off
chcp 65001 >nul
title Mara Music - Setup
rem ------------------------------------------------------------------
rem  مثبّت مارا ميوزك على جهاز جديد عبر الإنترنت.
rem  يجلب كل شيء بنفسه: Node محمول، وملفات البرنامج، ومحرّك الصوت.
rem  لا يمسّ الأغاني ولا الإعدادات ولا الرموز.
rem
rem  الاسم بالإنجليزية عمدًا: هذا الملف يُرسل عبر واتساب ويُفكّ من ضغط،
rem  والأسماء العربية قد تتشوّه في بعض أدوات فك الضغط.
rem ------------------------------------------------------------------

echo.
echo   ===== Mara Music - Setup =====
echo.
echo   سيجلب البرنامج ومحرّك الصوت من الإنترنت (حوالي 400 ميجا).
echo   أغانيك وإعداداتك ورموزك لن تتغيّر.
echo.
echo   يحتاج: اتصال إنترنت + git مثبّت.
echo.
pause

set "PS1=%~dp0setup-tablet.ps1"

if not exist "%PS1%" (
  echo.
  echo   [ERROR] setup-tablet.ps1 not found next to this file.
  echo   فك ضغط الملفين معًا في مجلد واحد ثم أعد المحاولة.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
pause
