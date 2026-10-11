[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$entryPoint = Join-Path $repositoryRoot "dist\index.js"
$environmentFile = Join-Path $repositoryRoot ".env.bridge"
$runtimeDirectory = Join-Path $repositoryRoot "workspaces"
$stateFile = Join-Path $runtimeDirectory "win-bridge-process.json"
$mutexName = "Global\CodexBridge"
$mutex = $null
$mutexOwned = $false
$exitCode = 1

function Resolve-NodeExecutable {
  $voltaNode = Join-Path $env:LOCALAPPDATA "Programs\Volta\node.exe"
  if (Test-Path -LiteralPath $voltaNode -PathType Leaf) {
    return $voltaNode
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $nodeCommand) {
    return $nodeCommand.Source
  }

  throw "node.exe was not found. Install the repository's pinned Node version before starting Bridge."
}

function Test-BridgeHealth {
  $port = 8787
  foreach ($line in (Get-Content -LiteralPath $environmentFile)) {
    if ($line -match '^\s*WEB_PORT\s*=\s*([0-9]+)\s*$') {
      $port = [int]$Matches[1]
      break
    }
  }

  try {
    $health = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$port/api/web/health" `
      -TimeoutSec 2 `
      -ErrorAction Stop
    return $null -ne $health -and $health.status -eq "ok"
  } catch {
    return $false
  }
}

function Remove-OwnedStateFile {
  if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
    return
  }

  try {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ([int]$state.wrapperProcessId -eq $PID) {
      Remove-Item -LiteralPath $stateFile -Force
    }
  } catch {
    Write-Warning "Could not clean the Bridge process state file: $($_.Exception.Message)"
  }
}

try {
  if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Missing $entryPoint. Run 'yarn install --immutable' and 'yarn build' first."
  }
  if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Missing $environmentFile. Create the Windows Bridge configuration before starting."
  }

  if (Test-BridgeHealth) {
    throw "Bridge is already responding on its configured Web port. A second Bridge instance was not started."
  }

  New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  try {
    $mutexOwned = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $mutexOwned = $true
  }

  if (-not $mutexOwned) {
    throw "Bridge is already running. A second Bridge instance was not started."
  }

  $nodeExecutable = Resolve-NodeExecutable
  $env:DOTENV_CONFIG_PATH = $environmentFile

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeExecutable
  $startInfo.Arguments = '"' + $entryPoint + '"'
  $startInfo.WorkingDirectory = $repositoryRoot
  $startInfo.UseShellExecute = $false

  $bridgeProcess = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $bridgeProcess) {
    throw "node.exe did not return a Bridge process."
  }

  [ordered]@{
    repositoryRoot = $repositoryRoot
    entryPoint = $entryPoint
    wrapperProcessId = $PID
    bridgeProcessId = $bridgeProcess.Id
    startedAt = [DateTimeOffset]::Now.ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8

  Write-Host "Bridge started (PID $($bridgeProcess.Id)). Press Ctrl+C to stop it."
  $bridgeProcess.WaitForExit()
  $exitCode = $bridgeProcess.ExitCode
} catch {
  Write-Error $_.Exception.Message -ErrorAction Continue
  $exitCode = 1
} finally {
  Remove-OwnedStateFile
  if ($mutexOwned -and $null -ne $mutex) {
    try {
      $mutex.ReleaseMutex()
    } catch {}
  }
  if ($null -ne $mutex) {
    $mutex.Dispose()
  }
}

exit $exitCode
