[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$packageFile = Join-Path $repositoryRoot "package.json"
$voltaVersion = "2.0.2"
$voltaInstallerSha256 = "104bf5518177990e4c4de78097caa747eb8f64e1149bfdfa9106f4a3d3e5f10b"
$voltaInstallerUri = `
  "https://github.com/volta-cli/volta/releases/download/v$voltaVersion/volta-$voltaVersion-windows-x86_64.msi"
$voltaInstallerPath = Join-Path `
  ([System.IO.Path]::GetTempPath()) `
  ("volta-$voltaVersion-" + [Guid]::NewGuid().ToString("N") + ".msi")

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  Write-Host $Description
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Resolve-VoltaExecutable {
  $knownPath = Join-Path $env:LOCALAPPDATA "Programs\Volta\volta.exe"
  if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
    return $knownPath
  }

  $voltaCommand = Get-Command volta.exe -ErrorAction SilentlyContinue
  if ($null -ne $voltaCommand) {
    return $voltaCommand.Source
  }

  return $null
}

function Resolve-VoltaShim {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $knownPath = Join-Path $env:LOCALAPPDATA ("Programs\Volta\" + $Name)
  if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
    return $knownPath
  }

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }

  throw "Volta installed the toolchain, but $Name could not be found."
}

if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
  throw "Missing package.json beside this script: $packageFile"
}

$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
$nodeVersion = [string]$package.volta.node
$packageManager = [string]$package.packageManager
if ([string]::IsNullOrWhiteSpace($nodeVersion)) {
  throw "package.json does not declare volta.node."
}
if ($packageManager -notmatch '^yarn@(?<version>[0-9]+(?:\.[0-9]+){2})$') {
  throw "package.json does not declare a supported yarn packageManager version."
}
$yarnVersion = $Matches.version

$voltaExecutable = Resolve-VoltaExecutable
try {
  if ($null -eq $voltaExecutable) {
    [Net.ServicePointManager]::SecurityProtocol = `
      [Net.ServicePointManager]::SecurityProtocol -bor `
      [Net.SecurityProtocolType]::Tls12

    Write-Host "Downloading Volta $voltaVersion from its official GitHub release."
    Invoke-WebRequest `
      -Uri $voltaInstallerUri `
      -UseBasicParsing `
      -OutFile $voltaInstallerPath

    $actualHash = (Get-FileHash -LiteralPath $voltaInstallerPath -Algorithm SHA256).Hash
    if ($actualHash -ne $voltaInstallerSha256) {
      throw "Volta installer SHA-256 did not match the pinned release."
    }

    $msiArguments = `
      "/i `"$voltaInstallerPath`" /qn /norestart ALLUSERS=2 MSIINSTALLPERUSER=1"
    $installer = Start-Process `
      -FilePath "msiexec.exe" `
      -ArgumentList $msiArguments `
      -Wait `
      -PassThru
    if ($installer.ExitCode -ne 0 -and $installer.ExitCode -ne 3010) {
      throw "Volta installer failed with exit code $($installer.ExitCode)."
    }

    $voltaExecutable = Resolve-VoltaExecutable
    if ($null -eq $voltaExecutable) {
      throw "Volta installation finished, but volta.exe could not be found."
    }
  }

  Invoke-CheckedCommand `
    -FilePath $voltaExecutable `
    -Arguments @("install", "node@$nodeVersion") `
    -Description "Installing Node $nodeVersion with Volta."
  Invoke-CheckedCommand `
    -FilePath $voltaExecutable `
    -Arguments @("install", "yarn@$yarnVersion") `
    -Description "Installing Yarn $yarnVersion with Volta."

  $nodeExecutable = Resolve-VoltaShim -Name "node.exe"
  $yarnExecutable = Resolve-VoltaShim -Name "yarn.cmd"
  $actualNodeVersion = ([string](& $nodeExecutable --version)).Trim().TrimStart("v")
  if ($LASTEXITCODE -ne 0 -or $actualNodeVersion -ne $nodeVersion) {
    throw "Expected Node $nodeVersion, but found $actualNodeVersion."
  }
  $actualYarnVersion = ([string](& $yarnExecutable --version)).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualYarnVersion -ne $yarnVersion) {
    throw "Expected Yarn $yarnVersion, but found $actualYarnVersion."
  }

  Push-Location $repositoryRoot
  try {
    Invoke-CheckedCommand `
      -FilePath $yarnExecutable `
      -Arguments @("install", "--immutable") `
      -Description "Installing the locked Bridge dependencies."
    Invoke-CheckedCommand `
      -FilePath $yarnExecutable `
      -Arguments @("native:rebuild") `
      -Description "Rebuilding the Bridge native dependency for the pinned Node version."
    Invoke-CheckedCommand `
      -FilePath $yarnExecutable `
      -Arguments @("build") `
      -Description "Building Bridge."
  } finally {
    Pop-Location
  }

  Write-Host "Bridge dependencies and build are ready."
  Write-Host "Node: $actualNodeVersion"
  Write-Host "Yarn: $actualYarnVersion"
  Write-Host "Repository: $repositoryRoot"
  Write-Host "Bridge was not started or restarted."
} finally {
  Remove-Item -LiteralPath $voltaInstallerPath -Force -ErrorAction SilentlyContinue
}
