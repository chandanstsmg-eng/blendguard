# BlendGuard - start the server automatically with Windows, and restart it if it stops.
#
# Run once on the SERVER PC, in PowerShell as administrator, from the BlendGuard folder:
#     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# The task runs as the Windows account you give, from power-on, without anyone
# signing in. If BlendGuard stops on an error it is started again after a minute.
# Remove it with:  Unregister-ScheduledTask -TaskName 'BlendGuard server'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw 'Node.js is not installed (npm not found). Install the LTS version from https://nodejs.org first.' }

$cred = Get-Credential -Message 'Windows account that runs BlendGuard (it owns the data folder). Use the account you installed BlendGuard with.' -UserName "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$npm`" start >> data\logs\service.log 2>&1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'BlendGuard server' -Description 'BlendGuard weighing server (database, screens, scales).' `
  -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

Write-Host "`n  Installed. BlendGuard starts with Windows. Start it now with:  Start-ScheduledTask -TaskName 'BlendGuard server'"
Write-Host "  Its window output goes to data\logs\service.log.`n"
