<#
.SYNOPSIS
    Windows operator smoke — mechanical evidence collector.

.DESCRIPTION
    Collects the process-tree / docker-inventory / installer-checksum
    evidence the `windows_smoke_evidence_template.md` requires. Does
    NOT decide whether the smoke passed — that's the operator's
    responsibility after visually confirming every checklist step.

    Every collected file is sanitized: no environment variable dump,
    no session token, no Coinbase credential. If this script is ever
    extended, the extension MUST NOT emit any of those.

.PARAMETER OutputDir
    Directory where the evidence files are written.

.PARAMETER InstallerPath
    Path to the downloaded `Horizon Trade Setup.exe`. Optional; when
    absent, the installer-checksum step is skipped with a warning.

.EXAMPLE
    .\verify-windows-install.ps1 -OutputDir C:\horizon-smoke\evidence -InstallerPath C:\Downloads\Horizon-Trade-Setup.exe
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [Parameter(Mandatory = $false)][string]$InstallerPath = $null,
    [Parameter(Mandatory = $false)][string]$InstallDir = "$env:LOCALAPPDATA\Programs\Horizon Trade"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$now = (Get-Date).ToUniversalTime().ToString('o')
$runInfo = [ordered]@{
    tool          = 'verify-windows-install.ps1'
    version       = '1.0'
    runStartedAt  = $now
    osProduct     = (Get-CimInstance Win32_OperatingSystem).Caption
    osBuild       = [System.Environment]::OSVersion.Version.ToString()
    hostName      = 'REDACTED_HOSTNAME'  # never emit the real hostname — operator can add manually
    installDir    = $InstallDir
    installerPath = $InstallerPath
}
$runInfo | ConvertTo-Json -Depth 3 | Out-File -FilePath (Join-Path $OutputDir 'run-info.json') -Encoding utf8

# --------------------------------------------------------------------
# Installer checksum
# --------------------------------------------------------------------

if ($InstallerPath -and (Test-Path $InstallerPath)) {
    $hash = Get-FileHash -Path $InstallerPath -Algorithm SHA256
    "SHA256=$($hash.Hash)" | Out-File -FilePath (Join-Path $OutputDir 'installer-checksum.txt') -Encoding ascii
} else {
    Write-Warning "InstallerPath not supplied — skipping installer checksum step"
    "SKIPPED: no installer path" | Out-File -FilePath (Join-Path $OutputDir 'installer-checksum.txt') -Encoding ascii
}

# --------------------------------------------------------------------
# Install directory tree
# --------------------------------------------------------------------

if (Test-Path $InstallDir) {
    Get-ChildItem -Path $InstallDir -Recurse -Name |
        Out-File -FilePath (Join-Path $OutputDir 'install-tree.txt') -Encoding utf8
} else {
    "install directory not present at $InstallDir" |
        Out-File -FilePath (Join-Path $OutputDir 'install-tree.txt') -Encoding utf8
}

# --------------------------------------------------------------------
# Process tree — Horizon + Electron ONLY, no full env dump
# --------------------------------------------------------------------

Get-Process |
    Where-Object { $_.Name -like 'horizon*' -or $_.Name -like 'electron*' -or $_.Name -eq 'node' } |
    Select-Object Id, Name, StartTime, CPU, WorkingSet |
    Format-Table -AutoSize |
    Out-String |
    Out-File -FilePath (Join-Path $OutputDir 'process-tree.txt') -Encoding utf8

# --------------------------------------------------------------------
# Docker inventory — filter to horizon-owned ONLY. Do NOT touch other containers.
# --------------------------------------------------------------------

function Invoke-DockerCommand([string]$args) {
    try {
        $out = & docker $args.Split() 2>&1
        return $out
    } catch {
        return "docker unavailable: $_"
    }
}

Invoke-DockerCommand 'version --format {{json .}}' |
    Out-File -FilePath (Join-Path $OutputDir 'docker-version.txt') -Encoding utf8
Invoke-DockerCommand 'ps -a --filter label=owner=horizon --format {{.Names}}\t{{.Image}}\t{{.Status}}' |
    Out-File -FilePath (Join-Path $OutputDir 'docker-ps.txt') -Encoding utf8
Invoke-DockerCommand 'network ls --filter label=owner=horizon --format {{.Name}}\t{{.Driver}}' |
    Out-File -FilePath (Join-Path $OutputDir 'docker-networks.txt') -Encoding utf8
Invoke-DockerCommand 'volume ls --filter label=owner=horizon --format {{.Name}}\t{{.Driver}}' |
    Out-File -FilePath (Join-Path $OutputDir 'docker-volumes.txt') -Encoding utf8

# --------------------------------------------------------------------
# Sanity: assert we did NOT emit env vars or secrets
# --------------------------------------------------------------------

$forbiddenPatterns = @('COINBASE', 'password=', 'JWT_SECRET', 'BEARER', 'BOOTSTRAP_TOKEN')
$outputs = Get-ChildItem -Path $OutputDir -File
$violations = @()
foreach ($file in $outputs) {
    $content = Get-Content -Path $file.FullName -Raw
    foreach ($pattern in $forbiddenPatterns) {
        if ($content -match $pattern) {
            $violations += "$($file.Name) contains forbidden pattern: $pattern"
        }
    }
}
if ($violations.Count -gt 0) {
    Write-Error ("Evidence SANITIZATION FAILED — refusing to keep output:`n" + ($violations -join "`n"))
    exit 3
}

Write-Host "Evidence collected in $OutputDir" -ForegroundColor Green
Write-Host "Attach these files to windows_smoke_evidence_template.md."
Write-Host "This script did NOT confirm any checklist step passed — that is the operator's responsibility."
