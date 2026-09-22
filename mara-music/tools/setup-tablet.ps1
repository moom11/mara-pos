<#
  تثبيت مارا ميوزك على جهاز جديد عبر الإنترنت — بلا فلاشة وبلا ملف تثبيت.

  يجلب كل شيء بنفسه:
    1. Node محمول (لا يُثبَّت في النظام، مجلد واحد يمكن حذفه)
    2. ملفات البرنامج من المستودع
    3. محرّك التشغيل ومكتباته

  لا يمسّ: الأغاني، الإعدادات، القوائم، الرموز — كلها خارج مجلد البرنامج.

  المخرجات بالإنجليزية عمدًا: نافذة PowerShell على بعض الأجهزة لا تعرض
  العربية فتظهر رموزًا، والأرقام و PASS/FAIL يجب أن تبقى مقروءة.
#>
param(
  [string]$Root = 'C:\MaraApp',
  [string]$Branch = 'claude/mara-music-remote-control-tjm7ds',
  [string]$Repo = 'https://github.com/moom11/mara-pos.git'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # يسرّع التنزيل كثيرًا في PowerShell 5

<#
  git و npm يكتبان رسائلهما الطبيعية على قناة الخطأ ("Cloning into…"،
  تحذيرات npm). مع ErrorActionPreference=Stop يحوّلها PowerShell إلى
  أخطاء قاتلة فيتوقف التثبيت رغم نجاح الأمر. نرخّي الإعداد أثناء النداء
  فقط، ونحكم على النجاح من رمز الخروج وحده.
#>
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments, [switch]$Show)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Exe @Arguments 2>&1
    if ($Show) { $output | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
  } finally {
    $ErrorActionPreference = $previous
  }
  return $LASTEXITCODE
}

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Fail($text) { Write-Host "`n  FAILED: $text" -ForegroundColor Red }

$srcDir = Join-Path $Root 'mara-src'
$appDir = Join-Path $srcDir 'mara-music'
$nodeDir = Join-Path $Root 'node'

Write-Host ''
Write-Host '  ===== Mara Music - Setup =====' -ForegroundColor Yellow
Write-Host "  Target: $Root"
Write-Host '  Needs: internet + about 700 MB free'
Write-Host ''

try {
  # ------------------------------------------------ 1) إيقاف ما يعمل الآن
  Step 1 'Stopping any running Mara Music'
  $running = @(Get-Process | Where-Object { $_.ProcessName -like '*Mara*' -or $_.ProcessName -eq 'electron' })
  if ($running.Count) {
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Ok "stopped $($running.Count) process(es)"
  } else {
    Ok 'nothing was running'
  }

  New-Item -ItemType Directory -Force -Path $Root | Out-Null

  # ------------------------------------------------------------ 2) git
  Step 2 'Checking git'
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if (-not $git) {
    foreach ($c in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")) {
      if (Test-Path $c) { $git = $c; break }
    }
  }
  if (-not $git) {
    Fail 'git is not installed.'
    Info 'Install it once, then run this again:'
    Info '    winget install --id Git.Git -e --source winget'
    exit 1
  }
  Ok $git

  # ------------------------------------------------------------ 3) Node
  Step 3 'Checking Node.js'
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node -and (Test-Path (Join-Path $nodeDir 'node.exe'))) { $node = Join-Path $nodeDir 'node.exe' }

  if ($node) {
    Ok "$node"
  } else {
    Info 'not found - downloading a portable copy (no system install)'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
    if (-not $lts) { Fail 'could not find a Node download'; exit 1 }

    $zipUrl = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-win-x64.zip"
    $tmpZip = Join-Path $env:TEMP "node-$($lts.version).zip"
    Info "downloading $($lts.version) (about 30 MB)"
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing

    $tmpOut = Join-Path $env:TEMP 'node-extract'
    Remove-Item $tmpOut -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $tmpZip -DestinationPath $tmpOut -Force
    $inner = Get-ChildItem $tmpOut -Directory | Select-Object -First 1
    Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $inner.FullName $nodeDir
    Remove-Item $tmpZip, $tmpOut -Recurse -Force -ErrorAction SilentlyContinue

    $node = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $node)) { Fail 'Node extraction failed'; exit 1 }

    # يبقى متاحًا بعد إغلاق النافذة، فلا يحتاج المستخدم إعادة هذه الخطوة
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$nodeDir*") {
      [Environment]::SetEnvironmentVariable('Path', "$userPath;$nodeDir", 'User')
    }
    Ok "$nodeDir"
  }
  $env:Path = "$env:Path;$nodeDir"
  $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'

  # ------------------------------------------------------- 4) ملفات البرنامج
  Step 4 'Getting program files'
  if (Test-Path (Join-Path $srcDir '.git')) {
    Info 'updating existing copy'
    if ((Invoke-Native $git @('-C', $srcDir, 'fetch', 'origin', $Branch)) -ne 0) {
      Fail 'could not reach the repository - check the internet'; exit 1
    }
    Invoke-Native $git @('-C', $srcDir, 'checkout', $Branch) | Out-Null
    if ((Invoke-Native $git @('-C', $srcDir, 'reset', '--hard', "origin/$Branch")) -ne 0) {
      Fail 'could not update the program files'; exit 1
    }
  } else {
    # بقايا محاولة سابقة: git يرفض الاستنساخ في مجلد غير فارغ
    if (Test-Path $srcDir) {
      Info 'removing an incomplete previous download'
      Remove-Item $srcDir -Recurse -Force
    }
    Info 'first download - a GitHub sign-in may open once'
    if ((Invoke-Native $git @('clone', '--branch', $Branch, '--depth', '20', $Repo, $srcDir)) -ne 0) {
      Fail 'download failed - check internet and GitHub sign-in'; exit 1
    }
  }
  if (-not (Test-Path (Join-Path $appDir 'package.json'))) { Fail 'program files are missing'; exit 1 }
  $version = (Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json).version
  Ok "version $version"

  # ---------------------------------------------------------- 5) المكتبات
  Step 5 'Installing the audio engine (about 400 MB, takes a few minutes)'
  Push-Location $appDir
  try {
    # npm يكتب تحذيراته على قناة الخطأ أيضًا — نفس الفخ
    Invoke-Native $npm @('install', '--no-audit', '--no-fund') -Show | Out-Null
  } finally {
    Pop-Location
  }
  $electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) { Fail 'the audio engine did not install - run this again'; exit 1 }
  Ok 'engine ready'

  # ----------------------------------------------------------- 6) الاختصار
  Step 6 'Creating the desktop shortcut'
  # نسخة النظام القديمة تتنازع على المنفذ نفسه — نمنع تشغيلها التلقائي
  Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Mara Music' -ErrorAction SilentlyContinue

  $launcher = Join-Path $appDir 'تشغيل-مارا.bat'
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mara Music.lnk'))
  $link.TargetPath = $launcher
  $link.WorkingDirectory = $appDir
  $icon = Join-Path $appDir 'src\assets\icon.ico'
  if (Test-Path $icon) { $link.IconLocation = $icon }
  $link.Description = 'Mara Music'
  $link.Save()
  Ok 'shortcut created on the Desktop'

  # ------------------------------------------------------------- النتيجة
  Write-Host ''
  Write-Host '  ===== DONE =====' -ForegroundColor Green
  Write-Host "  Version   : $version"
  Write-Host "  Folder    : $appDir"
  Write-Host "  Songs     : $((Get-ChildItem 'C:\MaraMusic\*' -Include *.mp3,*.m4a,*.flac,*.wav,*.aac,*.ogg -Recurse -File -ErrorAction SilentlyContinue).Count)"
  Write-Host "  Settings  : $(Test-Path "$env:APPDATA\Mara Music\data\settings.json")"
  Write-Host ''
  Write-Host '  Next:' -ForegroundColor Yellow
  Write-Host '   1. Double-click "Mara Music" on the Desktop'
  Write-Host '   2. From your phone, open the app and enter your admin PIN'
  Write-Host '   3. Uninstall the OLD "Mara Music" from Windows Settings > Apps'
  Write-Host '      (two copies fight over the same port)'
  Write-Host ''
  Write-Host '  From now on, updates are one double-click:' -ForegroundColor Yellow
  Write-Host "     $appDir\تحديث-مارا.bat"
  Write-Host ''
} catch {
  Fail $_.Exception.Message
  Write-Host ''
  exit 1
}
