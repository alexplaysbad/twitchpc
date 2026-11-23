param(
  [string]$TaskName = 'TwitchPC Agent'
)

$ErrorActionPreference = 'Stop'
$exePath = Join-Path $PSScriptRoot 'twitchpc-agent.exe'

if (-not (Test-Path $exePath)) {
  throw "Cannot find $exePath"
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$exePath'`"" `
  -WorkingDirectory $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Runs the TwitchPC agent hidden at logon.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started scheduled task '$TaskName'."
Write-Host "The agent runs hidden. Edit .env in $PSScriptRoot and reboot it from Task Scheduler if needed."
