# Opens Mergeport in the browser (Windows desktop-shortcut target). The sign-in link is single-use and only the launcher knows it,
# so this restarts the launcher (stopping the autostart instance if one is running) and opens the fresh link it prints.
# The launcher itself rebuilds when the code changed and retries a build that stopped on a Next.js notice.
#
# Shortcut target:  powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<repo>\scripts\open-mergeport.ps1"
param([int]$port = 3000)
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$log = Join-Path $env:TEMP 'mergeport-open.log'

Stop-ScheduledTask -TaskName 'Mergeport' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'start-local' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }

$p = Start-Process -FilePath $node -ArgumentList '--import', 'tsx', 'scripts/start-local.ts', '--no-open', '--port', $port -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru

# A rebuild after an update takes a few minutes at most.
$ready = $false
for ($i = 0; $i -lt 300; $i++) {
  Start-Sleep -Milliseconds 1000
  if ($p.HasExited) { break }
  try { if ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/local/ready" -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch {}
}
if ($ready) {
  # The launcher is started with --no-open and prints its one-time sign-in link; open it in Chrome when installed, else the default browser.
  $link = $null
  for ($i = 0; $i -lt 30 -and -not $link; $i++) {
    $m = Select-String -Path $log -Pattern 'http://127\.0\.0\.1:\d+/api/local/launch\?token=\S+' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($m) { $link = $m.Matches[0].Value } else { Start-Sleep -Milliseconds 500 }
  }
  $chrome = @(
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
    (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($link -and $chrome) { Start-Process -FilePath $chrome -ArgumentList $link }
  elseif ($link) { Start-Process $link }
}
if (-not $ready) {
  $msg = (@((Get-Content $log -Tail 5 -ErrorAction SilentlyContinue) + (Get-Content "$log.err" -Tail 5 -ErrorAction SilentlyContinue)) -join "`n")
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show("Mergeport did not start.`n`n$msg", 'Mergeport', 'OK', 'Warning')
}
