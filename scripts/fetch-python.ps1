<#
.SYNOPSIS
    Download a bundled Python runtime (embeddable 3.11 + Pillow + qrcode) into the plugin assets.
.DESCRIPTION
    Produces <TargetDir>\python\python.exe with PIL + qrcode importable, so the
    file service works without requiring Python on the target machine.
.PARAMETER TargetDir
    Directory that will contain the "python" folder. Defaults to src\assets of this repo.
.PARAMETER PythonVersion
    Embeddable Python version to download. Default 3.11.9.
#>
[CmdletBinding()]
param(
    [string]$TargetDir = '',
    [string]$PythonVersion = '3.11.9'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[+] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

if (-not $TargetDir) {
    $TargetDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\assets'
}
$pyDir = Join-Path $TargetDir 'python'
$site = Join-Path $pyDir 'Lib\site-packages'
$tmp = Join-Path $env:TEMP 'dsh-mobile-remote-py'
New-Item -ItemType Directory -Force -Path $tmp, $pyDir, $site | Out-Null

$ver = $PythonVersion.Replace('.', '')
$verShort = ($PythonVersion -split '\.')[0] + '.' + (($PythonVersion -split '\.')[1])

# ------------------------------------------------------------------ 1. embeddable
$zip = Join-Path $tmp "python-$PythonVersion-embed-amd64.zip"
if (-not (Test-Path (Join-Path $pyDir 'python.exe'))) {
    Step "Downloading Python $PythonVersion embeddable..."
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 300
    Expand-Archive -Path $zip -DestinationPath $pyDir -Force
    Ok 'Python runtime extracted.'
} else {
    Ok 'Python runtime already present.'
}

# ------------------------------------------------------------------ 2. wheels
Step 'Downloading Pillow / qrcode / pypng wheels...'
$wheels = Join-Path $tmp 'wheels'
New-Item -ItemType Directory -Force -Path $wheels | Out-Null
Get-ChildItem $wheels -Filter '*.whl' -ErrorAction SilentlyContinue | Remove-Item -Force

$pipOk = $false
try {
    & pip download Pillow qrcode pypng --only-binary=:all: --platform win_amd64 --python-version $ver `
        -i https://pypi.org/simple -d $wheels 2>&1 | Out-Null
    $pipOk = $true
} catch {
    Warn 'pip download failed, retrying with default index...'
}
if (-not $pipOk) {
    try {
        & pip download Pillow qrcode pypng --only-binary=:all: --platform win_amd64 --python-version $ver -d $wheels 2>&1 | Out-Null
        $pipOk = $true
    } catch {
        Warn 'Could not download wheels automatically.'
    }
}

$whl = @(Get-ChildItem $wheels -Filter '*.whl' -ErrorAction SilentlyContinue)
if ($whl.Count -eq 0) {
    Warn 'No wheels downloaded. Install Pillow + qrcode manually into:'
    Warn "  $site"
    Warn 'Or keep system Python with: pip install Pillow qrcode pypng'
} else {
    Step 'Extracting wheels into site-packages...'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    foreach ($w in $whl) {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($w.FullName, $site)
        Ok "  $($w.Name)"
    }
}

# ------------------------------------------------------------------ 3. _pth
$pth = Join-Path $pyDir "python$ver._pth"
if (Test-Path $pth) {
    $content = [System.IO.File]::ReadAllText($pth)
    $needSite = 'Lib\site-packages'
    if ($content -notmatch [regex]::Escape($needSite)) {
        $lines = @($content -split "\r?\n" | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') })
        $lines += $needSite
        [System.IO.File]::WriteAllText($pth, (($lines -join "`r`n") + "`r`n"))
        Ok '_pth updated (site-packages added).'
    }
}

# ------------------------------------------------------------------ 4. verify
$exe = Join-Path $pyDir 'python.exe'
if (Test-Path $exe) {
    $check = & $exe -c "import PIL, qrcode; print('PIL', PIL.__version__, '| qrcode OK')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Ok "Bundled Python ready: $check"
    } else {
        Warn "Bundled Python present but imports failed: $check"
    }
} else {
    Warn 'python.exe missing after extraction!'
}

Write-Host ''
Ok "Bundled Python directory: $pyDir"
