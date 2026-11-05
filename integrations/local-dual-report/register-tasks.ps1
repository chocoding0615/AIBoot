# Registers AIBoot dual report tasks (Mon-Fri 09:30 / 16:00 KST, retry every 15 min for 75 min).
# Runs only while this user is logged on (Codex/Antigravity use this user's subscription logins).
# Remove: Unregister-ScheduledTask -TaskName 'AIBoot-DualReport-*' -Confirm:$false
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$runner = Join-Path $PSScriptRoot 'runner.mjs'
foreach ($s in @(@{ Slot = 'morning'; At = '09:30' }, @{ Slot = 'afternoon'; At = '16:00' })) {
  $name = "AIBoot-DualReport-$($s.Slot)"
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$runner`" --slot $($s.Slot)" -WorkingDirectory $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $s.At
  $repeat = New-ScheduledTaskTrigger -Once -At $s.At -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Minutes 75)
  $trigger.Repetition = $repeat.Repetition
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'AIBoot: Codex/Antigravity independent fixed-expense report to Google Chat (read-only sheet). Trial window in ~/.aiboot/config.json' -Force | Out-Null
  Write-Output "registered $name"
}
