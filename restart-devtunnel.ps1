param(
    [Parameter(Mandatory=$true)]
    [string]$TunnelName,

    [int]$RestartHours = 20
)

Write-Host "DevTunnel auto-restart for '$TunnelName' every $RestartHours hours"
Write-Host "Press Ctrl+C to stop"

while ($true) {
    $start = Get-Date
    Write-Host "`n[$start] Starting devtunnel host $TunnelName ..."

    $proc = Start-Process -FilePath "devtunnel" -ArgumentList "host", $TunnelName -PassThru -NoNewWindow

    # Wait up to $RestartHours, checking every 30s if it exited early
    $deadline = $start.AddHours($RestartHours)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            Write-Host "[$(Get-Date)] devtunnel exited unexpectedly (code $($proc.ExitCode)). Restarting in 10s..."
            Start-Sleep -Seconds 10
            break
        }
        Start-Sleep -Seconds 30
    }

    # If still running after deadline, kill and restart
    if (-not $proc.HasExited) {
        Write-Host "[$(Get-Date)] $RestartHours hours reached. Recycling..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(5000) | Out-Null
        Start-Sleep -Seconds 5
    }
}
