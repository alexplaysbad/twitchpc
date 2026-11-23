param(
  [string]$TaskName = 'TwitchPC Agent'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' was not installed."
}

Get-CimInstance Win32_Process -Filter "Name = 'TwitchPC Agent.exe' OR Name = 'twitchpc-agent.exe'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Legacy fallback for installs using the old PowerShell tray script.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like '*twitchpc-tray.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\TwitchPC'
if (Test-Path $startMenuDir) {
  Remove-Item -Path $startMenuDir -Recurse -Force
  Write-Host 'Removed the Start Menu shortcut.'
}

Write-Host 'TwitchPC tray app uninstalled. The release folder and .env were left in place.'
