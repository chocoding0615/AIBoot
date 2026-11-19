param([ValidateSet('Process','Maintenance')][string]$Mode='Process',[uint32]$PidValue=0)
$ErrorActionPreference='Stop'
try {
 if($Mode -eq 'Maintenance'){
  $tasks=@()
  foreach($name in @('AIBoot-DualReport-morning','AIBoot-DualReport-afternoon','AIBoot-ExtraReports')){
   try {$t=Get-ScheduledTask -TaskName $name -ErrorAction Stop;$tasks+=@{name=$name;disabled=([string]$t.State -eq 'Disabled')}}
   catch {if($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName*' -or $_.FullyQualifiedErrorId -like '*NoMatchingTasksFound*'){$tasks+=@{name=$name;disabled=$true;absent=$true}}else{throw}}
  }
  @{verified=$true;tasksDisabled=(@($tasks|Where-Object{-not $_.disabled}).Count -eq 0);tasks=$tasks}|ConvertTo-Json -Depth 5 -Compress
  exit
 }
 if($PidValue -lt 1){throw 'Invalid PID'}
 $all=@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate)
 $p=@($all|Where-Object{$_.ProcessId -eq $PidValue})
 $known=@([uint32]$PidValue);$children=@()
 do {
  $found=@($all|Where-Object{$known -contains [uint32]$_.ParentProcessId -and $known -notcontains [uint32]$_.ProcessId})
  foreach($child in $found){$known+=[uint32]$child.ProcessId;$children+=[uint32]$child.ProcessId}
 }while($found.Count -gt 0)
 if($p.Count -eq 0){@{state='dead';birth=$null;descendants=$children}|ConvertTo-Json -Depth 4 -Compress}
 elseif($p.Count -eq 1 -and $p[0].CreationDate){@{state='alive';birth=$p[0].CreationDate.ToUniversalTime().Ticks.ToString();descendants=$children}|ConvertTo-Json -Depth 4 -Compress}
 else {throw 'Identity unavailable'}
}catch {@{state='unknown';birth=$null;descendants=@();verified=$false;tasksDisabled=$false}|ConvertTo-Json -Compress}
