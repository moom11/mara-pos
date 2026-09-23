<#
  تنظيف جهاز فيه نسختان من مارا ميوزك ثم تشغيل الصحيحة.

  النسخة المثبّتة القديمة ونسخة المصدر الجديدة تتنازعان على المنفذ 8787،
  فلا يعمل صوت أي منهما وقد يتحكّم الجوال بغير التي تظن. هذا الملف يحذف
  القديمة ويشغّل الجديدة ويثبت أيّهما يملك المنفذ فعلًا.

  لا يمسّ: الأغاني، الإعدادات، القوائم، الرموز، المؤثرات.

  المخرجات بالإنجليزية عمدًا: نافذة PowerShell على الوحي لا تعرض العربية.
#>
param(
  [string]$AppDir = 'C:\MaraApp\mara-src\mara-music'
)

$ErrorActionPreference = 'Stop'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn($text) { Write-Host "    !   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "`n  FAILED: $text" -ForegroundColor Red }

Write-Host ''
Write-Host '  ===== Mara Music - Fix and Start =====' -ForegroundColor Yellow
Write-Host '  Removes the old installed copy, starts the new one.'
Write-Host '  Your songs, settings and PINs are untouched.'
Write-Host ''

try {
  # ------------------------------------------------- 1) إيقاف كل النسخ
  Step 1 'Stopping every running copy'
  $running = @(Get-Process | Where-Object { $_.ProcessName -like '*Mara*' -or $_.ProcessName -eq 'electron' })
  if ($running.Count) {
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Ok "stopped $($running.Count)"
  } else {
    Ok 'none were running'
  }

  # ------------------------------------------ 2) حذف النسخة المثبّتة القديمة
  Step 2 'Removing the old installed copy'
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*Mara Music*' } | Select-Object -First 1

  if (-not $entry) {
    Ok 'nothing to remove'
  } else {
    Info "found: $($entry.DisplayName) $($entry.DisplayVersion)"
    $uninstaller = ''
    if ($entry.UninstallString) { $uninstaller = ($entry.UninstallString -replace '"', '').Trim() }

    if (-not (Test-Path $uninstaller)) {
      Warn 'uninstaller not found - remove it from Windows Settings > Apps'
    } else {
      # /S صامت. بيانات التطبيق تبقى: مثبّتنا لا يفعّل حذفها.
      Start-Process $uninstaller -ArgumentList '/S' -ErrorAction SilentlyContinue
      $installedExe = Join-Path (Split-Path $uninstaller -Parent) 'Mara Music.exe'
      for ($i = 0; $i -lt 40 -and (Test-Path $installedExe); $i += 1) { Start-Sleep -Seconds 2 }
      if (Test-Path $installedExe) {
        Warn 'still there - finish it from Windows Settings > Apps, then run this again'
      } else {
        Ok 'old copy removed'
      }
    }
  }
  # مدخل تشغيله التلقائي قد يبقى بعد الحذف فيعيد إحياء التنازع
  Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Mara Music' -ErrorAction SilentlyContinue

  # --------------------------------------------- 3) فحص اكتمال النسخة الجديدة
  Step 3 'Checking the new copy'
  $missing = @()
  foreach ($needed in @('package.json', 'src\main\index.js', 'node_modules\electron\dist\electron.exe')) {
    if (-not (Test-Path (Join-Path $AppDir $needed))) { $missing += $needed }
  }
  if ($missing.Count) {
    Fail "the new copy is incomplete: $($missing -join ' , ')"
    Info 'Run Setup-Mara-Tablet.bat again - it resumes where it stopped.'
    exit 1
  }
  $version = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
  Ok "version $version"

  # ------------------------------------------------- 4) تطبيق حقيقي لا ملف bat
  Step 4 'Making it a proper desktop app'
  <#
    نسخة باسم البرنامج بجانب electron.exe: ويندوز يسمّي التطبيق في شريط
    المهام ومدير المهام باسم الملف التنفيذي، فتظهر "Mara Music" لا
    "electron". والاختصار يشير إليها مباشرة فلا تظهر نافذة سوداء كما
    يحدث مع ملف bat.
  #>
  $distDir = Join-Path $AppDir 'node_modules\electron\dist'
  $appExe = Join-Path $distDir 'Mara Music.exe'
  $srcExe = Join-Path $distDir 'electron.exe'
  if (-not (Test-Path $appExe) -or (Get-Item $srcExe).LastWriteTime -gt (Get-Item $appExe).LastWriteTime) {
    Copy-Item $srcExe $appExe -Force
  }

  $icon = Join-Path $AppDir 'src\assets\icon.ico'
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mara Music.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Mara Music.lnk')
  )
  foreach ($linkPath in $targets) {
    New-Item -ItemType Directory -Force -Path (Split-Path $linkPath -Parent) | Out-Null
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $appExe
    $link.Arguments = "`"$AppDir`""
    $link.WorkingDirectory = $AppDir
    if (Test-Path $icon) { $link.IconLocation = $icon }
    $link.Description = 'Mara Music'
    $link.Save()
  }
  Ok 'desktop and start menu shortcuts created'

  # -------------------------------------------------------------- 5) التشغيل
  Step 5 'Starting Mara Music'
  Start-Process $appExe -ArgumentList "`"$AppDir`"" -WorkingDirectory $AppDir
  Info 'waiting for it to come up...'
  $owner = $null
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Seconds 2
    $conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { $owner = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).Path; break }
  }

  # --------------------------------------------------------------- 5) النتيجة
  Write-Host ''
  if ($owner) {
    Write-Host '  ===== RUNNING =====' -ForegroundColor Green
    Write-Host "  Version  : $version"
    Write-Host "  Serving  : $owner"
    # المسار الذي يخدم المنفذ هو الدليل القاطع على أي نسخة يتحكّم بها الجوال
    if ($owner.ToLower().StartsWith($AppDir.ToLower())) {
      Write-Host '  Copy     : NEW (correct)' -ForegroundColor Green
    } else {
      Write-Host '  Copy     : OLD - remove it from Windows Settings, then run this again' -ForegroundColor Yellow
    }
  } else {
    Write-Host '  ===== NOT RESPONDING =====' -ForegroundColor Red
    Write-Host '  The program did not open port 8787.'
  }
  Write-Host "  Songs    : $((Get-ChildItem 'C:\MaraMusic\*' -Include *.mp3,*.m4a,*.flac,*.wav,*.aac,*.ogg -Recurse -File -ErrorAction SilentlyContinue).Count)"
  Write-Host "  Settings : $(Test-Path "$env:APPDATA\Mara Music\data\settings.json")"

  Write-Host ''
  Write-Host '  Next:' -ForegroundColor Yellow
  Write-Host '   1. From your phone open the control page and enter your PIN'
  Write-Host '   2. Play a song'
  Write-Host ''
  Write-Host '  Still no sound? Windows keeps a separate volume per app:' -ForegroundColor Yellow
  Write-Host '   Right-click the speaker icon > Volume mixer >'
  Write-Host '   find "Mara Music" or "electron" - unmute it, raise it,'
  Write-Host '   and set its output to the same device YouTube uses.'
  Write-Host ''
} catch {
  Fail $_.Exception.Message
  Write-Host ''
  exit 1
}
