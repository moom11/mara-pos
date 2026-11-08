<#
  تثبيت عنوان الوحي على الشبكة.

  الراوتر يمنح الأجهزة عناوين مؤقّتة، فيتغيّر عنوان الوحي كل فترة ويتوقّف
  الجوال عن الوصول إليه. هذا الملف يثبّت العنوان على ويندوز نفسه، فلا
  يتغيّر بعدها حتى لو أُعيد تشغيل الراوتر أو الجهاز.

  الأمان: بعد التثبيت يتحقّق من أن الإنترنت ما زال يعمل. إن لم يعمل يرجع
  تلقائيًا إلى الوضع التلقائي، فلا يبقى الجهاز معزولًا بأي حال.

  للرجوع يدويًا:  powershell -File pin-ip.ps1 -Undo

  المخرجات بالإنجليزية عمدًا: نافذة PowerShell على الوحي لا تعرض العربية.
#>
param(
  [string]$Address = '',
  [int]$Port = 8787,
  [switch]$Undo
)

$ErrorActionPreference = 'Stop'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Warn($text) { Write-Host "    !   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "`n  FAILED: $text" -ForegroundColor Red }

# الكرت الذي يخرج منه الإنترنت فعلًا: الذي يملك بوّابة افتراضية وهو يعمل
function Get-ActiveConfig {
  Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object -First 1
}

# الحكم على نجاح الشبكة: البوّابة ترد، أو الأسماء تُترجم. يكفي أحدهما،
# فبعض الراوترات لا ترد على ping أصلًا.
function Test-Network($gateway) {
  $pinged = $false
  try { $pinged = Test-Connection -ComputerName $gateway -Count 2 -Quiet } catch { $pinged = $false }
  $resolved = $false
  try {
    $resolved = $null -ne (Resolve-DnsName 'github.com' -Type A -QuickTimeout -ErrorAction Stop)
  } catch { $resolved = $false }
  Info "gateway reachable: $pinged , dns works: $resolved"
  return ($pinged -or $resolved)
}

function Restore-Dhcp($index) {
  Set-NetIPInterface -InterfaceIndex $index -Dhcp Enabled -ErrorAction SilentlyContinue
  Set-DnsClientServerAddress -InterfaceIndex $index -ResetServerAddresses -ErrorAction SilentlyContinue
  ipconfig /renew | Out-Null
  Start-Sleep -Seconds 4
}

Write-Host ''
Write-Host '  ===== Mara Music - Pin Tablet Address =====' -ForegroundColor Yellow
Write-Host '  Keeps the tablet on one address so your phone always finds it.'
Write-Host ''

try {
  $config = Get-ActiveConfig
  if (-not $config) {
    Fail 'no active network adapter with a gateway was found'
    Info 'Connect the tablet to the restaurant Wi-Fi, then run this again.'
    exit 1
  }

  $index = $config.InterfaceIndex
  $adapter = $config.InterfaceAlias
  $gateway = $config.IPv4DefaultGateway.NextHop

  # ----------------------------------------------------------- الرجوع
  if ($Undo) {
    Step 1 "Returning $adapter to automatic (DHCP)"
    Restore-Dhcp $index
    $after = Get-ActiveConfig
    if ($after) {
      Ok "address is now $($after.IPv4Address.IPAddress) (automatic)"
    } else {
      Warn 'the adapter did not come back - restart the tablet'
    }
    Write-Host ''
    exit 0
  }

  $current = $config.IPv4Address.IPAddress
  $prefix = $config.IPv4Address.PrefixLength
  $dns = @(
    (Get-DnsClientServerAddress -InterfaceIndex $index -AddressFamily IPv4).ServerAddresses |
      Where-Object { $_ -and $_ -ne '127.0.0.1' }
  )
  # بلا DNS لا إنترنت ولا تحديث: البوّابة تصلح مترجمًا للأسماء في أي شبكة منزلية
  if (-not $dns -or $dns.Count -eq 0) { $dns = @($gateway) }

  $target = if ($Address) { $Address } else { $current }

  Step 1 'Reading the current network'
  Info "adapter : $adapter"
  Info "address : $current /$prefix"
  Info "gateway : $gateway"
  Info "dns     : $($dns -join ', ')"

  if ($target -eq $current) {
    Ok "keeping $target - it already works on this network"
  } else {
    Step 2 "Checking that $target is free"
    $taken = $false
    try { $taken = Test-Connection -ComputerName $target -Count 2 -Quiet } catch { $taken = $false }
    if ($taken) {
      Fail "$target is already used by another device"
      Info 'Run this file without an address to keep the current one.'
      exit 1
    }
    Ok "$target is free"
  }

  # ------------------------------------------------------- التثبيت
  Step 3 "Pinning $target on $adapter"
  Set-NetIPInterface -InterfaceIndex $index -Dhcp Disabled
  Remove-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetRoute -InterfaceIndex $index -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
  New-NetIPAddress -InterfaceIndex $index -IPAddress $target -PrefixLength $prefix -DefaultGateway $gateway | Out-Null
  Set-DnsClientServerAddress -InterfaceIndex $index -ServerAddresses $dns
  Start-Sleep -Seconds 5
  Ok 'applied'

  # --------------------------------------------- التحقّق ثم الرجوع عند الفشل
  Step 4 'Checking that the internet still works'
  if (-not (Test-Network $gateway)) {
    Warn 'the network stopped working - returning to automatic'
    Restore-Dhcp $index
    Fail 'could not pin the address on this network'
    Info 'Nothing was left broken: the tablet is back on automatic.'
    Info 'Ask the router for a DHCP Reservation instead.'
    exit 1
  }
  Ok 'internet works'

  Write-Host ''
  Write-Host '  ===== DONE =====' -ForegroundColor Green
  Write-Host "  The tablet address is now fixed at: $target"
  Write-Host "  Open this on your phone:  http://${target}:${Port}"
  Write-Host ''
  Write-Host '  It will not change again, even after a restart.' -ForegroundColor Yellow
  Write-Host '  To undo:  run this file with  -Undo'
  Write-Host ''
} catch {
  Fail $_.Exception.Message
  Write-Host ''
  Write-Host '  Nothing permanent was changed. If the tablet lost its network,' -ForegroundColor Yellow
  Write-Host '  run this file again with  -Undo  to return to automatic.'
  Write-Host ''
  exit 1
}
