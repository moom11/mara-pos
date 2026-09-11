<#
    تنظيف آمن لجهاز ويندوز — يحرّر مساحة بلا المساس بملفاتك.

    معاينة فقط (لا يحذف شيئًا):
        powershell -ExecutionPolicy Bypass -File clean-pc.ps1

    التنفيذ:
        powershell -ExecutionPolicy Bypass -File clean-pc.ps1 -Apply

    ما لا يلمسه هذا السكربت إطلاقًا:
      المستندات، سطح المكتب، الصور، الموسيقى، مجلد التنزيلات،
      البرامج المثبّتة، كلمات مرور المتصفحات وسجلّ التصفح والمفضّلة.

    ما يحذفه: ملفات مؤقتة وذاكرات تخزين مؤقت يعيد ويندوز والبرامج
    بناءها تلقائيًا عند الحاجة.
#>

param(
    [switch]$Apply,
    [switch]$SkipBrowsers,
    [switch]$DisableHibernation
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Get-FreeGB {
    $d = Get-PSDrive -Name C
    return [math]::Round($d.Free / 1GB, 2)
}

function Get-SizeMB($paths) {
    $total = 0
    foreach ($p in $paths) {
        foreach ($resolved in (Resolve-Path $p -ErrorAction SilentlyContinue)) {
            $sum = (Get-ChildItem -LiteralPath $resolved.Path -Recurse -Force -File -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum
            if ($sum) { $total += $sum }
        }
    }
    return [math]::Round($total / 1MB, 1)
}

# ------------------------------------------------------- أهداف التنظيف

$local = $env:LOCALAPPDATA

$targets = @(
    @{ Name = 'الملفات المؤقتة للمستخدم'; Paths = @("$env:TEMP"); Admin = $false }
    @{ Name = 'الملفات المؤقتة للنظام'; Paths = @('C:\Windows\Temp'); Admin = $true }
    @{ Name = 'ذاكرة تحديثات ويندوز'; Paths = @('C:\Windows\SoftwareDistribution\Download'); Admin = $true; Service = 'wuauserv' }
    @{ Name = 'تقارير أخطاء ويندوز'; Paths = @("$local\Microsoft\Windows\WER", 'C:\ProgramData\Microsoft\Windows\WER\ReportQueue'); Admin = $false }
    @{ Name = 'ملفات الانهيار'; Paths = @("$local\CrashDumps"); Admin = $false }
    @{ Name = 'ذاكرة الصور المصغّرة'; Paths = @("$local\Microsoft\Windows\Explorer"); Filter = 'thumbcache_*.db'; Admin = $false }
    @{ Name = 'ذاكرة تحسين التسليم'; Paths = @('C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache'); Admin = $true }
    @{ Name = 'ذاكرة npm'; Paths = @("$local\npm-cache\_cacache", 'D:\npm-cache\_cacache'); Admin = $false }
    @{ Name = 'ذاكرة Electron'; Paths = @("$local\electron\Cache", "$local\electron-builder\Cache", 'D:\electron-cache', 'D:\eb-cache'); Admin = $false }
    @{ Name = 'ذاكرة أدوات التطوير'; Paths = @("$local\pip\Cache", "$local\Yarn\Cache", "$local\NuGet\v3-cache"); Admin = $false }
)

$browserTargets = @(
    @{ Name = 'ذاكرة Chrome'; Paths = @("$local\Google\Chrome\User Data\*\Cache", "$local\Google\Chrome\User Data\*\Code Cache", "$local\Google\Chrome\User Data\*\GPUCache") }
    @{ Name = 'ذاكرة Edge'; Paths = @("$local\Microsoft\Edge\User Data\*\Cache", "$local\Microsoft\Edge\User Data\*\Code Cache") }
    @{ Name = 'ذاكرة Brave'; Paths = @("$local\BraveSoftware\Brave-Browser\User Data\*\Cache", "$local\BraveSoftware\Brave-Browser\User Data\*\Code Cache") }
)

if (-not $SkipBrowsers) {
    foreach ($b in $browserTargets) { $targets += @{ Name = $b.Name; Paths = $b.Paths; Admin = $false; Browser = $true } }
}

# --------------------------------------------------------------- القياس

Write-Host "`n=== تنظيف الجهاز ===" -ForegroundColor White
$freeBefore = Get-FreeGB
Write-Host "  المساحة الفاضية على C:  $freeBefore جيجا" -ForegroundColor DarkGray
if (-not $IsAdmin) {
    Write-Host "  ⚠️  بلا صلاحية مسؤول — ستُتخطّى ملفات النظام (أكبر مكسب)" -ForegroundColor Yellow
}

Write-Host "`n▶ الفحص…" -ForegroundColor Cyan
$found = @()
$totalMb = 0
foreach ($t in $targets) {
    if ($t.Admin -and -not $IsAdmin) { continue }
    $mb = Get-SizeMB $t.Paths
    if ($mb -gt 0) {
        $found += [PSCustomObject]@{ Name = $t.Name; MB = $mb; Target = $t }
        $totalMb += $mb
    }
}

if ($found.Count -eq 0) {
    Write-Host "`n  الجهاز نظيف — لا توجد ملفات مؤقتة تُذكر." -ForegroundColor Green
} else {
    foreach ($f in ($found | Sort-Object MB -Descending)) {
        Write-Host ("  {0,-32} {1,9} ميجا" -f $f.Name, $f.MB)
    }
    Write-Host ("`n  الإجمالي المتوقّع تحريره: {0} ميجا ({1} جيجا)" -f [math]::Round($totalMb, 0), [math]::Round($totalMb / 1024, 2)) -ForegroundColor Cyan
}

# سلة المحذوفات تُقاس بطريقة مختلفة
$binMb = Get-SizeMB @('C:\$Recycle.Bin')
if ($binMb -gt 1) { Write-Host ("  {0,-32} {1,9} ميجا" -f 'سلة المحذوفات', $binMb) }

if (-not $Apply) {
    Write-Host @"

⚠️  هذه معاينة فقط — لم يُحذف أي ملف.

لا يمس هذا السكربت: مستنداتك، سطح المكتب، الصور، الموسيقى، التنزيلات،
البرامج المثبّتة، ولا كلمات مرور المتصفحات أو مفضّلاتك.

للتنفيذ أضف -Apply

"@ -ForegroundColor Yellow
    exit 0
}

# -------------------------------------------------------------- التنفيذ

if (-not $SkipBrowsers) {
    $running = Get-Process -Name chrome, msedge, brave -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "`n  ⚠️  متصفح مفتوح — أغلقه ليُنظَّف كاملًا (سنتخطّى ما هو قيد الاستخدام)" -ForegroundColor Yellow
    }
}

Write-Host "`n▶ التنظيف…" -ForegroundColor Cyan
$freedMb = 0

foreach ($f in $found) {
    $t = $f.Target
    if ($t.Service) { Stop-Service $t.Service -Force -ErrorAction SilentlyContinue }
    foreach ($p in $t.Paths) {
        foreach ($resolved in (Resolve-Path $p -ErrorAction SilentlyContinue)) {
            if ($t.Filter) {
                Get-ChildItem -LiteralPath $resolved.Path -Filter $t.Filter -Force -ErrorAction SilentlyContinue |
                    Remove-Item -Force -ErrorAction SilentlyContinue
            } else {
                Get-ChildItem -LiteralPath $resolved.Path -Force -ErrorAction SilentlyContinue |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if ($t.Service) { Start-Service $t.Service -ErrorAction SilentlyContinue }
    $after = Get-SizeMB $t.Paths
    $freed = [math]::Max(0, $f.MB - $after)
    $freedMb += $freed
    Write-Host ("  ✅ {0,-32} حُرّر {1} ميجا" -f $f.Name, [math]::Round($freed, 1)) -ForegroundColor Green
}

Clear-RecycleBin -Force -ErrorAction SilentlyContinue
Write-Host '  ✅ سلة المحذوفات' -ForegroundColor Green

if ($DisableHibernation -and $IsAdmin) {
    powercfg /h off 2>$null
    Write-Host '  ✅ أُلغي الإسبات (hiberfil.sys)' -ForegroundColor Green
}

# --------------------------------------------------------------- النتيجة

Start-Sleep -Seconds 2
$freeAfter = Get-FreeGB
$gained = [math]::Round($freeAfter - $freeBefore, 2)

Write-Host "`n=== النتيجة ===" -ForegroundColor White
Write-Host "  قبل:  $freeBefore جيجا"
Write-Host "  بعد:  $freeAfter جيجا"
Write-Host "  تحرّر: $gained جيجا" -ForegroundColor Green

if ($freeAfter -lt 10) {
    Write-Host @"

⚠️  المساحة ما زالت قليلة. أكبر المكاسب المتبقية تحتاج تدخلك:

  1) نسخة ويندوز قديمة وملفات التحديثات — شغّل:  cleanmgr
     ثم اضغط "Clean up system files" وعلّم على:
       • Previous Windows installation(s)   ← قد يحرّر 20-30 جيجا
       • Windows Update Cleanup

  2) نقاط استعادة النظام — شغّل:  SystemPropertiesProtection
     اختر C: ثم Configure ثم قلّل الحد إلى 5% واضغط Delete

  3) البرامج التي لا تستخدمها — إعدادات ويندوز ← التطبيقات
     رتّبها حسب الحجم واحذف ما لا تحتاجه

  4) لمعرفة أين ذهبت المساحة بدقة، نزّل أداة WizTree المجانية

"@ -ForegroundColor Yellow
}

Write-Host ''
