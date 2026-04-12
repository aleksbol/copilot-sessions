<#
.SYNOPSIS
  Wrapper that registers a command with the process tracker, runs it, and updates status on completion.
.USAGE
  powershell -File track-process.ps1 -Id "my-deploy" -Name "Deploy to prod" -Command "npm run deploy"
#>
param(
  [Parameter(Mandatory)][string]$Id,
  [Parameter(Mandatory)][string]$Name,
  [Parameter(Mandatory)][string]$Command
)

$apiBase = "http://localhost:3847/api/processes"

function Update-Tracker {
  param([hashtable]$Body)
  try {
    $json = $Body | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $apiBase -Method POST -ContentType "application/json" -Body $json | Out-Null
  } catch {
    Write-Warning "Failed to update tracker: $_"
  }
}

# Register as running
Update-Tracker @{ id = $Id; name = $Name; command = $Command; status = "running" }

# Run the command and capture output
$exitCode = 0
$lastLines = ""
try {
  $output = Invoke-Expression $Command 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Output $line
    $lastLines = $line
    # Update tracker with latest output every line
    Update-Tracker @{ id = $Id; lastOutput = $line }
  }
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode) { $exitCode = 0 }
} catch {
  $exitCode = 1
  $lastLines = $_.ToString()
  Write-Error $_
}

# Update final status
$status = if ($exitCode -eq 0) { "done" } else { "failed" }
Update-Tracker @{ id = $Id; status = $status; lastOutput = $lastLines; exitCode = $exitCode }

Write-Output "`n[$status] Process '$Name' finished with exit code $exitCode"
exit $exitCode
