<#
  تحديث Mara Music من الإنترنت مباشرة — بلا فلاشة وبلا إعادة بناء.
  ينزّل ملفات البرنامج فقط (أقل من 3 ميغا) ولا يلمس:
    - الأغاني في مجلد الموسيقى
    - الإعدادات والقوائم والرموز في %APPDATA%\Mara Music
    - مجلد node_modules

  التشغيل:  تحديث-مارا.bat
#>
param(
  [string]$Branch = "claude/mara-music-remote-control-tjm7ds",
  [string]$Repo = "https://github.com/moom11/mara-pos.git"
)

$ErrorActionPreference = "Stop"

function Say($text, $color = "Gray") { Write-Host "  $text" -ForegroundColor $color }

<#
  git يكتب رسائله الطبيعية على قناة الخطأ، ومع ErrorActionPreference=Stop
  يعتبرها PowerShell أخطاء قاتلة ويوقف السكربت. نرخّي الإعداد أثناء النداء
  فقط، ونحكم على النجاح من رمز الخروج وحده.
#>
function Invoke-Git {
  param([string[]]$GitArgs, [switch]$Quiet)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($Quiet) {
      & $script:git @GitArgs 2>&1 | Out-Null
    }
    else {
      & $script:git @GitArgs 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
  }
  finally { $ErrorActionPreference = $previous }
  return $LASTEXITCODE
}

$appDir = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  ===== تحديث Mara Music من الإنترنت =====" -ForegroundColor Cyan
Write-Host ""
Say "مجلد البرنامج: $appDir"

# ------------------------------------------------------------ 1) العثور على git

$found = Get-Command git.exe -ErrorAction SilentlyContinue
$git = if ($found) { $found.Source } else { $null }
if (-not $git) {
  $candidates = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { $git = $candidate; break }
  }
}

if (-not $git) {
  Say "لم أجد git على هذا الجهاز." "Red"
  Say "ثبّته مرة واحدة بهذا الأمر، ثم أعد تشغيل هذه الأداة:" "Yellow"
  Write-Host ""
  Say "winget install --id Git.Git -e --source winget" "White"
  Write-Host ""
  exit 1
}
Say "git: $git"

# --------------------------------------- 2) إيقاف البرنامج قبل استبدال ملفاته

# إغلاق النافذة لا يوقف البرنامج (يختفي لشريط المهام عمدًا)،
# وبدون إيقافه فعليًا تبقى ملفاته مقفلة ويعيد كتابة إعداداته من ذاكرته.
$running = @(Get-Process | Where-Object { $_.ProcessName -like "*Mara*" -or $_.ProcessName -eq "electron" })
if ($running.Count -gt 0) {
  Say "إيقاف البرنامج قبل التحديث ($($running.Count) عملية)…" "Yellow"
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

# ------------------------------------------------------------ 3) جلب التحديث

$inRepo = (Invoke-Git @("-C", $appDir, "rev-parse", "--is-inside-work-tree") -Quiet) -eq 0

if ($inRepo) {
  # نسخة تطوير: نسحب فقط ولا نمسح أي تعديل محلي
  Say "هذه نسخة git — سحب آخر تحديث…" "Cyan"
  if ((Invoke-Git @("-C", $appDir, "fetch", "origin", $Branch)) -ne 0) {
    Say "تعذّر الاتصال بالمستودع — تحقّق من الإنترنت." "Red"; exit 1
  }
  Invoke-Git @("-C", $appDir, "checkout", $Branch) | Out-Null
  if ((Invoke-Git @("-C", $appDir, "pull", "origin", $Branch)) -ne 0) {
    Say "فشل السحب — قد تكون هناك تعديلات محلية غير محفوظة." "Red"; exit 1
  }
}
else {
  # نسخة مفكوكة: نحتفظ بمصدر منفصل بجانبها وننسخ منه الملفات
  $srcDir = Join-Path (Split-Path -Parent $appDir) "mara-src"

  if (Test-Path (Join-Path $srcDir ".git")) {
    Say "سحب آخر تحديث إلى: $srcDir" "Cyan"
    if ((Invoke-Git @("-C", $srcDir, "fetch", "origin", $Branch)) -ne 0) {
      Say "تعذّر الاتصال بالمستودع — تحقّق من الإنترنت." "Red"; exit 1
    }
    Invoke-Git @("-C", $srcDir, "checkout", $Branch) | Out-Null
    # هذا المجلد نسخة عمل آلية لا يحرّرها أحد، فالمسح الصلب آمن هنا
    if ((Invoke-Git @("-C", $srcDir, "reset", "--hard", "origin/$Branch")) -ne 0) {
      Say "فشل تحديث المصدر." "Red"; exit 1
    }
  }
  else {
    Say "تنزيل النسخة الأولى إلى: $srcDir" "Cyan"
    Say "قد يطلب منك تسجيل الدخول إلى GitHub مرة واحدة." "Yellow"
    if ((Invoke-Git @("clone", "--branch", $Branch, "--depth", "20", $Repo, $srcDir)) -ne 0) {
      Say "فشل التنزيل — تحقّق من الإنترنت ومن تسجيل دخول GitHub." "Red"; exit 1
    }
  }

  $newRoot = Join-Path $srcDir "mara-music"
  $newSrc = Join-Path $newRoot "src"
  if (-not (Test-Path $newSrc)) { Say "لم أجد ملفات البرنامج داخل النسخة المنزّلة." "Red"; exit 1 }

  # نسخة احتياطية واحدة من الملفات الحالية — للرجوع لو ساء شيء
  $currentSrc = Join-Path $appDir "src"
  $backup = Join-Path $appDir "_src-backup"
  if (Test-Path $currentSrc) {
    if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
    Copy-Item $currentSrc $backup -Recurse -Force
    Say "نسخة احتياطية للملفات السابقة: $backup"
    Remove-Item $currentSrc -Recurse -Force
  }
  # لو بقي المجلد لأن ملفًا مقفل، فالنسخ سيولّد src\src بدل استبداله
  if (Test-Path $currentSrc) {
    Say "تعذّر حذف مجلد src القديم — أغلق البرنامج وأعد المحاولة." "Red"; exit 1
  }

  Copy-Item $newSrc $currentSrc -Recurse -Force
  Copy-Item (Join-Path $newRoot "package.json") (Join-Path $appDir "package.json") -Force

  # الأدوات: ننسخ المحتوى لا المجلد نفسه، وإلا صار tools\tools
  $toolsDir = Join-Path $appDir "tools"
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  Copy-Item (Join-Path $newRoot "tools\*") $toolsDir -Recurse -Force

  Get-ChildItem $newRoot -Filter "*.bat" -File |
    ForEach-Object { Copy-Item $_.FullName $appDir -Force }
}

# ------------------------------------------------------------ 4) التحقّق

Write-Host ""
$missing = @()
foreach ($needed in @("package.json", "src\main\index.js", "src\web\app.js", "src\renderer\engine.js")) {
  if (-not (Test-Path (Join-Path $appDir $needed))) { $missing += $needed }
}

if ($missing.Count -gt 0) {
  Say "ناقص بعد التحديث: $($missing -join ' , ')" "Red"
  Say "استعد النسخة السابقة من مجلد _src-backup إن لزم." "Yellow"
  exit 1
}

$version = (Get-Content (Join-Path $appDir "package.json") -Raw | ConvertFrom-Json).version
Say "تم التحديث بنجاح — الإصدار $version" "Green"

if (-not (Test-Path (Join-Path $appDir "node_modules"))) {
  Write-Host ""
  Say "تنبيه: مجلد node_modules غير موجود — البرنامج لن يعمل بدونه." "Red"
  Say "شغّل في هذا المجلد:  npm install" "Yellow"
}
else {
  Write-Host ""
  Say "شغّل البرنامج الآن: تشغيل-مارا.bat أو اختصار سطح المكتب." "Yellow"
  Say "أغانيك وإعداداتك ورموزك لم تتغيّر." "Gray"
}
Write-Host ""
