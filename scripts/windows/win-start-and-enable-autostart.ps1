[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Codex Bridge Web"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$starter = Join-Path $PSScriptRoot "win-start-bridge.ps1"
$entryPoint = Join-Path $repositoryRoot "dist\index.js"
$environmentFile = Join-Path $repositoryRoot ".env.bridge"
$stateFile = Join-Path $repositoryRoot "workspaces\win-bridge-process.json"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

function Test-BridgeRunning {
  if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
    try {
      $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
      $processId = [int]$state.bridgeProcessId
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
      if (
        $null -ne $process -and
        $process.Name -eq "node.exe" -and
        $null -ne $process.CommandLine -and
        $process.CommandLine.IndexOf($entryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0
      ) {
        return $true
      }
    } catch {}
  }

  if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    return $false
  }

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

if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) {
  throw "Missing Bridge starter: $starter"
}
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
  throw "Windows PowerShell was not found: $windowsPowerShell"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$quotedStarter = '"' + $starter + '"'
$actionArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedStarter"
$action = New-ScheduledTaskAction `
  -Execute $windowsPowerShell `
  -Argument $actionArguments `
  -WorkingDirectory $repositoryRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal `
  -UserId $identity `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 20 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Start Codex Bridge from this repository when the current user logs on." `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
if ((Test-BridgeRunning) -or ([string]$task.State -eq "Running")) {
  Write-Host "Bridge is already running. Autostart was updated without starting another instance."
  exit 0
}

Start-ScheduledTask -TaskName $taskName
Write-Host "Bridge autostart is enabled and the scheduled task was started."
