#requires -Version 5.1
<#
.SYNOPSIS
    Applies the PikPak dark mode theme to the installed PikPak desktop app.

.DESCRIPTION
    PikPak ships its UI inside resources\app\out\main-renderer\index.html.
    This script makes a timestamped backup of that file, copies the theme
    assets next to it, and injects a small marked block that loads them.

    The change is idempotent: running the script again replaces the previous
    injection instead of stacking duplicates, so it can safely be re-run after
    every PikPak update.

.PARAMETER InstallDir
    PikPak installation folder (the one containing PikPak.exe). Auto-detected
    when omitted.

.PARAMETER Restore
    Removes the theme injection and the copied theme assets. Backups are kept.

.PARAMETER Restart
    Restarts PikPak after applying or restoring the theme.

.PARAMETER Status
    Prints the detected install, app version, and whether the theme is applied.

.PARAMETER NoElevate
    Internal flag used by the self-elevation relaunch.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\apply-darkmode.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\apply-darkmode.ps1 -Status

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\apply-darkmode.ps1 -Restore -Restart
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$Restore,
    [switch]$Restart,
    [switch]$Status,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

$ScriptDir    = Split-Path -Parent $PSCommandPath
$ThemeSource  = Join-Path $ScriptDir 'theme'
$BackupDir    = Join-Path $ScriptDir 'backups'
$AssetName    = 'pikpak-darkmode'
$StartMarker  = '<!-- PIKPAK-DARKMODE:START'
$EndMarker    = '<!-- PIKPAK-DARKMODE:END -->'
$MarkerRegex  = '(?s)\s*<!-- PIKPAK-DARKMODE:START.*?<!-- PIKPAK-DARKMODE:END -->\s*'

function Test-IsAdmin {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-IndexPath([string]$Dir) {
    if (-not $Dir) { return $null }
    $candidate = Join-Path $Dir 'resources\app\out\main-renderer\index.html'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

function Find-PikPakDir {
    $candidates = New-Object System.Collections.Generic.List[string]

    $registryRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    foreach ($root in $registryRoots) {
        try {
            $entries = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*PikPak*' }
            foreach ($entry in $entries) {
                if ($entry.InstallLocation) { $candidates.Add($entry.InstallLocation) }
                if ($entry.DisplayIcon) {
                    $icon = ($entry.DisplayIcon -split ',')[0].Trim('"')
                    if ($icon) { $candidates.Add((Split-Path -Parent $icon)) }
                }
            }
        } catch { }
    }

    $candidates.Add('C:\Program Files\PikPak')
    $candidates.Add('C:\Program Files (x86)\PikPak')
    if ($env:LOCALAPPDATA) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\PikPak'))
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'PikPak'))
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Get-IndexPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-AppVersion([string]$Dir) {
    $packageJson = Join-Path $Dir 'resources\app\package.json'
    if (Test-Path -LiteralPath $packageJson) {
        try {
            $json = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
            if ($json.version) { return [string]$json.version }
        } catch { }
    }
    $exe = Join-Path $Dir 'PikPak.exe'
    if (Test-Path -LiteralPath $exe) {
        try { return (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } catch { }
    }
    return 'unknown'
}

function Test-ThemeApplied([string]$IndexPath) {
    if (-not (Test-Path -LiteralPath $IndexPath)) { return $false }
    $text = [System.IO.File]::ReadAllText($IndexPath)
    return ($text.Contains($StartMarker) -and $text.Contains($EndMarker))
}

function Restart-PikPak {
    $running = Get-Process -Name 'PikPak' -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host 'Stopping PikPak...' -ForegroundColor DarkGray
        $running | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
    $exe = Join-Path $script:InstallDir 'PikPak.exe'
    if (Test-Path -LiteralPath $exe) {
        Write-Host 'Starting PikPak...' -ForegroundColor DarkGray
        Start-Process -FilePath $exe
    }
}

# --------------------------------------------------------------------------
# Locate the app
# --------------------------------------------------------------------------

if (-not $InstallDir) {
    $InstallDir = Find-PikPakDir
}

if (-not $InstallDir) {
    Write-Host 'Could not find a PikPak installation.' -ForegroundColor Red
    Write-Host 'Pass the folder that contains PikPak.exe with -InstallDir "C:\Path\To\PikPak".'
    exit 1
}

$IndexPath = Get-IndexPath $InstallDir
if (-not $IndexPath) {
    Write-Host "PikPak was found at '$InstallDir', but the expected UI file is missing:" -ForegroundColor Red
    Write-Host "  $IndexPath"
    exit 1
}

$MainRenderer = Split-Path -Parent $IndexPath
$Version      = Get-AppVersion $InstallDir
$Applied      = Test-ThemeApplied $IndexPath

# --------------------------------------------------------------------------
# Status
# --------------------------------------------------------------------------

if ($Status) {
    Write-Host ''
    Write-Host 'PikPak Dark Mode status' -ForegroundColor Cyan
    Write-Host "  Install folder : $InstallDir"
    Write-Host "  App version    : $Version"
    Write-Host "  UI file        : $IndexPath"
    if ($Applied) {
        Write-Host '  Theme          : applied' -ForegroundColor Green
    } else {
        Write-Host '  Theme          : not applied' -ForegroundColor Yellow
    }
    Write-Host "  Backup folder  : $BackupDir"
    Write-Host ''
    exit 0
}

# --------------------------------------------------------------------------
# Elevate if needed (Program Files requires administrator rights)
# --------------------------------------------------------------------------

if (-not (Test-IsAdmin) -and -not $NoElevate) {
    $exe = (Get-Process -Id $PID).Path
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -NoElevate"
    if ($InstallDir) { $arguments += " -InstallDir `"$InstallDir`"" }
    if ($Restore)    { $arguments += ' -Restore' }
    if ($Restart)    { $arguments += ' -Restart' }

    Write-Host 'Administrator rights are required to modify the PikPak installation.' -ForegroundColor Yellow
    Write-Host 'Relaunching with elevation...' -ForegroundColor Yellow
    try {
        Start-Process -FilePath $exe -Verb RunAs -ArgumentList $arguments
    } catch {
        Write-Host 'Elevation was cancelled or failed.' -ForegroundColor Red
        Write-Host "You can also right-click this script and choose 'Run as administrator'."
        exit 1
    }
    exit 0
}

# --------------------------------------------------------------------------
# Restore
# --------------------------------------------------------------------------

if ($Restore) {
    $text = [System.IO.File]::ReadAllText($IndexPath)
    if ($text.Contains($StartMarker)) {
        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = Join-Path $BackupDir ("index.html.before-restore-{0}.bak" -f $stamp)
        Copy-Item -LiteralPath $IndexPath -Destination $backup -Force

        $cleaned = [regex]::Replace($text, $MarkerRegex, '')
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($IndexPath, $cleaned, $utf8)
        Write-Host 'Theme injection removed.' -ForegroundColor Green
        Write-Host "Pre-restore backup: $backup" -ForegroundColor DarkGray
    } else {
        Write-Host 'The theme was not applied to this installation.' -ForegroundColor Yellow
    }

    $assetDir = Join-Path $MainRenderer $AssetName
    if (Test-Path -LiteralPath $assetDir) {
        Remove-Item -LiteralPath $assetDir -Recurse -Force
        Write-Host 'Copied theme assets removed.' -ForegroundColor Green
    }

    if ($Restart) { Restart-PikPak }
    Write-Host 'Restore complete.' -ForegroundColor Green
    exit 0
}

# --------------------------------------------------------------------------
# Apply
# --------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $ThemeSource)) {
    Write-Host "Theme source folder not found: $ThemeSource" -ForegroundColor Red
    Write-Host 'Keep apply-darkmode.ps1 next to its theme folder.'
    exit 1
}

$cssSource = Join-Path $ThemeSource 'pikpak-darkmode.css'
$jsSource  = Join-Path $ThemeSource 'pikpak-darkmode.js'
foreach ($file in @($cssSource, $jsSource)) {
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host "Missing theme asset: $file" -ForegroundColor Red
        exit 1
    }
}

$running = Get-Process -Name 'PikPak' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'PikPak is running. The files can still be patched, but the theme will' -ForegroundColor Yellow
    Write-Host 'only appear after PikPak is restarted.' -ForegroundColor Yellow
    if (-not $Restart) {
        Write-Host 'Tip: add -Restart to let this script restart PikPak automatically.' -ForegroundColor DarkGray
    }
}

# Backup
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp        = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupName   = 'index.html.bak-{0}' -f $stamp
$backupPath   = Join-Path $BackupDir $backupName
$versionNote  = Join-Path $BackupDir ("version-{0}.txt" -f $stamp)
Copy-Item -LiteralPath $IndexPath -Destination $backupPath -Force
Set-Content -LiteralPath $versionNote -Value ("PikPak version: {0}`r`nBackup: {1}" -f $Version, $backupName) -Encoding UTF8
Write-Host "Backup created: $backupPath" -ForegroundColor DarkGray

# Copy assets next to the app's index.html
$assetDir = Join-Path $MainRenderer $AssetName
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
Copy-Item -LiteralPath $cssSource -Destination (Join-Path $assetDir 'pikpak-darkmode.css') -Force
Copy-Item -LiteralPath $jsSource  -Destination (Join-Path $assetDir 'pikpak-darkmode.js')  -Force

# Build the injected block
$block = @'
<!-- PIKPAK-DARKMODE:START - managed by apply-darkmode.ps1, do not edit -->
<link rel="stylesheet" href="./pikpak-darkmode/pikpak-darkmode.css">
<script id="ppdm-boot">(function(){try{var r=document.documentElement,h=location.hash||'';r.setAttribute('data-pikpak-route',h||'#/');if(/^#(?:player|file-manager)\b/.test(h))return;var m=localStorage.getItem('pikpak-theme')||'system';var d=m==='dark'||(m!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)r.classList.add('pikpak-dark');r.setAttribute('data-pikpak-theme-mode',m);}catch(e){}})();</script>
<script src="./pikpak-darkmode/pikpak-darkmode.js" defer></script>
<!-- PIKPAK-DARKMODE:END -->
'@

$original = [System.IO.File]::ReadAllText($IndexPath)
$cleaned  = [regex]::Replace($original, $MarkerRegex, '')

$headIndex = $cleaned.IndexOf('<head>', [StringComparison]::OrdinalIgnoreCase)
if ($headIndex -ge 0) {
    $insertAt = $headIndex + '<head>'.Length
    $updated  = $cleaned.Substring(0, $insertAt) + "`r`n" + $block + "`r`n" + $cleaned.Substring($insertAt)
} else {
    $updated = $cleaned + "`r`n" + $block + "`r`n"
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($IndexPath, $updated, $utf8)

# Verify
$verify = [System.IO.File]::ReadAllText($IndexPath)
if (-not ($verify.Contains($StartMarker) -and $verify.Contains($EndMarker))) {
    Write-Host 'Injection could not be verified. Restoring the backup...' -ForegroundColor Red
    Copy-Item -LiteralPath $backupPath -Destination $IndexPath -Force
    exit 1
}

Write-Host ''
Write-Host 'PikPak Dark Mode applied.' -ForegroundColor Green
Write-Host "  App version : $Version"
Write-Host "  Patched     : $IndexPath"
Write-Host "  Backup      : $backupPath"
Write-Host ''
Write-Host 'Open PikPak and use the round button at the bottom-right, or press Ctrl+Shift+D.' -ForegroundColor Cyan
Write-Host 'The chosen mode (Light / Dark / System) is remembered between launches.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'PikPak updates replace index.html, so re-run this script after each update.' -ForegroundColor DarkGray

if ($Restart) { Restart-PikPak }
