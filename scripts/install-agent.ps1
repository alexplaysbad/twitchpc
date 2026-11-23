param(
  [string]$TaskName = 'TwitchPC Agent'
)

$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'TwitchPC Agent.exe'
$corePath = Join-Path $PSScriptRoot 'twitchpc-agent.exe'

foreach ($required in @($launcherPath, $corePath)) {
  if (-not (Test-Path $required)) {
    throw "Cannot find $required"
  }
}

$action = New-ScheduledTaskAction `
  -Execute $launcherPath `
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
  -Description 'Runs the TwitchPC agent tray application at logon.' `
  -Force | Out-Null

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\TwitchPC'
New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
$shortcutPath = Join-Path $startMenuDir 'TwitchPC Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = "$launcherPath,0"
$shortcut.Description = 'TwitchPC agent tray application'
$shortcut.Save()

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started '$TaskName'."
Write-Host 'The agent runs in the system tray. Right-click the tray icon to pause commands, open settings, restart, or exit.'
Write-Host 'You can also reopen it from Start Menu > TwitchPC > TwitchPC Agent.'
