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

.PARAMETER NoAgent
    Skips the local update helper. In-app update checks still work, but the
    update card cannot install anything.

.PARAMETER UpdateSource
    Points the installed updater at another manifest base URL, for example the
    local playground (http://127.0.0.1:8787/). Run the installer again without
    this parameter to go back to GitHub.

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
    [switch]$NoElevate,
    [switch]$NoAgent,
    [string]$UpdateSource
)

$ErrorActionPreference = 'Stop'

$ScriptDir    = Split-Path -Parent $PSCommandPath
$ThemeSource  = Join-Path $ScriptDir 'theme'
$BackupDir    = Join-Path $ScriptDir 'backups'
$AssetName    = 'pikpak-darkmode'
$StartMarker  = '<!-- PIKPAK-DARKMODE:START'
$EndMarker    = '<!-- PIKPAK-DARKMODE:END -->'
$MarkerRegex  = '(?s)\s*<!-- PIKPAK-DARKMODE:START.*?<!-- PIKPAK-DARKMODE:END -->\s*'

# Local update helper (loopback only) - see agent/ppdm-update-agent.ps1
$AgentSource      = Join-Path $ScriptDir 'agent\ppdm-update-agent.ps1'
$AgentHome        = Join-Path $env:LOCALAPPDATA 'PikPak-DarkMode'
if (-not $env:LOCALAPPDATA) { $AgentHome = Join-Path $env:APPDATA 'PikPak-DarkMode' }
$AgentConfigPath  = Join-Path $AgentHome 'agent.json'
$AgentPort        = 48179
$AgentRunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$AgentRunName     = 'PikPakDarkModeAgent'

if ($UpdateSource) {
    if ($UpdateSource -notmatch '^https?://') {
        Write-Host '-UpdateSource must be an http(s) base URL.' -ForegroundColor Red
        exit 1
    }
    if (-not $UpdateSource.EndsWith('/')) { $UpdateSource = $UpdateSource + '/' }
}

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

function Get-ThemeVersion([string]$Dir) {
    $file = Join-Path (Join-Path $Dir $AssetName) 'pikpak-darkmode.version.js'
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    try {
        $text = [System.IO.File]::ReadAllText($file)
        $match = [regex]::Match($text, '"version"\s*:\s*"([^"]+)"')
        if ($match.Success) { return $match.Groups[1].Value }
    } catch { }
    return ''
}

function Test-AgentAlive {
    try {
        $probe = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/health' -f $AgentPort) -UseBasicParsing -TimeoutSec 2
        return ($probe.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Install-UpdateAgent {
    if (-not (Test-Path -LiteralPath $AgentSource)) {
        Write-Host 'Update helper script not found; in-app updates stay disabled.' -ForegroundColor Yellow
        return $null
    }

    New-Item -ItemType Directory -Force -Path $AgentHome | Out-Null
    $agentPath = Join-Path $AgentHome 'ppdm-update-agent.ps1'
    Copy-Item -LiteralPath $AgentSource -Destination $agentPath -Force

    # Reuse the existing token so a helper that is already running keeps working.
    $token = ''
    if (Test-Path -LiteralPath $AgentConfigPath) {
        try {
            $existing = Get-Content -LiteralPath $AgentConfigPath -Raw | ConvertFrom-Json
            $token = [string]$existing.token
        } catch { $token = '' }
    }
    if (-not $token) {
        $token = -join (1..32 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    }

    $config = [ordered]@{
        port       = $AgentPort
        token      = $token
        themeDir   = $assetDir
        installDir = $InstallDir
        exe        = (Join-Path $InstallDir 'PikPak.exe')
        agent      = '1.0.0'
    }
    ($config | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $AgentConfigPath -Encoding UTF8

    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = (Get-Process -Id $PID).Path }
    $launch = '"{0}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}"' -f $psExe, $agentPath
    try {
        Set-ItemProperty -Path $AgentRunKey -Name $AgentRunName -Value $launch
    } catch {
        Write-Host 'Could not register the update helper for this user.' -ForegroundColor Yellow
    }

    $running = Test-AgentAlive
    if (-not $running) {
        try {
            Start-Process -FilePath $psExe `
                -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $agentPath) `
                -WindowStyle Hidden
            Start-Sleep -Milliseconds 900
            $running = Test-AgentAlive
        } catch { }
    }

    return [pscustomobject]@{
        Port    = $AgentPort
        Token   = $token
        Running = $running
        Path    = $agentPath
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
    Write-Host "  Theme version  : $(Get-ThemeVersion $MainRenderer)"
    if (Test-Path -LiteralPath $AgentConfigPath) {
        if (Test-AgentAlive) { Write-Host '  Update helper  : running' -ForegroundColor Green }
        else { Write-Host '  Update helper  : stopped' -ForegroundColor Yellow }
    } else {
        Write-Host '  Update helper  : not installed' -ForegroundColor Yellow
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
    if ($NoAgent)    { $arguments += ' -NoAgent' }
    if ($UpdateSource) { $arguments += " -UpdateSource `"$UpdateSource`"" }

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
    # Stop and unregister the local update helper first.
    if (Test-Path -LiteralPath $AgentConfigPath) {
        try {
            $agentCfg = Get-Content -LiteralPath $AgentConfigPath -Raw | ConvertFrom-Json
            if ($agentCfg.pid) {
                $agentProc = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f [int]$agentCfg.pid) -ErrorAction SilentlyContinue
                if ($agentProc -and ($agentProc.CommandLine -like '*ppdm-update-agent.ps1*')) {
                    Stop-Process -Id ([int]$agentCfg.pid) -Force -ErrorAction SilentlyContinue
                }
            }
        } catch { }
        Remove-ItemProperty -Path $AgentRunKey -Name $AgentRunName -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $AgentConfigPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $AgentHome 'ppdm-update-agent.ps1') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $AgentHome 'staging') -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host 'Update helper stopped and unregistered.' -ForegroundColor Green
    }

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

$ThemeFiles = @(
    'pikpak-darkmode.css',
    'pikpak-darkmode.js',
    'pikpak-darkmode-updater.css',
    'pikpak-darkmode-updater.js',
    'pikpak-darkmode.version.js'
)
foreach ($name in $ThemeFiles) {
    $path = Join-Path $ThemeSource $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Missing theme asset: $path" -ForegroundColor Red
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
foreach ($name in $ThemeFiles) {
    Copy-Item -LiteralPath (Join-Path $ThemeSource $name) -Destination (Join-Path $assetDir $name) -Force
}

# Register the local update helper so the card can install deltas without a
# UAC prompt for every release. Skipped with -NoAgent.
$AgentInfo = $null
if (-not $NoAgent) {
    $AgentInfo = Install-UpdateAgent
}
$AgentPortValue  = if ($AgentInfo) { $AgentInfo.Port } else { $AgentPort }
$AgentTokenValue = if ($AgentInfo) { $AgentInfo.Token } else { '' }
$AgentInject     = ''
if ($AgentTokenValue) {
    $AgentInject = 'window.__PPDM_AGENT__={port:' + $AgentPortValue + ',token:"' + $AgentTokenValue + '"};'
}
$SourceInject    = ''
if ($UpdateSource) {
    $SourceInject = 'try{localStorage.setItem("ppdm-update-source","' + $UpdateSource + '");}catch(e){}'
}
$PatchDate       = Get-Date -Format 'yyyy-MM-dd'
$PatchInject     = '<script id="ppdm-patch">window.__PPDM_PATCH__={app:"' + $Version + '",at:"' + $PatchDate + '"};</script>'

# Build the injected block
$block = @"
<!-- PIKPAK-DARKMODE:START - managed by apply-darkmode.ps1, do not edit -->
<link rel="stylesheet" href="./pikpak-darkmode/pikpak-darkmode.css">
<link rel="stylesheet" href="./pikpak-darkmode/pikpak-darkmode-updater.css">
<script id="ppdm-boot">(function(){try{var r=document.documentElement,h=location.hash||'';r.setAttribute('data-pikpak-route',h||'#/');$AgentInject $SourceInject if(/^#(?:player|file-manager)\b/.test(h))return;var m=localStorage.getItem('pikpak-theme')||'system';var d=m==='dark'||(m!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)r.classList.add('pikpak-dark');r.setAttribute('data-pikpak-theme-mode',m);}catch(e){}})();</script>
$PatchInject
<script src="./pikpak-darkmode/pikpak-darkmode.version.js"></script>
<script src="./pikpak-darkmode/pikpak-darkmode.js" defer></script>
<script src="./pikpak-darkmode/pikpak-darkmode-updater.js" defer></script>
<!-- PIKPAK-DARKMODE:END -->
"@

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
Write-Host "  Theme ver.  : $(Get-ThemeVersion $MainRenderer)"
if ($AgentInfo) {
    if ($AgentInfo.Running) {
        Write-Host '  Update helper: running (in-app updates enabled)' -ForegroundColor Cyan
    } else {
        Write-Host '  Update helper: registered, starts with your next sign-in' -ForegroundColor Yellow
    }
} else {
    Write-Host '  Update helper: disabled (-NoAgent)' -ForegroundColor Yellow
}
if ($UpdateSource) {
    Write-Host "  Update source: $UpdateSource (test source; re-run without -UpdateSource to clear)" -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Open PikPak and use the round button at the bottom-right, or press Ctrl+Shift+D.' -ForegroundColor Cyan
Write-Host 'The chosen mode (Light / Dark / System) is remembered between launches.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'PikPak updates replace index.html, so re-run this script after each update.' -ForegroundColor DarkGray

if ($Restart) { Restart-PikPak }
