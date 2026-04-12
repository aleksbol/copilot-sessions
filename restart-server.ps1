# restart-server.ps1
# Stops the running copilot-sessions server and starts it again.
# Safe to run even while connected through the server - the script is a
# separate process and will survive the server being killed.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { [int]$env:PORT } else { 3847 }
$logFile = Join-Path $scriptDir "restart-server.log"

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

Log "=== Restart started ==="
Log "Script dir: $scriptDir"
Log "Port: $port"

# --- Stop existing server ---

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1

if ($conn) {
    $serverPid = $conn.OwningProcess
    Log "Found process PID $serverPid listening on port $port. Stopping..."

    # Also kill the parent process (typically cmd.exe running the batch launcher)
    # to avoid the "Terminate batch job (Y/N)?" prompt blocking the log file.
    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue).ParentProcessId
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    if ($parentPid -and $parentPid -gt 4) {
        Start-Sleep -Milliseconds 200
        Stop-Process -Id $parentPid -Force -ErrorAction SilentlyContinue
        Log "Killed parent PID $parentPid"
    }
    # Wait until the port is free
    $waited = 0
    while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and $waited -lt 20) {
        Start-Sleep -Milliseconds 500
        $waited++
    }
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Log "WARNING: Port $port still in use after waiting. Proceeding anyway..."
    } else {
        Log "Port $port is now free."
    }
} else {
    Log "No process found listening on port $port - starting fresh."
}

# --- Start server ---

# Locate npm.cmd explicitly - npm resolves to npm.ps1 in PowerShell which
# cmd.exe cannot run, so we use the .cmd shim directly.
$npmCmd = Join-Path (Split-Path (Get-Command npm -ErrorAction SilentlyContinue).Source) "npm.cmd"
if (-not (Test-Path $npmCmd)) { $npmCmd = "npm.cmd" }
Log "Using npm: $npmCmd"

# Write a temp batch file to handle redirection reliably.
# Start-Process does not use a shell, so '>' in -ArgumentList is not
# interpreted as redirection. A batch file avoids that entirely.
$stdoutLog = Join-Path $scriptDir "restart-server-stdout.log"
$batFile   = Join-Path $env:TEMP "copilot-restart-$port.bat"
@"
@echo off
"$npmCmd" run dev > "$stdoutLog" 2>&1
"@ | Set-Content -Path $batFile -Encoding ASCII
Log "Wrote launcher batch: $batFile"
Log "Launching server (stdout -> $stdoutLog)..."
$proc = Start-Process -FilePath $batFile `
              -WorkingDirectory $scriptDir `
              -WindowStyle Normal `
              -PassThru
Log "Launched PID: $($proc.Id)"

# Poll until the port is listening (up to 30 seconds)
$maxWait = 30
$elapsed = 0
Log "Waiting for server to come up on port $port (up to $maxWait s)..."
while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds 1
    $elapsed++
    $up = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($up) {
        Log "Server is up on port $port after ${elapsed}s."
        break
    }
}

if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    Log "ERROR: Server did not come up on port $port within ${maxWait}s."
    Log "Check restart-server-stdout.log for server output."
} else {
    Log "=== Restart complete ==="
}
