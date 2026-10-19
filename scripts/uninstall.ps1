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

function Test-DshHome([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $false }
    try { return Test-Path (Join-Path $p 'profiles\web\cordis.patch.yml') } catch { return $false }
}

function Get-DshHomeCandidates {
    $list = New-Object System.Collections.Generic.List[string]
    function Add-Candidate([string]$p) {
        if ([string]::IsNullOrWhiteSpace($p)) { return }
        if (-not (Test-DshHome $p)) { return }
        try { $resolved = (Resolve-Path $p).Path } catch { return }
        if (-not $list.Contains($resolved)) { $list.Add($resolved) }
    }
    Add-Candidate (Join-Path $env:USERPROFILE '.dsh')
    Add-Candidate (Join-Path $env:APPDATA 'dsh')
    Add-Candidate (Join-Path $env:LOCALAPPDATA 'dsh')
    try {
        $drives = [System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }
        foreach ($d in $drives) {
            $root = $d.RootDirectory.FullName
            $dirs = @()
            try { $dirs = [System.IO.Directory]::GetDirectories($root) } catch { continue }
            foreach ($dir in $dirs) {
                $leaf = Split-Path $dir -Leaf
                if ($leaf -match '^(Windows|Program Files|Program Files \(x86\)|ProgramData|Users|Recovery|System Volume Information|\$Recycle\.Bin)$') { continue }
                foreach ($c in @($dir, (Join-Path $dir 'data'), (Join-Path $dir 'dsh'), (Join-Path $dir 'DSH'), (Join-Path $dir 'deepseek'), (Join-Path $dir 'DeepSeek'))) {
                    Add-Candidate $c
                }
                try {
                    foreach ($sub in [System.IO.Directory]::GetDirectories($dir)) {
                        foreach ($c2 in @($sub, (Join-Path $sub 'data'), (Join-Path $sub 'dsh'))) {
                            Add-Candidate $c2
                        }
                    }
                } catch { }
            }
        }
    } catch { }
    return $list
}

function Find-DshHome {
    # 1) explicit parameter
    if (Test-DshHome $DshHome) { return (Resolve-Path $DshHome).Path }
    # 2) environment variable (when invoked from inside DSH)
    if (Test-DshHome $env:DSH_HOME) { return (Resolve-Path $env:DSH_HOME).Path }

    $candidates = Get-DshHomeCandidates
    if ($candidates.Count -eq 0) { return $null }
    if ($candidates.Count -eq 1) { return $candidates[0] }

    # multiple candidates: pick the one whose patch file changed most recently
    $best = $null
    $bestTime = [datetime]::MinValue
    Write-Host '[!] Found multiple DSH data directories:' -ForegroundColor Yellow
    foreach ($c in $candidates) {
        $t = [datetime]::MinValue
        try { $t = (Get-Item (Join-Path $c 'profiles\web\cordis.patch.yml')).LastWriteTime } catch { }
        Write-Host ("      - {0}  (last modified: {1})" -f $c, $t)
        if ($t -gt $bestTime) { $bestTime = $t; $best = $c }
    }
    Write-Host "[!] Using the most recently modified one: $best" -ForegroundColor Yellow
    Write-Host '    (To pick another: install.bat -DshHome <path>)' -ForegroundColor DarkGray
    return $best
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
