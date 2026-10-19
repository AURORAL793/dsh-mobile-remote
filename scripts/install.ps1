<#
.SYNOPSIS
    dsh-mobile-remote installer.
.DESCRIPTION
    Copies the plugin into a DSH profile, optionally installs a bundled Python
    runtime (Pillow + qrcode), and registers the plugin in cordis.patch.yml.
.PARAMETER DshHome
    DSH data directory (the folder that contains profiles\web\cordis.patch.yml).
    Defaults to $env:DSH_HOME or %USERPROFILE%\.dsh.
.PARAMETER SkipPython
    Do not download the bundled Python runtime.
.PARAMETER NoPatch
    Do not modify cordis.patch.yml (files are still copied).
.EXAMPLE
    .\install.ps1 -DshHome F:\deepseekai\data
#>
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [switch]$SkipPython,
    [switch]$NoPatch
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SrcDir = Join-Path $RepoRoot 'src'

function Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[+] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
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

Write-Host ''
Write-Host ' dsh-mobile-remote installer' -ForegroundColor White
Write-Host ' Author: AURORAL-极光实验室 <1907927628@qq.com>' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- 1. DSH home
Step 'Locating DSH data directory...'
$dshRoot = Find-DshHome
if (-not $dshRoot) {
    Err 'Could not auto-detect DSH_HOME (needs profiles\web\cordis.patch.yml).'
    $manual = Read-Host 'Enter DSH_HOME path (e.g. F:\deepseekai\data)'
    if ($manual -and (Test-Path (Join-Path $manual 'profiles\web\cordis.patch.yml'))) {
        $dshRoot = (Resolve-Path $manual).Path
    }
}
if (-not $dshRoot) { Err 'Invalid DSH_HOME. Abort.'; exit 1 }
Ok "DSH_HOME = $dshRoot"

# ------------------------------------------------------------ 2. copy plugin
$pluginsDir = Join-Path $dshRoot 'profiles\web\plugins'
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
Step "Copying plugin files to $pluginsDir ..."
foreach ($f in @('mobile-remote.mjs', 'mobile-remote-qr.mjs')) {
    Copy-Item (Join-Path $SrcDir $f) (Join-Path $pluginsDir $f) -Force
}
$assetsDest = Join-Path $pluginsDir 'mobile-remote-assets'
if (Test-Path $assetsDest) { Remove-Item $assetsDest -Recurse -Force }
Copy-Item (Join-Path $SrcDir 'assets') $assetsDest -Recurse -Force
Ok 'Plugin copied.'

# ------------------------------------------------------------ 3. bundled py
if (-not $SkipPython) {
    Step 'Checking file-service runtime (bundled Python)...'
    $pyExe = Join-Path $assetsDest 'python\python.exe'
    if (Test-Path $pyExe) {
        Ok 'Bundled Python already present.'
    } else {
        $answer = Read-Host 'Download bundled Python (~25 MB: Pillow + qrcode, no install needed)? [Y/n]'
        if ($answer -ne 'n' -and $answer -ne 'N') {
            try {
                & (Join-Path $PSScriptRoot 'fetch-python.ps1') -TargetDir $assetsDest
            } catch {
                Warn "Bundled Python setup failed: $($_.Exception.Message)"
                Warn 'The plugin will fall back to system "python" (needs Pillow + qrcode).'
            }
        } else {
            Warn 'Skipped. Needs system Python + Pillow + qrcode, otherwise no thumbnails/QR.'
        }
    }
}

# ------------------------------------------------------------ 4. patch file
if (-not $NoPatch) {
    Step 'Registering plugin in cordis.patch.yml ...'
    $patch = Join-Path $dshRoot 'profiles\web\cordis.patch.yml'
    $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $patch $backup -Force
    Ok "Backup: $backup"

    $text = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)

    # drop our old comment blocks
    $text = [regex]::Replace($text, '(?m)^# \u2500\u2500 mobile-remote.*\r?\n(?:^#.*\r?\n)*', '')

    # drop old insert blocks that mention mobile-remote
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

    $append = @'

# ── mobile-remote 手机远程访问（AURORAL-极光实验室）────────────────────────
# 手机用 DSH 同一个端口访问局域网：http://<局域网IP>:<DSH端口>/
#   /        DeepSeek Harness（手机自适应 UI）
#   /files/  文件浏览（照片 / 文本 / 视频 / 下载）
# 作者: AURORAL-极光实验室 <1907927628@qq.com>   许可: MIT
- insert:
    - id: mobile-remote
      name: ./plugins/mobile-remote.mjs
      config:
        port: 0          # 0 = same port as DSH
        bindHost: ""     # empty = auto-detect LAN IPv4
        filesPort: 8789  # internal file service (loopback only)
        enabled: true
- insert:
    - id: mobile-remote-qr
      name: ./plugins/mobile-remote-qr.mjs
'@

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($patch, $text + $append, $utf8NoBom)
    Ok 'cordis.patch.yml updated.'
}

# ------------------------------------------------------------------ 5. done
Write-Host ''
Ok 'Installation finished.'
Write-Host ''
Write-Host '  Next steps:' -ForegroundColor White
Write-Host '    1. Restart DSH (or wait for Cordis hot reload)'
Write-Host '    2. Open DSH in the computer browser -> QR code at bottom-right'
Write-Host '    3. Scan it with your phone (same Wi-Fi)'
Write-Host ''
Write-Host "  Log file: $pluginsDir\mobile-remote.log" -ForegroundColor DarkGray
Write-Host ''
