#requires -Version 5.1
<#
.SYNOPSIS
    Serves a fake theme release so the in-app update card can be exercised locally.

.DESCRIPTION
    Nothing is published and nothing in the repo changes. The script:

      1. copies theme/ into .playground/theme
      2. appends one visible demo rule to that copy (a genuine one-file delta)
      3. writes .playground/update/manifest.json advertising the next version
      4. starts the local update helper when it is not already answering
      5. serves .playground/ on http://127.0.0.1:<port>/ with CORS enabled

    Point the updater at it from PikPak's DevTools console (the snippet is copied
    to the clipboard), and the card behaves exactly like a real release.

.PARAMETER Version
    Release version to advertise. Defaults to the next minor above what is installed.

.PARAMETER Port
    Loopback port for the playground server. Default 8787.

.PARAMETER Notes
    Changelog lines shown in the update card.

.PARAMETER InstalledDir
    Installed theme folder to compare against. Defaults to the folder recorded in
    %LOCALAPPDATA%\PikPak-DarkMode\agent.json.

.PARAMETER NoHelper
    Does not try to start the local update helper.

.EXAMPLE
    .\tools\update-playground.ps1

.EXAMPLE
    .\tools\update-playground.ps1 -Version 2.0.0 -Port 8790
#>
[CmdletBinding()]
param(
    [string]$Version,
    [int]$Port = 8787,
    [string[]]$Notes = @(
        'Playground release: theme toggle accent',
        'Exercises the delta download path'
    ),
    [string]$InstalledDir,
    [switch]$NoHelper
)

$ErrorActionPreference = 'Stop'

$Root             = Split-Path -Parent $PSScriptRoot
$ThemeDir         = Join-Path $Root 'theme'
$Playground       = Join-Path $Root '.playground'
$PlaygroundTheme  = Join-Path $Playground 'theme'
$PlaygroundUpdate = Join-Path $Playground 'update'
$AssetNames       = @(
    'pikpak-darkmode.css',
    'pikpak-darkmode.js',
    'pikpak-darkmode-updater.css',
    'pikpak-darkmode-updater.js'
)
$DemoRule = "`r`n/* update playground: visible proof the delta landed */`r`n" +
            "#ppdm-toggle { box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.55), 0 6px 20px rgba(16, 24, 40, 0.18); }`r`n"

function Get-NextVersion([string]$Current) {
    $match = [regex]::Match($Current, '^(\d+)\.(\d+)\.(\d+)')
    if ($match.Success) {
        return ('{0}.{1}.0' -f $match.Groups[1].Value, ([int]$match.Groups[2].Value + 1))
    }
    return '9.9.9'
}

# ---------------------------------------------------------------- #
# Where is the theme installed?                                     #
# ---------------------------------------------------------------- #

$AgentHome       = Join-Path $env:LOCALAPPDATA 'PikPak-DarkMode'
$AgentConfigPath = Join-Path $AgentHome 'agent.json'

if (-not $InstalledDir) {
    if (Test-Path -LiteralPath $AgentConfigPath) {
        try {
            $InstalledDir = [string]((Get-Content -LiteralPath $AgentConfigPath -Raw | ConvertFrom-Json).themeDir)
        } catch {
            $InstalledDir = ''
        }
    }
}

if (-not $InstalledDir -or -not (Test-Path -LiteralPath $InstalledDir)) {
    Write-Host 'The theme does not look installed yet.' -ForegroundColor Red
    Write-Host 'Run .\apply-darkmode.ps1 first, or point at the folder with -InstalledDir.' -ForegroundColor Yellow
    exit 1
}

$InstalledManifest = Join-Path $InstalledDir 'pikpak-darkmode.version.js'
if (-not (Test-Path -LiteralPath $InstalledManifest)) {
    Write-Host "No pikpak-darkmode.version.js in $InstalledDir" -ForegroundColor Red
    Write-Host 'Re-run .\apply-darkmode.ps1 to install the updater assets.' -ForegroundColor Yellow
    exit 1
}

$installedText    = [System.IO.File]::ReadAllText($InstalledManifest)
$installedVersion = [regex]::Match($installedText, '"version"\s*:\s*"([^"]+)"').Groups[1].Value
$bootstrap        = [regex]::Match($installedText, '"bootstrap"\s*:\s*(\d+)').Groups[1].Value
if (-not $installedVersion) { $installedVersion = '0.0.0' }
if (-not $bootstrap) { $bootstrap = 2 }

if (-not $Version) { $Version = Get-NextVersion $installedVersion }

# ---------------------------------------------------------------- #
# Build the fake release                                            #
# ---------------------------------------------------------------- #

if (Test-Path -LiteralPath $Playground) {
    Remove-Item -LiteralPath $Playground -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PlaygroundTheme | Out-Null
New-Item -ItemType Directory -Force -Path $PlaygroundUpdate | Out-Null

foreach ($name in $AssetNames) {
    Copy-Item -LiteralPath (Join-Path $ThemeDir $name) -Destination (Join-Path $PlaygroundTheme $name) -Force
}

# One changed file is enough to prove the delta; make it visible so the applied
# update is obvious after a reload.
Add-Content -LiteralPath (Join-Path $PlaygroundTheme 'pikpak-darkmode.css') -Value $DemoRule -NoNewline

$files = @()
foreach ($name in $AssetNames) {
    $item = Get-Item -LiteralPath (Join-Path $PlaygroundTheme $name)
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $files += '    "{0}": {{ "sha256": "{1}", "size": {2} }}' -f $name, $hash, [int]$item.Length
}
$fileEntries = $files -join ",`r`n"

$notesJson = if ($Notes.Count -gt 0) {
    "[`r`n" + (($Notes | ForEach-Object { '    "{0}"' -f $_ }) -join ",`r`n") + "`r`n  ]"
} else {
    '[]'
}

$manifest = @"
{
  "schema": 1,
  "version": "$Version",
  "bootstrap": $bootstrap,
  "released": "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))",
  "notes": $notesJson,
  "files": {
$fileEntries
  }
}
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifestPath = Join-Path $PlaygroundUpdate 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, ($manifest -replace "`r?`n", "`r`n"), $utf8)

# ---------------------------------------------------------------- #
# Make sure the helper can install what the card downloads           #
# ---------------------------------------------------------------- #

$helperState = 'not installed'
if (Test-Path -LiteralPath $AgentConfigPath) {
    $agentConfig = Get-Content -LiteralPath $AgentConfigPath -Raw | ConvertFrom-Json
    $agentPort = [int]$agentConfig.port
    $helperAlive = $false
    try {
        $probe = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $agentPort) -UseBasicParsing -TimeoutSec 2
        $helperAlive = ($probe.StatusCode -eq 200)
    } catch {
        $helperAlive = $false
    }
    if ($helperAlive) {
        $helperState = 'running'
    } elseif (-not $NoHelper) {
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $agentScript = Join-Path $AgentHome 'ppdm-update-agent.ps1'
        if (Test-Path -LiteralPath $agentScript) {
            Start-Process -FilePath $psExe `
                -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $agentScript) `
                -WindowStyle Hidden
            Start-Sleep -Milliseconds 1200
            try {
                $probe = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $agentPort) -UseBasicParsing -TimeoutSec 2
                if ($probe.StatusCode -eq 200) { $helperState = 'started' }
            } catch { }
        }
    }
    if ($helperState -eq 'not installed') { $helperState = 'stopped' }
}

# ---------------------------------------------------------------- #
# Serve the fake release                                            #
# ---------------------------------------------------------------- #

$baseUrl = 'http://127.0.0.1:{0}/' -f $Port
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($baseUrl)
try {
    $listener.Start()
} catch {
    Write-Host ("Could not listen on {0} - is the port busy?" -f $baseUrl) -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

$rootFull = (Resolve-Path -LiteralPath $Playground).Path.TrimEnd('\')
$snippet = "localStorage.setItem('ppdm-update-source','$baseUrl'); PikPakUpdater.check({force:true, interactive:true});"

Write-Host ''
Write-Host 'PikPak Dark Mode - update playground' -ForegroundColor Cyan
Write-Host ("  Installed      : v{0}" -f $installedVersion)
if ($Version -ne $installedVersion) {
    Write-Host ("  Fake release   : v{0}  (1 of 4 files changes)" -f $Version) -ForegroundColor Green
} else {
    Write-Host ("  Fake release   : v{0}  (same as installed - the card will not appear)" -f $Version) -ForegroundColor Yellow
}
Write-Host ("  Serving        : {0}" -f $baseUrl)
Write-Host ("  Update helper  : {0}" -f $helperState)
Write-Host ''
Write-Host 'Open PikPak and paste this into the DevTools console (Ctrl+Shift+I):' -ForegroundColor Cyan
Write-Host ("  " + $snippet) -ForegroundColor White
try {
    Set-Clipboard -Value $snippet
    Write-Host '  (copied to the clipboard)' -ForegroundColor DarkGray
} catch { }
Write-Host ''
Write-Host 'When you are done: PikPakUpdater.reset()   - stops using this server' -ForegroundColor DarkGray
Write-Host 'Press Ctrl+C to stop the playground.' -ForegroundColor DarkGray
Write-Host ''

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $method = $context.Request.HttpMethod.ToUpperInvariant()
            $context.Response.Headers['Access-Control-Allow-Origin'] = '*'
            $context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
            $context.Response.Headers['Cache-Control'] = 'no-store'
            $context.Response.Headers['X-Content-Type-Options'] = 'nosniff'

            if ($method -eq 'OPTIONS') {
                $context.Response.StatusCode = 204
                $context.Response.ContentLength64 = 0
                $context.Response.Close()
                continue
            }

            $relative = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/')
            $relative = $relative -replace '/', '\'
            $target = [System.IO.Path]::GetFullPath((Join-Path $rootFull $relative))

            if (-not $target.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $context.Response.StatusCode = 403
                $context.Response.ContentLength64 = 0
                $context.Response.Close()
                continue
            }
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
                $context.Response.StatusCode = 404
                $context.Response.ContentLength64 = 0
                $context.Response.Close()
                continue
            }

            $extension = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
            $context.Response.ContentType = switch ($extension) {
                '.json' { 'application/json; charset=utf-8' }
                '.css'  { 'text/css; charset=utf-8' }
                '.js'   { 'text/javascript; charset=utf-8' }
                default { 'application/octet-stream' }
            }

            $bytes = [System.IO.File]::ReadAllBytes($target)
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.Close()
        } catch {
            try {
                $context.Response.StatusCode = 500
                $context.Response.Close()
            } catch { }
        }
    }
} finally {
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
    Write-Host 'Playground stopped. .playground/ can be deleted at any time.' -ForegroundColor DarkGray
}
