<#
    ترتيب وثائق العمل من مجلد التنزيلات إلى مجلد منظّم.

    معاينة فقط (لا يحرّك شيئًا):
        powershell -ExecutionPolicy Bypass -File organize-docs.ps1

    التنفيذ الفعلي:
        powershell -ExecutionPolicy Bypass -File organize-docs.ps1 -Apply

    مع تحديد المجلدات:
        ... -Source "C:\Users\me\Downloads" -Destination "D:\مارا-وثائق" -Apply

    لا يحذف شيئًا أبدًا: ينقل فقط، ويعيد تسمية الملف إن وُجد اسم مكرّر.
#>

param(
    [string]$Source = "$env:USERPROFILE\Downloads",
    [string]$Destination = 'D:\مارا-وثائق',
    [switch]$Apply,
    [switch]$Copy
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ترتيب القواعد مهم: أول قاعدة تنطبق هي التي تفوز.
# كل قاعدة: اسم المجلد، كلمات في اسم الملف، امتدادات.
$Rules = @(
    @{ Folder = 'الرواتب والموظفين'
       Words  = 'رواتب', 'راتب', 'مخالصة', 'مستحقات', 'payroll', 'salary', 'employee', 'موظف', 'حضور', 'مناوبة', 'اجازات', 'سيرة', 'سيرة ذاتية', 'cv', 'resume', 'توظيف'
       Ext    = @() }

    @{ Folder = 'الهويات والوثائق الرسمية'
       Words  = 'هوية', 'جواز', 'passport', 'اقامة', 'إقامة', 'مقيم', 'تأشيرة', 'تاشيرة', 'سجل تجاري', 'شهادة', 'رخصة', 'ترخيص', 'iban', 'الآيبان', 'صك', 'تفويض', 'وكالة'
       Ext    = @() }

    @{ Folder = 'العقود والكراسات'
       Words  = 'عقد', 'عقود', 'contract', 'اتفاقية', 'كراسة', 'الشروط', 'مناقصة', 'عطاء', 'nda', 'خطاب', 'محضر', 'تعهد'
       Ext    = @() }

    @{ Folder = 'الفواتير'
       Words  = 'فاتورة', 'فواتير', 'invoice', 'inv_', 'receipt', 'إيصال', 'ايصال', 'سند'
       Ext    = @() }

    @{ Folder = 'المبيعات والتقارير'
       Words  = 'مبيعات', 'تقرير', 'تقارير', 'كشف', 'كشوف', 'report', 'sales', 'statement', 'payins', 'payouts', 'receipts-', 'export', 'hala', 'الدخل', 'الميزانية', 'موازنة', 'قيود', 'محاسب', 'ضريبة', 'vat', 'شجرة_حسابات', 'مشتريات', 'جرد', 'مخزن'
       Ext    = @() }

    @{ Folder = 'المخططات والتصاميم'
       Words  = 'مخطط', 'كروكي', 'تصميم', 'واجهات', 'مساقط', 'لوقو', 'شعار'
       Ext    = '.dwg', '.dxf', '.svg' }

    @{ Folder = 'جداول واكسل'
       Words  = @()
       Ext    = '.xlsx', '.xls', '.xlsm', '.csv', '.ods' }

    @{ Folder = 'مستندات'
       Words  = @()
       Ext    = '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.txt', '.rtf' }

    @{ Folder = 'صور'
       Words  = @()
       Ext    = '.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.bmp' }

    @{ Folder = 'فيديو وصوت'
       Words  = @()
       Ext    = '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.m4a', '.wav' }

    @{ Folder = 'أرشيف مضغوط'
       Words  = @()
       Ext    = '.zip', '.rar', '.7z', '.gz', '.tar' }

    @{ Folder = 'برامج التثبيت'
       Words  = @()
       Ext    = '.exe', '.msi', '.appx', '.apk' }
)

$SkipFolder = 'ملفات أخرى'

function Get-Category($file) {
    $name = $file.Name.ToLower()
    $ext = $file.Extension.ToLower()
    foreach ($rule in $Rules) {
        foreach ($word in $rule.Words) {
            if ($name -like "*$($word.ToLower())*") { return $rule.Folder }
        }
        if ($rule.Ext -contains $ext) { return $rule.Folder }
    }
    return $SkipFolder
}

function Get-FreeName($dir, $name) {
    $candidate = Join-Path $dir $name
    if (-not (Test-Path $candidate)) { return $candidate }
    $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $ext = [System.IO.Path]::GetExtension($name)
    for ($i = 2; $i -lt 500; $i++) {
        $candidate = Join-Path $dir "$base ($i)$ext"
        if (-not (Test-Path $candidate)) { return $candidate }
    }
    return Join-Path $dir "$base-$(Get-Random)$ext"
}

# ------------------------------------------------------------------ الفحص

if (-not (Test-Path $Source)) {
    Write-Host "`n❌ المجلد المصدر غير موجود: $Source" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== ترتيب وثائق مارا ===" -ForegroundColor White
Write-Host "  من:  $Source" -ForegroundColor DarkGray
Write-Host "  إلى: $Destination" -ForegroundColor DarkGray

$files = Get-ChildItem -LiteralPath $Source -File
if ($files.Count -eq 0) {
    Write-Host "`n  لا توجد ملفات في المجلد المصدر." -ForegroundColor Yellow
    exit 0
}

$plan = foreach ($f in $files) {
    [PSCustomObject]@{
        File     = $f
        Category = Get-Category $f
    }
}

$groups = $plan | Group-Object Category | Sort-Object Count -Descending

Write-Host "`n▶ الخطة — $($files.Count) ملف" -ForegroundColor Cyan
foreach ($g in $groups) {
    $mb = [math]::Round((($g.Group | ForEach-Object { $_.File.Length }) | Measure-Object -Sum).Sum / 1MB, 1)
    Write-Host ("  {0,-28} {1,5} ملف   {2,8} ميجا" -f $g.Name, $g.Count, $mb)
}

$totalMb = [math]::Round((($files | ForEach-Object { $_.Length }) | Measure-Object -Sum).Sum / 1MB, 1)
Write-Host "`n  المجموع: $totalMb ميجا" -ForegroundColor DarkGray

$action = if ($Copy) { 'نسخ' } else { 'نقل' }

if (-not $Apply) {
    Write-Host @"

⚠️  هذه معاينة فقط — لم يتحرّك أي ملف.

للتنفيذ الفعلي أضف -Apply :
  powershell -ExecutionPolicy Bypass -File organize-docs.ps1 -Apply

وللنسخ بدل النقل (يبقي الأصل في مكانه) أضف -Copy أيضًا.

"@ -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------- التنفيذ

Write-Host "`n  سيتم $action $($files.Count) ملف إلى المجلدات أعلاه." -ForegroundColor Yellow
$answer = Read-Host '  اكتب نعم للمتابعة'
if ($answer -ne 'نعم' -and $answer -ne 'y' -and $answer -ne 'yes') {
    Write-Host "`n  أُلغيت العملية. لم يتحرّك شيء." -ForegroundColor DarkGray
    exit 0
}

$done = 0
$failed = @()

foreach ($item in $plan) {
    $targetDir = Join-Path $Destination $item.Category
    try {
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
        $target = Get-FreeName $targetDir $item.File.Name
        if ($Copy) {
            Copy-Item -LiteralPath $item.File.FullName -Destination $target
        } else {
            Move-Item -LiteralPath $item.File.FullName -Destination $target
        }
        $done++
    } catch {
        $failed += "$($item.File.Name) — $($_.Exception.Message)"
    }
}

Write-Host "`n✅ اكتمل: $done ملف" -ForegroundColor Green
if ($failed.Count -gt 0) {
    Write-Host "`n⚠️  تعذّر $($failed.Count) ملف (قد تكون مفتوحة في برنامج آخر):" -ForegroundColor Yellow
    $failed | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" -ForegroundColor DarkGray }
}
Write-Host "`n  المجلد: $Destination`n" -ForegroundColor DarkGray
