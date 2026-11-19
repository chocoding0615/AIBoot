param([ValidateSet('Probe','Apply','AccessCheck')][string]$Mode='Probe',[Parameter(Mandatory=$true)][string]$DefinitionFile)
$ErrorActionPreference='Stop'
if($Mode -eq 'AccessCheck') {
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $acl=Get-Acl -LiteralPath $DefinitionFile
 $bad=@($acl.Access | Where-Object { $other=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; $_.AccessControlType -eq 'Allow' -and $other -ne $sid -and $other -ne 'S-1-5-18' })
 ConvertTo-Json -InputObject ($bad.Count -eq 0) -Compress
 exit
}
$taskName='AIBoot-ExtraReports'
$dayNames=@('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')
function Read-Plan {
 try { $t=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like '*NoMatchingTasksFound*' -or $_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName*'){return $null}; throw }
 if($t.Description -notmatch '^AIBoot extra reports v1; version=(\d+)$'){throw 'Unmanaged task name collision'}
 $version=[int]$Matches[1]
 [xml]$xml=Export-ScheduledTask -TaskName $taskName
 $triggers=@(foreach($n in $xml.Task.Triggers.ChildNodes){
  if($n.Enabled -eq 'false' -or $n.LocalName -ne 'CalendarTrigger' -or $n.Repetition -or $n.ScheduleByWeek.WeeksInterval -ne '1'){throw 'Unexpected trigger'}
  $date=[DateTimeOffset]::Parse([string]$n.StartBoundary)
  $days=@($n.ScheduleByWeek.DaysOfWeek.ChildNodes | ForEach-Object { $idx=[Array]::IndexOf($dayNames,$_.LocalName);if($idx -lt 0){throw 'Invalid weekday'};$idx+1 } | Sort-Object)
  [ordered]@{days=$days;time=$date.ToOffset([TimeSpan]::FromHours(9)).ToString('HH:mm');startBoundary=$date.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
 })
 $triggers=@($triggers | Sort-Object time)
 if(@($t.Actions).Count -ne 1){throw 'Unexpected actions'}
 return [ordered]@{task=$taskName;version=$version;executable=[string]$t.Actions[0].Execute;arguments=[string]$t.Actions[0].Arguments;triggers=$triggers;executionTimeLimit=[string]$t.Settings.ExecutionTimeLimit;multipleInstances=[string]$t.Settings.MultipleInstances;enabled=[bool]$t.Settings.Enabled;wakeToRun=[bool]$t.Settings.WakeToRun;startWhenAvailable=[bool]$t.Settings.StartWhenAvailable;interactive=([string]$t.Principal.LogonType -eq 'Interactive');limited=([string]$t.Principal.RunLevel -eq 'Limited')}
}
if($Mode -eq 'Apply'){
 if((Get-TimeZone).Id -ne 'Korea Standard Time'){throw 'KST Windows timezone required'}
 $plan=Get-Content -LiteralPath $DefinitionFile -Raw -Encoding UTF8 | ConvertFrom-Json
 $existing=Read-Plan
 if($null -eq $plan){
  if($existing){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
 }else{
  if($plan.task -ne $taskName -or @($plan.triggers).Count -lt 1 -or @($plan.triggers).Count -gt 16){throw 'Invalid plan'}
  if([IO.Path]::GetFileName($plan.executable) -ne 'node.exe' -or -not (Test-Path -LiteralPath $plan.executable)){throw 'Invalid executable'}
  $cli=Join-Path $PSScriptRoot 'cli.mjs'
  if(-not $plan.arguments.StartsWith(('"' + $cli + '" dispatch --plan-version '))){throw 'Invalid action'}
  $triggers=@(foreach($r in $plan.triggers){
   if($r.time -notmatch '^([01]\d|2[0-3]):[0-5]\d$' -or @($r.days).Count -lt 1){throw 'Invalid time'}
   $days=@(foreach($d in $r.days){if($d -lt 1 -or $d -gt 7){throw 'Invalid day'};$dayNames[$d-1]})
   $trigger=New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $r.time
   $trigger.StartBoundary=([DateTimeOffset]::Parse([string]$r.startBoundary)).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-ddTHH:mm:sszzz')
   $trigger
  })
  $action=New-ScheduledTaskAction -Execute $plan.executable -Argument $plan.arguments -WorkingDirectory $PSScriptRoot
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description ("AIBoot extra reports v1; version="+$plan.version) -Force | Out-Null
 }
}
$result=Read-Plan
ConvertTo-Json -InputObject $result -Depth 8 -Compress
