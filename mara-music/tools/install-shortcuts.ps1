<#
    ينشئ اختصارات أدوات مارا على سطح المكتب.

        powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1

    للحذف:
        powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1 -Remove
#>

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path $PSScriptRoot -Parent
$Desktop = [Environment]::GetFolderPath('Desktop')
$Icon = Join-Path $Root 'src\assets\icon.ico'

$shortcuts = @(
    @{ Name = 'مارا ميوزك'; Target = 'تشغيل-مارا.bat'; Icon = $Icon
       Desc = 'تشغيل مشغّل موسيقى مارا' }
    @{ Name = 'تنظيف الجهاز'; Target = 'تنظيف-الجهاز.bat'; Icon = "$env:SystemRoot\System32\cleanmgr.exe,0"
       Desc = 'تحرير مساحة بحذف الملفات المؤقتة — لا يمس ملفاتك' }
    @{ Name = 'ترتيب الوثائق'; Target = 'ترتيب-الوثائق.bat'; Icon = "$env:SystemRoot\System32\shell32.dll,3"
       Desc = 'ترتيب ملفات التنزيلات في مجلدات منظّمة' }
    @{ Name = 'نسخة احتياطية لمارا'; Target = 'نسخة-احتياطية.bat'; Icon = "$env:SystemRoot\System32\shell32.dll,46"
       Desc = 'نسخ الأغاني والقوائم والإعدادات إلى فلاشة' }
)

if ($Remove) {
    $n = 0
    foreach ($s in $shortcuts) {
        $link = Join-Path $Desktop "$($s.Name).lnk"
        if (Test-Path $link) { Remove-Item $link -Force; $n++ }
    }
    Write-Host "`n✅ حُذف $n اختصارًا من سطح المكتب`n" -ForegroundColor Green
    exit 0
}

Write-Host "`n=== إنشاء اختصارات سطح المكتب ===" -ForegroundColor White

$shell = New-Object -ComObject WScript.Shell
$created = 0

foreach ($s in $shortcuts) {
    $target = Join-Path $Root $s.Target
    if (-not (Test-Path $target)) {
        Write-Host "  ⚠️  غير موجود، تخطّي: $($s.Target)" -ForegroundColor Yellow
        continue
    }

    $link = Join-Path $Desktop "$($s.Name).lnk"
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = $target
    $sc.WorkingDirectory = $Root
    $sc.Description = $s.Desc
    if ($s.Icon -and (Test-Path ($s.Icon -split ',')[0])) { $sc.IconLocation = $s.Icon }
    $sc.Save()

    Write-Host "  ✅ $($s.Name)" -ForegroundColor Green
    $created++
}

Write-Host "`n  أُنشئ $created اختصارًا في: $Desktop`n" -ForegroundColor DarkGray
