[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Codex Bridge Web"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$entryPoint = Join-Path $repositoryRoot "dist\index.js"
$starter = Join-Path $PSScriptRoot "win-start-bridge.ps1"
$environmentFile = Join-Path $repositoryRoot ".env.bridge"
$stateFile = Join-Path $repositoryRoot "workspaces\win-bridge-process.json"

function Test-CommandLineContains {
  param(
    [AllowNull()]
    [string]$CommandLine,
    [string]$Expected
  )

  return $null -ne $CommandLine -and
    $CommandLine.IndexOf($Expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$processesBefore = @(Get-CimInstance Win32_Process)
$bridgeProcessIds = @(
  $processesBefore | Where-Object {
    ($_.Name -eq "node.exe" -and (Test-CommandLineContains -CommandLine $_.CommandLine -Expected $entryPoint)) -or
    ($_.Name -eq "powershell.exe" -and (Test-CommandLineContains -CommandLine $_.CommandLine -Expected $starter))
  } | ForEach-Object { [int]$_.ProcessId }
)

if ($null -ne $task) {
  $taskAction = $task.Actions[0]
  $taskMarker = if ([string]::IsNullOrWhiteSpace($taskAction.Arguments)) {
    $taskAction.Execute
  } else {
    $taskAction.Arguments
  }
  $bridgeProcessIds += @(
    $processesBefore | Where-Object {
      Test-CommandLineContains -CommandLine $_.CommandLine -Expected $taskMarker
    } | ForEach-Object { [int]$_.ProcessId }
  )
}

if (Test-Path -LiteralPath $environmentFile -PathType Leaf) {
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
    if ($null -ne $health -and $health.status -eq "ok") {
      $bridgeProcessIds += @(
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
          ForEach-Object { [int]$_.OwningProcess }
      )
    }
  } catch {}
}

$bridgeProcessIds = @($bridgeProcessIds | Sort-Object -Unique)
do {
  $countBefore = $bridgeProcessIds.Count
  $childIds = @(
    $processesBefore | Where-Object {
      $bridgeProcessIds -contains [int]$_.ParentProcessId
    } | ForEach-Object { [int]$_.ProcessId }
  )
  $bridgeProcessIds = @($bridgeProcessIds + $childIds | Sort-Object -Unique)
} while ($bridgeProcessIds.Count -gt $countBefore)

if ($null -ne $task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
foreach ($processId in ($bridgeProcessIds | Sort-Object -Descending)) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

if ($null -ne $task) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue

if ($null -eq $task -and $bridgeProcessIds.Count -eq 0) {
  Write-Host "Bridge was not running and autostart was not registered."
} else {
  Write-Host "Bridge was stopped and autostart was removed."
}
