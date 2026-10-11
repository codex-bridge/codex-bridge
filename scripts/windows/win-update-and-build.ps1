[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$gitDirectory = Join-Path $repositoryRoot ".git"

function Resolve-GitExecutable {
  $knownPath = Join-Path $env:ProgramFiles "Git\cmd\git.exe"
  if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
    return $knownPath
  }

  $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($null -ne $gitCommand) {
    return $gitCommand.Source
  }

  throw "git.exe was not found. Install Git for Windows before updating Bridge."
}

function Resolve-YarnExecutable {
  $knownPath = Join-Path $env:LOCALAPPDATA "Programs\Volta\yarn.cmd"
  if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
    return $knownPath
  }

  $yarnCommand = Get-Command yarn.cmd -ErrorAction SilentlyContinue
  if ($null -ne $yarnCommand) {
    return $yarnCommand.Source
  }

  throw "yarn.cmd was not found. Run scripts\windows\win-install-bridge-dependencies.ps1 before updating Bridge."
}

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

if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
  throw "The repository root is not a Git checkout: $repositoryRoot"
}

$gitExecutable = Resolve-GitExecutable
$yarnExecutable = Resolve-YarnExecutable
Push-Location $repositoryRoot
try {
  $trackedChanges = @(& $gitExecutable status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Bridge Git worktree."
  }
  if ($trackedChanges.Count -gt 0) {
    throw "Tracked files have local changes. Commit or restore them before updating Bridge."
  }

  Invoke-CheckedCommand `
    -FilePath $gitExecutable `
    -Arguments @("pull", "--ff-only") `
    -Description "Updating the Bridge checkout with a fast-forward-only Git pull."

  Invoke-CheckedCommand `
    -FilePath $yarnExecutable `
    -Arguments @("build") `
    -Description "Building the Bridge backend and Web UI."
} finally {
  Pop-Location
}

Write-Host "Bridge source and production build are up to date."
Write-Host "Bridge was not started or restarted. Restart it explicitly to load this build."
