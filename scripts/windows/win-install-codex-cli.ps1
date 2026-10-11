[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$installerUri = "https://chatgpt.com/codex/install.ps1"
$installerPath = Join-Path `
  ([System.IO.Path]::GetTempPath()) `
  ("codex-install-" + [Guid]::NewGuid().ToString("N") + ".ps1")
$windowsPowerShell = Join-Path `
  $env:SystemRoot `
  "System32\WindowsPowerShell\v1.0\powershell.exe"

function Update-ProcessPath {
  $pathEntries = @(
    [Environment]::GetEnvironmentVariable("Path", "Machine"),
    [Environment]::GetEnvironmentVariable("Path", "User"),
    $env:Path
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  $env:Path = ($pathEntries -join ";")
}

function Resolve-CodexExecutable {
  $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($null -ne $codexCommand) {
    return $codexCommand.Source
  }

  $knownPaths = @(
    (Join-Path $env:USERPROFILE ".local\bin\codex.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe")
  )
  foreach ($knownPath in $knownPaths) {
    if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
      return $knownPath
    }
  }

  throw "Codex was installed, but codex.exe could not be found. Open a new PowerShell window and run 'codex --version'."
}

if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
  throw "Windows PowerShell was not found: $windowsPowerShell"
}

try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor `
    [Net.SecurityProtocolType]::Tls12

  Write-Host "Downloading the official Codex CLI installer from $installerUri"
  Invoke-WebRequest `
    -Uri $installerUri `
    -UseBasicParsing `
    -OutFile $installerPath

  if ((Get-Item -LiteralPath $installerPath).Length -eq 0) {
    throw "The official Codex CLI installer download was empty."
  }

  $env:CODEX_NON_INTERACTIVE = "1"
  & $windowsPowerShell `
    -NoLogo `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -File $installerPath
  if ($LASTEXITCODE -ne 0) {
    throw "The official Codex CLI installer exited with code $LASTEXITCODE."
  }

  Update-ProcessPath
  $codexExecutable = Resolve-CodexExecutable
  $version = & $codexExecutable --version
  if ($LASTEXITCODE -ne 0) {
    throw "Codex CLI was installed, but version verification failed with code $LASTEXITCODE."
  }

  Write-Host "Codex CLI is ready: $version"
  Write-Host "Executable: $codexExecutable"
} finally {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
