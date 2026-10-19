<#
.SYNOPSIS
    dsh-mobile-remote uninstaller.
.DESCRIPTION
    Removes plugin files and its entries from cordis.patch.yml.
.PARAMETER DshHome
    DSH data directory containing profiles\web\cordis.patch.yml.
#>
[CmdletBinding()]
param(
    [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[+] $msg" -ForegroundColor Green }
function Err($msg)  { Write-Host "[-] $msg" -ForegroundColor Red }

function Find-DshHome {
    $candidates = @()
    if ($DshHome) { $candidates += $DshHome }
    if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
    $candidates += (Join-Path $env:USERPROFILE '.dsh')
    foreach ($c in $candidates) {
        if ([string]::IsNullOrWhiteSpace($c)) { continue }
        if (Test-Path (Join-Path $c 'profiles\web\cordis.patch.yml')) { return (Resolve-Path $c).Path }
    }
    return $null
}

$dshRoot = Find-DshHome
if (-not $dshRoot) {
    $manual = Read-Host 'Enter DSH_HOME path'
    if ($manual -and (Test-Path (Join-Path $manual 'profiles\web\cordis.patch.yml'))) {
        $dshRoot = (Resolve-Path $manual).Path
    }
}
if (-not $dshRoot) { Err 'Invalid DSH_HOME. Abort.'; exit 1 }
Ok "DSH_HOME = $dshRoot"

$pluginsDir = Join-Path $dshRoot 'profiles\web\plugins'

# --------------------------------------------------------------- remove files
Step 'Removing plugin files...'
foreach ($f in @('mobile-remote.mjs', 'mobile-remote-qr.mjs')) {
    $p = Join-Path $pluginsDir $f
    if (Test-Path $p) { Remove-Item $p -Force; Ok "  removed $f" }
}
foreach ($d in @('mobile-remote-assets')) {
    $p = Join-Path $pluginsDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Ok "  removed $d\" }
}
$log = Join-Path $pluginsDir 'mobile-remote.log'
if (Test-Path $log) { Remove-Item $log -Force; Ok '  removed mobile-remote.log' }

# --------------------------------------------------------------- patch clean
Step 'Removing entries from cordis.patch.yml ...'
$patch = Join-Path $dshRoot 'profiles\web\cordis.patch.yml'
$backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $patch $backup -Force
Ok "Backup: $backup"

$text = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)
$text = [regex]::Replace($text, '(?m)^# \u2500\u2500 mobile-remote.*\r?\n(?:^#.*\r?\n)*', '')

$lines = $text -split "\r?\n"
$kept = New-Object System.Collections.Generic.List[string]
$i = 0
while ($i -lt $lines.Count) {
    if ($lines[$i] -match '^\s*- insert:\s*$') {
        $start = $i
        $j = $i + 1
        while ($j -lt $lines.Count -and $lines[$j] -notmatch '^- ') { $j++ }
        $blockText = ($lines[$start..($j - 1)] -join "`n")
        if ($blockText -match 'mobile-remote') {
            $i = $j
            continue
        }
        for ($k = $start; $k -lt $j; $k++) { $kept.Add($lines[$k]) }
        $i = $j
        continue
    }
    $kept.Add($lines[$i])
    $i++
}
$text = (($kept -join "`r`n").TrimEnd()) + "`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($patch, $text, $utf8NoBom)
Ok 'cordis.patch.yml cleaned.'

Write-Host ''
Ok 'Uninstalled. Restart DSH to apply.'
