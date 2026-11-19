# Opens Mergeport in the browser (Windows desktop-shortcut target).
#
# Fast path (under a second): when Mergeport is already running and is built from the code on disk, it asks the running app for a fresh
# single-use sign-in link (using the secret the launcher left in ~\.mergeport\control.json, readable only by you) and opens it. Nothing restarts.
# Slow path: when it is not running, is stale after an update, or the file is missing, it restarts the launcher (stopping the logon-task
# instance if there is one) and opens the link the launcher prints. The launcher rebuilds when the code changed.
#
# Shortcut target:  powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<repo>\scripts\open-mergeport.ps1"
param([int]$port = 3000)
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$log = Join-Path $env:TEMP 'mergeport-open.log'

function Open-Link([string]$link) {
  if ($env:MERGEPORT_NO_OPEN) { Write-Output $link; return } # for tests: print the link instead of opening a browser
  $chrome = @(
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
    (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($chrome) { Start-Process -FilePath $chrome -ArgumentList $link } else { Start-Process $link }
}

# ---- Fast path ----
try {
  $mhome = if ($env:MERGEPORT_HOME) { $env:MERGEPORT_HOME } else { Join-Path $env:USERPROFILE '.mergeport' }
  $ctl = Join-Path $mhome 'control.json'
  if (Test-Path $ctl) {
    $c = Get-Content $ctl -Raw | ConvertFrom-Json
    $head = (& git -C $repo rev-parse HEAD 2>$null | Select-Object -First 1)
    # The launcher stamps its build with git HEAD (plus a hash of the lockfile and schema). Same HEAD and untouched lockfile/schema means same build.
    & git -C $repo diff --quiet HEAD -- package-lock.json prisma/schema.prisma 2>$null
    $hashedClean = ($LASTEXITCODE -eq 0)
    if ($c.port -eq $port -and (Get-Process -Id $c.pid -ErrorAction SilentlyContinue) -and $head -and $c.stamp -and $c.stamp.StartsWith($head) -and $hashedClean) {
      $r = Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:$($c.port)/api/local/link" -Headers @{ 'x-mergeport-control' = $c.secret } -TimeoutSec 3
      if ($r.url -like "http://127.0.0.1:*") { Open-Link $r.url; exit 0 }
    }
  }
} catch { }

# ---- Slow path: (re)start the launcher ----
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
  # The launcher is started with --no-open and prints its one-time sign-in link.
  $link = $null
  for ($i = 0; $i -lt 30 -and -not $link; $i++) {
    $m = Select-String -Path $log -Pattern 'http://127\.0\.0\.1:\d+/api/local/launch\?token=\S+' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($m) { $link = $m.Matches[0].Value } else { Start-Sleep -Milliseconds 500 }
  }
  if ($link) { Open-Link $link }
}
if (-not $ready) {
  $msg = (@((Get-Content $log -Tail 5 -ErrorAction SilentlyContinue) + (Get-Content "$log.err" -Tail 5 -ErrorAction SilentlyContinue)) -join "`n")
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show("Mergeport did not start.`n`n$msg", 'Mergeport', 'OK', 'Warning')
}
