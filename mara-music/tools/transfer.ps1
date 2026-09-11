<#
    نسخ احتياطي واستعادة لبيانات Mara Music.

    نسخ احتياطي:  powershell -ExecutionPolicy Bypass -File transfer.ps1 -Mode backup  -Path E:\MaraBackup
    استعادة:      powershell -ExecutionPolicy Bypass -File transfer.ps1 -Mode restore -Path E:\MaraBackup

    ينقل ثلاثة أشياء: الأغاني، وبيانات البرنامج (القوائم والإعدادات والرموز)،
    ومعلومات المصدر. البرنامج نفسه يُنسخ يدويًا أو يُبنى كملف تثبيت.
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('backup', 'restore')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$MusicDir = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$DataDir = Join-Path $env:APPDATA 'Mara Music\data'
$SettingsFile = Join-Path $DataDir 'settings.json'

function Write-Step($text) { Write-Host "`n▶ $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  ✅ $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  ⚠️  $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "`n❌ $text" -ForegroundColor Red; exit 1 }

function Read-JsonFile($file) {
    $raw = Get-Content $file -Raw -Encoding UTF8
    if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
    return $raw | ConvertFrom-Json
}

function Write-JsonFile($file, $object) {
    $json = $object | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Copy-Tree($from, $to, $label) {
    if (-not (Test-Path $from)) {
        Write-Warn "لا يوجد: $from — تخطّي $label"
        return 0
    }
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    # /E كل المجلدات الفرعية، /COPY:DAT يحافظ على تواريخ الملفات
    robocopy $from $to /E /COPY:DAT /R:2 /W:2 /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "فشل نسخ $label (رمز robocopy: $LASTEXITCODE)" }
    $count = (Get-ChildItem $to -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Ok "$label — $count ملف"
    return $count
}

function Test-AppRunning {
    $procs = Get-Process -Name 'electron', 'Mara Music' -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Warn 'البرنامج يعمل الآن. أغلقه أولًا وإلا كتب فوق ما تستعيده.'
        $answer = Read-Host '  متابعة رغم ذلك؟ (y/n)'
        if ($answer -ne 'y') { exit 0 }
    }
}

# ================================================================ نسخ احتياطي

if ($Mode -eq 'backup') {
    Write-Host "`n=== نسخة احتياطية لـ Mara Music ===" -ForegroundColor White

    if (-not (Test-Path $SettingsFile)) {
        Fail "لم يُعثر على إعدادات البرنامج في:`n$SettingsFile`nشغّل البرنامج مرة واحدة أولًا."
    }

    $settings = Read-JsonFile $SettingsFile
    $music = if ($MusicDir) { $MusicDir } else { $settings.musicDir }
    Write-Host "  مجلد الموسيقى: $music" -ForegroundColor DarkGray

    Write-Step 'نسخ بيانات البرنامج (القوائم والإعدادات والرموز)'
    Copy-Tree $DataDir (Join-Path $Path 'data') 'بيانات البرنامج' | Out-Null

    Write-Step 'نسخ الأغاني'
    $songs = Copy-Tree $music (Join-Path $Path 'MaraMusic') 'الأغاني'

    $manifest = [ordered]@{
        createdAt     = (Get-Date).ToString('s')
        sourceMachine = $env:COMPUTERNAME
        sourceUser    = $env:USERNAME
        musicDir      = $music
        songFiles     = $songs
    }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    Write-JsonFile (Join-Path $Path 'mara-backup.json') $manifest

    Write-Host "`n✅ اكتملت النسخة الاحتياطية في: $Path" -ForegroundColor Green
    Write-Host @"

الخطوة التالية على الجهاز الآخر:
  1) ثبّت أو انسخ البرنامج، وشغّله مرة واحدة ثم أغلقه تمامًا
     (حتى ينشئ مجلد بياناته)
  2) شغّل هذا السكربت هناك بوضع الاستعادة:
     powershell -ExecutionPolicy Bypass -File transfer.ps1 -Mode restore -Path <مسار النسخة>

"@ -ForegroundColor DarkGray
    exit 0
}

# =================================================================== استعادة

Write-Host "`n=== استعادة بيانات Mara Music ===" -ForegroundColor White

$manifestFile = Join-Path $Path 'mara-backup.json'
if (-not (Test-Path $manifestFile)) {
    Fail "هذا ليس مجلد نسخة احتياطية صالحًا — لا يوجد mara-backup.json في:`n$Path"
}
$manifest = Read-JsonFile $manifestFile
Write-Host "  نسخة من جهاز: $($manifest.sourceMachine)  بتاريخ: $($manifest.createdAt)" -ForegroundColor DarkGray

Test-AppRunning

# أين نضع الأغاني على هذا الجهاز؟
$targetMusic = if ($MusicDir) { $MusicDir } else { $manifest.musicDir }
$targetRoot = ''
try { $targetRoot = Split-Path $targetMusic -Qualifier } catch { $targetRoot = '' }
if (-not $targetRoot -or -not (Test-Path ($targetRoot + '\'))) {
    Write-Warn "القرص ($targetRoot) الذي كانت عليه الأغاني غير موجود على هذا الجهاز."
    $targetMusic = Read-Host '  اكتب مسار مجلد الموسيقى على هذا الجهاز (مثال: D:\MaraMusic)'
    if (-not $targetMusic) { Fail 'لم تُحدَّد وجهة للأغاني.' }
}

Write-Step 'استعادة الأغاني'
Copy-Tree (Join-Path $Path 'MaraMusic') $targetMusic 'الأغاني' | Out-Null

Write-Step 'استعادة بيانات البرنامج'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Copy-Tree (Join-Path $Path 'data') $DataDir 'بيانات البرنامج' | Out-Null

# تصحيح مسار الموسيقى داخل الإعدادات المستعادة
if (Test-Path $SettingsFile) {
    $settings = Read-JsonFile $SettingsFile
    if ($settings.musicDir -ne $targetMusic) {
        Write-Step 'تصحيح مسار مجلد الموسيقى في الإعدادات'
        $settings.musicDir = $targetMusic
        Write-JsonFile $SettingsFile $settings
        Write-Ok "صار: $targetMusic"
    }
}

# فهرس المكتبة يحمل مسارات الجهاز القديم — نحذفه ليُعاد بناؤه عند أول تشغيل
$libraryFile = Join-Path $DataDir 'library.json'
if (Test-Path $libraryFile) {
    Remove-Item $libraryFile -Force
    Write-Ok 'حُذف فهرس المكتبة القديم — سيُعاد بناؤه تلقائيًا عند أول تشغيل'
}

Write-Host @"

✅ اكتملت الاستعادة.

شغّل البرنامج الآن. سيفحص مجلد الموسيقى ويعيد بناء المكتبة خلال ثوانٍ،
وستجد قوائمك وإعداداتك ورمز المدير كما كانت على الجهاز السابق.

"@ -ForegroundColor Green
