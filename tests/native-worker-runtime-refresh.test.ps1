$ErrorActionPreference = 'Stop'
$installerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'native-bridge\install.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ('WORKER_INSTALLER_PARSE_FAILED:' + $parseErrors[0].Message) }

function Get-InstallerFunction([string]$Name) {
    $node = $ast.Find({ param($candidate)
        $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $candidate.Name -eq $Name
    }, $true)
    if ($null -eq $node) { throw ('WORKER_INSTALLER_FUNCTION_MISSING:' + $Name) }
    return $node.Extent.Text
}

foreach ($name in @('Get-WorkerRuntimeBytesSha256','Get-WorkerRuntimeFileSha256',
    'Resolve-WorkerRuntimeIdentitySid',
    'Write-WorkerRuntimeAtomicReplacement','Get-WorkerRuntimeTaskDefinitionSha256',
    'Get-WorkerRuntimeTaskDefinitionWithoutLogonTriggerSha256','Get-WorkerRuntimeTaskMigrationProjectionSha256',
    'Get-WorkerRuntimeTaskTriggerState',
    'Assert-WorkerRuntimeTaskTimeTriggerMatchesXml',
    'Assert-WorkerRuntimeTaskLogonTriggerMatchesXml',
    'Write-WorkerRuntimeNewFile','Get-TaskOptional','Get-WorkerRuntimeTaskReadback',
    'Add-WorkerRuntimeTaskLogonTrigger','Invoke-WorkerRuntimeTaskLogonTriggerRefresh',
    'Invoke-WorkerRuntimeCommandText',
    'Assert-WorkerRuntimeTrustedRuns','Assert-WorkerRuntimeAcceptedPrAncestry',
    'Get-WorkerRuntimeGitPath')) {
    Invoke-Expression (Get-InstallerFunction $name)
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) {
        throw ('ASSERT_EQUAL_FAILED:' + $Message + ';actual=' + $Actual + ';expected=' + $Expected)
    }
}

function Assert-Throws([scriptblock]$Action, [string]$ExpectedMessage, [string]$Message) {
    $actual = ''
    try { & $Action } catch { $actual = $_.Exception.Message }
    if ($actual -notlike ('*' + $ExpectedMessage + '*')) {
        throw ('ASSERT_THROWS_FAILED:' + $Message + ';actual=' + $actual + ';expected=' + $ExpectedMessage)
    }
}

$installerText = [IO.File]::ReadAllText($installerPath)
$installModeIndex = $installerText.IndexOf('if ($Mode -eq ''Install'')', [StringComparison]::Ordinal)
if ($installModeIndex -lt 0) { throw 'WORKER_INSTALL_MODE_BLOCK_MISSING' }
$installModeBlock = $installerText.Substring($installModeIndex)
if (-not [regex]::IsMatch($installModeBlock, '\$logonTrigger\s*=\s*New-ScheduledTaskTrigger\s+-AtLogOn\s+-User\s+\$username')) { throw 'WORKER_INSTALL_LOGON_TRIGGER_MISSING' }
if (-not $installModeBlock.Contains('-Trigger @($trigger, $logonTrigger)')) { throw 'WORKER_INSTALL_LOGON_TRIGGER_REGISTRATION_MISSING' }
if (-not $installModeBlock.Contains('$taskDefinitionSha256 = Get-WorkerRuntimeTaskDefinitionSha256')) { throw 'WORKER_INSTALL_TASK_DEFINITION_READBACK_MISSING' }
$triggerRefreshModeIndex = $installerText.IndexOf("if (`$Mode -eq 'RefreshTaskLogonTrigger')", [StringComparison]::Ordinal)
if ($triggerRefreshModeIndex -lt 0 -or -not $installerText.Substring($triggerRefreshModeIndex).Contains('Invoke-WorkerRuntimeTaskLogonTriggerRefresh')) {
    throw 'WORKER_TASK_TRIGGER_REFRESH_MODE_MISSING'
}
$triggerRefreshFunction = Get-InstallerFunction 'Invoke-WorkerRuntimeTaskLogonTriggerRefresh'
foreach ($requiredToken in @('Assert-WorkerRuntimeSource','Get-WorkerRuntimeTaskReadback',
    'Write-WorkerRuntimeNewFile','Add-WorkerRuntimeTaskLogonTrigger',
    'MigrationProjectionSha256','AllowLegacyFiniteDuration','WORKER_TASK_REPETITION=UNBOUNDED_VERIFIED',
    'WORKER_RUNTIME_TASK_TRIGGER_UPGRADE_OUTCOME_UNKNOWN')) {
    if (-not $triggerRefreshFunction.Contains($requiredToken)) {
        throw ('WORKER_TASK_TRIGGER_REFRESH_CONTRACT_MISSING:' + $requiredToken)
    }
}
if ($triggerRefreshFunction.Contains('Register-ScheduledTask') -or
    $triggerRefreshFunction.Contains('Unregister-ScheduledTask')) {
    throw 'WORKER_TASK_TRIGGER_REFRESH_MUST_UPDATE_EXISTING_TASK_ONLY'
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase ('pty-worker-runtime-refresh-' + [guid]::NewGuid().ToString('N'))
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'TEST_PATH_OUTSIDE_TEMP'
}
$null = [IO.Directory]::CreateDirectory($testRoot)
try {
    $target = Join-Path $testRoot 'worker.mjs'
    $oldBytes = ([Text.UTF8Encoding]::new($false)).GetBytes('old-complete-bytes')
    $newBytes = ([Text.UTF8Encoding]::new($false)).GetBytes('new-complete-bytes')
    [IO.File]::WriteAllBytes($target, $oldBytes)
    $oldHash = Get-WorkerRuntimeBytesSha256 $oldBytes
    $newHash = Get-WorkerRuntimeBytesSha256 $newBytes

    Write-WorkerRuntimeAtomicReplacement $newBytes $target $oldHash $newHash
    Assert-Equal (Get-WorkerRuntimeFileSha256 $target) $newHash 'atomic publication reads back exact new bytes'
    Assert-Equal ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($target))) 'new-complete-bytes' `
        'atomic publication replaces the complete file contents'
    Assert-Equal (@(Get-ChildItem -LiteralPath $testRoot -Filter '*.worker-refresh-*.tmp' -File).Count) 0 `
        'successful atomic publication removes its temporary file'
    Assert-Equal (@(Get-ChildItem -LiteralPath $testRoot -Filter '*.worker-refresh-backup-*' -File).Count) 0 `
        'successful atomic publication removes its verified adjacent backup'

    Assert-Throws { Write-WorkerRuntimeAtomicReplacement $oldBytes $target $oldHash $oldHash } `
        'WORKER_RUNTIME_ATOMIC_REPLACEMENT_PRESTATE_MISMATCH' 'a stale prestate cannot overwrite a newer file'
    Assert-Equal (Get-WorkerRuntimeFileSha256 $target) $newHash 'stale prestate rejection preserves current bytes'

    Write-WorkerRuntimeAtomicReplacement $oldBytes $target $newHash $oldHash
    Assert-Equal (Get-WorkerRuntimeFileSha256 $target) $oldHash 'the same atomic helper supports exact rollback'

    $taskName = 'PTYSD-Native-OpenCode'
    $wscript = 'C:\Windows\System32\wscript.exe'
    $hiddenWorker = Join-Path $testRoot 'HiddenWorker.vbs'
    $homeDir = $testRoot
    $expectedLogonUser = $env:USERDOMAIN + '\' + $env:USERNAME
    $global:MockWorkerTaskXml = @'
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled><ExecutionTimeLimit>PT15M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable></Settings><Triggers><TimeTrigger><StartBoundary>2026-10-27T00:00:00</StartBoundary><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>true</StopAtDurationEnd></Repetition></TimeTrigger><LogonTrigger><UserId>__EXPECTED_LOGON_USER__</UserId></LogonTrigger></Triggers></Task>
'@
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('__EXPECTED_LOGON_USER__', $expectedLogonUser)
    function global:Export-ScheduledTask {
        [CmdletBinding()]
        param([string]$TaskName, [string]$TaskPath)
        return $global:MockWorkerTaskXml
    }
    function global:Get-ScheduledTask {
        [CmdletBinding()]
        param([string]$TaskName, [string]$TaskPath)
        return @($global:MockWorkerTask)
    }
    function global:New-ScheduledTaskTrigger {
        [CmdletBinding()]
        param([switch]$AtLogOn, [string]$User)
        return [pscustomobject]@{ CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskLogonTrigger' };
            Enabled=$true; UserId=$User }
    }
    function global:Set-ScheduledTask {
        [CmdletBinding()]
        param([string]$TaskName, [string]$TaskPath, [object[]]$Trigger)
        $global:MockSetScheduledTaskCalls += ,([pscustomobject]@{
            TaskName=$TaskName; TaskPath=$TaskPath; Trigger=@($Trigger)
        })
        if (-not $global:MockSchedulerApply) {
            if ($global:MockSchedulerThrowAfterApply) { throw 'MOCK_SET_SCHEDULED_TASK_FAILED_BEFORE_APPLY' }
            return
        }
        $timeTrigger = @($Trigger | Where-Object { $_.CimClass.CimClassName -ceq 'MSFT_TaskTimeTrigger' })[0]
        $logonTrigger = @($Trigger | Where-Object { $_.CimClass.CimClassName -ceq 'MSFT_TaskLogonTrigger' })[0]
        $global:MockWorkerTaskXml = [regex]::Replace($global:MockWorkerTaskXml,
            '<Duration>[^<]*</Duration>', '')
        if ($global:MockWorkerTaskXml -notmatch '<LogonTrigger>') {
            $userXml = [Security.SecurityElement]::Escape([string]$logonTrigger.UserId)
            $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('</Triggers>',
                ('<LogonTrigger><UserId>' + $userXml + '</UserId></LogonTrigger></Triggers>'))
        }
        $global:MockWorkerTask.Triggers = @($Trigger)
        if ($global:MockSchedulerThrowAfterApply) { throw 'MOCK_SET_SCHEDULED_TASK_FAILED_AFTER_APPLY' }
    }

    $global:MockWorkerTask = [pscustomobject]@{
        TaskName=$taskName; TaskPath='\'; State='Disabled'
        Principal=[pscustomobject]@{ UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name;
            LogonType='Interactive'; RunLevel='Limited' }
        Settings=[pscustomobject]@{ Enabled=$false; MultipleInstances='IgnoreNew';
            ExecutionTimeLimit='PT15M'; StartWhenAvailable=$true;
            DisallowStartIfOnBatteries=$false; StopIfGoingOnBatteries=$false }
        Actions=@([pscustomobject]@{ Execute=$wscript; Arguments='//B //NoLogo "' + $hiddenWorker + '"'; WorkingDirectory=$homeDir })
        Triggers=@()
    }
    $timeTrigger = [pscustomobject]@{
        CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskTimeTrigger' }
        Enabled=$true; StartBoundary='2026-10-27T00:00:00'
        Repetition=[pscustomobject]@{ Interval='PT5M'; Duration=''; StopAtDurationEnd=$true }
    }
    $logonTriggerMock = [pscustomobject]@{
        CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskLogonTrigger' }
        Enabled=$true; UserId=$expectedLogonUser
    }
    $global:MockWorkerTask.Triggers = @($timeTrigger,$logonTriggerMock)
    $global:MockSetScheduledTaskCalls = @()
    $global:MockSchedulerApply = $false
    $global:MockSchedulerThrowAfterApply = $false

    $enabledHash = Get-WorkerRuntimeTaskDefinitionSha256
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>')
    $disabledHash = Get-WorkerRuntimeTaskDefinitionSha256
    Assert-Equal $disabledHash $enabledHash 'task definition fingerprint excludes only temporary enabled state'
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace(
        '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 } 'WORKER_RUNTIME_TASK_POWER_POLICY_MISMATCH' `
        'battery power must not suppress the five-minute dispatcher'
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace(
        '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
        '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    $global:MockWorkerTask.Settings.StopIfGoingOnBatteries = $true
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_POWER_POLICY_MISMATCH' 'battery transition must not stop the dispatcher'
    $global:MockWorkerTask.Settings.StopIfGoingOnBatteries = $false
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('PT5M', 'PT10M')
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
        -ExpectedDefinitionSha256 $enabledHash } 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' `
        'task cadence drift is blocked while refresh is disabled'
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('PT10M', 'PT5M')

    $readback = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
        -ExpectedDefinitionSha256 $enabledHash
    Assert-Equal $readback.DefinitionSha256 $enabledHash 'exact task identity reads back with disabled state'
    $global:MockWorkerTask.Triggers[1].Enabled = $false
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_TRIGGER_OBJECT_MISMATCH' 'a disabled logon CIM trigger cannot be reported as enabled recovery'
    $global:MockWorkerTask.Triggers[1].Enabled = $true
    $validTaskXml = $global:MockWorkerTaskXml
    $global:MockWorkerTaskXml = $validTaskXml.Replace(
        '<Interval>PT5M</Interval>', '<Interval>PT5M</Interval><Duration>P3650D</Duration>')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 } 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' `
        'a finite repetition duration is rejected instead of being treated as perpetual'
    $global:MockWorkerTaskXml = $validTaskXml.Replace(
        '<Interval>PT5M</Interval>', '<Interval>PT5M</Interval><Duration></Duration>')
    $null = Get-WorkerRuntimeTaskDefinitionSha256
    $global:MockWorkerTaskXml = $validTaskXml
    $finiteLegacyXml = $validTaskXml.Replace(
        '<Interval>PT5M</Interval>', '<Interval>PT5M</Interval><Duration>P3650D</Duration>')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 -TaskXml $finiteLegacyXml } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'ordinary runtime validation rejects the legacy finite schedule'
    $finiteLegacyState = Get-WorkerRuntimeTaskTriggerState $finiteLegacyXml -AllowLegacyFiniteDuration
    Assert-Equal $finiteLegacyState.RepetitionDuration 'P3650D' 'migration readback identifies only the known finite legacy duration'
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 -AllowLegacyFiniteDuration `
        -TaskXml $finiteLegacyXml.Replace('P3650D','P10D') } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'migration allowance rejects any finite duration other than the exact legacy value'
    $global:MockWorkerTaskXml = [regex]::Replace($validTaskXml, '<LogonTrigger>[\s\S]*?</LogonTrigger>', '')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 } 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'a missing logon recovery trigger blocks refresh'
    $legacyTaskXml = $global:MockWorkerTaskXml
    $legacyState = Get-WorkerRuntimeTaskTriggerState $legacyTaskXml
    Assert-Equal $legacyState.TriggerKind 'LEGACY_TIME_ONLY' 'the dedicated upgrade preflight recognizes the exact legacy shape'
    Assert-Equal $legacyState.DefinitionSha256 (Get-WorkerRuntimeTaskDefinitionSha256 -AllowLegacyTimeOnly -TaskXml $legacyTaskXml) `
        'legacy upgrade preflight returns the exact pinned task definition hash'
    $currentState = Get-WorkerRuntimeTaskTriggerState $validTaskXml
    Assert-Equal $currentState.TriggerKind 'CURRENT_TIME_AND_LOGON' 'a current task definition is classified without modification'
    Assert-Equal $legacyState.WithoutLogonTriggerSha256 $currentState.WithoutLogonTriggerSha256 `
        'adding only the logon trigger preserves the complete remaining task XML'
    $changedScheduleXml = $validTaskXml.Replace('PT5M','PT10M')
    $changedScheduleProjection = Get-WorkerRuntimeTaskDefinitionWithoutLogonTriggerSha256 $changedScheduleXml
    if ($legacyState.WithoutLogonTriggerSha256 -ceq $changedScheduleProjection) {
        throw 'WORKER_TASK_TRIGGER_PROJECTION_MISSED_TIME_SCHEDULE_CHANGE'
    }
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 -TaskXml $legacyTaskXml } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'normal refresh still rejects the legacy trigger shape'
    $global:MockWorkerTaskXml = $validTaskXml.Replace($expectedLogonUser, 'OTHER\unexpected-user')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 } 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'a logon trigger for another account blocks refresh'
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 -AllowLegacyTimeOnly } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'legacy allowance never accepts a wrong-account logon trigger'
    $global:MockWorkerTaskXml = $validTaskXml.Replace('</Triggers>',
        '<BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 } 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'an extra unsupported trigger blocks refresh'
    $global:MockWorkerTaskXml = $validTaskXml
    $global:MockWorkerTask.Triggers = @($timeTrigger)
    Add-WorkerRuntimeTaskLogonTrigger $global:MockWorkerTask $legacyTaskXml
    Assert-Equal $global:MockSetScheduledTaskCalls.Count 1 'the migration updates the existing task exactly once'
    $triggerWrite = $global:MockSetScheduledTaskCalls[0]
    Assert-Equal $triggerWrite.TaskName $taskName 'the migration targets the existing canonical task name'
    Assert-Equal $triggerWrite.TaskPath '\' 'the migration targets the existing root task path'
    Assert-Equal $triggerWrite.Trigger.Count 2 'the update submits exactly the original time trigger and one logon trigger'
    if (-not [object]::ReferenceEquals($triggerWrite.Trigger[0], $timeTrigger)) {
        throw 'WORKER_TASK_TRIGGER_REFRESH_DID_NOT_PRESERVE_ORIGINAL_TIME_TRIGGER_OBJECT'
    }
    Assert-Equal $triggerWrite.Trigger[1].CimClass.CimClassName 'MSFT_TaskLogonTrigger' 'the added trigger is a logon trigger'
    Assert-Equal $triggerWrite.Trigger[1].UserId $expectedLogonUser 'the added trigger is scoped to the current user'
    $finiteLegacyTaskXml = $legacyTaskXml.Replace(
        '<Interval>PT5M</Interval>', '<Interval>PT5M</Interval><Duration>P3650D</Duration>')
    $finiteTimeTrigger = [pscustomobject]@{
        CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskTimeTrigger' }
        Enabled=$true; StartBoundary='2026-10-27T00:00:00'
        Repetition=[pscustomobject]@{ Interval='PT5M'; Duration='P3650D'; StopAtDurationEnd=$true }
    }
    $setCountBeforeFiniteLegacy = $global:MockSetScheduledTaskCalls.Count
    $global:MockWorkerTask.Triggers = @($finiteTimeTrigger)
    Add-WorkerRuntimeTaskLogonTrigger $global:MockWorkerTask $finiteLegacyTaskXml
    Assert-Equal $global:MockSetScheduledTaskCalls.Count ($setCountBeforeFiniteLegacy + 1) `
        'the one-time migration writes the exact known finite legacy trigger once'
    Assert-Equal $finiteTimeTrigger.Repetition.Duration $null 'the migration clears P3650D from the existing trigger object'
    Assert-Equal $global:MockSetScheduledTaskCalls[-1].Trigger.Count 2 `
        'the finite legacy migration adds exactly one logon trigger to the existing task'
    Assert-Equal ([regex]::Matches($global:MockWorkerTaskXml, '<LogonTrigger>')).Count 1 `
        'the finite legacy migration does not duplicate the logon trigger'
    if ($global:MockWorkerTaskXml.Contains('<Duration>')) { throw 'WORKER_TASK_FINITE_DURATION_REMAINS_AFTER_MIGRATION' }
    $global:MockWorkerTask.Triggers = @($timeTrigger)
    $callCountBeforeRejectedTrigger = $global:MockSetScheduledTaskCalls.Count
    $global:MockWorkerTask.Triggers = @($timeTrigger,$triggerWrite.Trigger[1])
    Assert-Throws { Add-WorkerRuntimeTaskLogonTrigger $global:MockWorkerTask $legacyTaskXml } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'a second trigger-add attempt is rejected rather than duplicated'
    Assert-Equal $global:MockSetScheduledTaskCalls.Count $callCountBeforeRejectedTrigger `
        'unsupported or duplicate trigger state causes no scheduler write'
    $global:MockWorkerTask.TaskName = 'OTHER-TASK'
    Assert-Throws { Add-WorkerRuntimeTaskLogonTrigger $global:MockWorkerTask $legacyTaskXml } `
        'WORKER_RUNTIME_TASK_IDENTITY_MISMATCH' 'the trigger write cannot target a different task identity'
    $global:MockWorkerTask.TaskName = $taskName
    $global:MockWorkerTask.Triggers = @([pscustomobject]@{
        CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskBootTrigger' }
    })
    Assert-Throws { Add-WorkerRuntimeTaskLogonTrigger $global:MockWorkerTask $legacyTaskXml } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'the migration refuses a non-time legacy trigger'
    Assert-Equal $global:MockSetScheduledTaskCalls.Count $callCountBeforeRejectedTrigger `
        'wrong identity and unsupported trigger paths make no scheduler write'
    $staleTimeTrigger = [pscustomobject]@{
        CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskTimeTrigger' }
        Enabled=$true; StartBoundary='2026-10-26T00:00:00'
        Repetition=[pscustomobject]@{ Interval='PT5M'; Duration='P3650D'; StopAtDurationEnd=$true }
    }
    $global:MockWorkerTask.Triggers = @($staleTimeTrigger)
    Assert-Throws { Add-WorkerRuntimeTaskLogonTrigger $global:MockWorkerTask $legacyTaskXml } `
        'WORKER_RUNTIME_TASK_TRIGGER_OBJECT_MISMATCH' 'a stale task object cannot overwrite the XML-pinned time schedule'
    Assert-Equal $global:MockSetScheduledTaskCalls.Count $callCountBeforeRejectedTrigger `
        'a stale trigger-object mismatch causes no scheduler write'
    $global:MockWorkerTask.Triggers = @($timeTrigger)
    $disabledLogonXml = $validTaskXml.Replace('<LogonTrigger>', '<LogonTrigger><Enabled>false</Enabled>')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 -TaskXml $disabledLogonXml } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'a disabled logon trigger is not accepted as recovery-ready'
    $disabledTimeXml = $validTaskXml.Replace('<TimeTrigger>', '<TimeTrigger><Enabled>false</Enabled>')
    Assert-Throws { Get-WorkerRuntimeTaskDefinitionSha256 -TaskXml $disabledTimeXml } `
        'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' 'a disabled dispatch time trigger is not accepted'
    $global:MockWorkerTask.Principal.UserId = 'S-1-5-18'
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_MISMATCH' 'a task registered to a different Windows identity blocks refresh'
    $global:MockWorkerTask.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $global:MockWorkerTask.Actions[0].Arguments = 'unexpected action'
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_IDENTITY_MISMATCH' 'refresh refuses a changed scheduled action'
    $global:MockWorkerTask.Actions[0].Arguments = '//B //NoLogo "' + $hiddenWorker + '"'

    # Exercise the dedicated native mode against mocked Task Scheduler and a
    # temp-only backup root. No live task, GitHub source, or OS service is used.
    function Test-GhAuthenticated([string]$GhExe) { return $true }
    function Require-Command([string]$Name) {
        if ($Name -eq 'node.exe') { return $global:MockNodeExecutable }
        return $Name
    }
    function Assert-WorkerRuntimePathChain([string]$Path) { return }
    function Assert-WorkerRuntimeNoActiveProcess([string]$NodePath) { return }
    function Assert-WorkerRuntimeSource([string]$GitExe, [string]$GhExe) { return $testRoot }
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $global:MockNodeExecutable = $nodeCommand.Source
    $expectedHost = $env:COMPUTERNAME.ToUpperInvariant()
    $configPath = Join-Path $testRoot 'config.json'
    $null = [IO.File]::WriteAllText($configPath, '{}', ([Text.UTF8Encoding]::new($false)))
    $null = [IO.File]::WriteAllText($hiddenWorker,
        ('commandLine = """' + $global:MockNodeExecutable + '"""'), ([Text.UTF8Encoding]::new($false)))
    $hiddenWorkerSha256 = Get-WorkerRuntimeFileSha256 $hiddenWorker
    $legacyEnabledXml = $legacyTaskXml.Replace('<Enabled>false</Enabled>', '<Enabled>true</Enabled>')
    $global:MockWorkerTaskXml = $legacyEnabledXml
    $global:MockWorkerTask.State = 'Ready'
    $global:MockWorkerTask.Settings.Enabled = $true
    $global:MockWorkerTask.Triggers = @($timeTrigger)

    $global:MockSchedulerApply = $true
    $preconditionWriteCount = $global:MockSetScheduledTaskCalls.Count
    $global:MockWorkerTask.State = 'Disabled'
    $global:MockWorkerTask.Settings.Enabled = $false
    Assert-Throws { Invoke-WorkerRuntimeTaskLogonTriggerRefresh } `
        'WORKER_RUNTIME_TASK_STATE_READBACK_MISMATCH' 'a disabled task is not silently re-enabled by trigger migration'
    $global:MockWorkerTask.State = 'Running'
    $global:MockWorkerTask.Settings.Enabled = $true
    Assert-Throws { Invoke-WorkerRuntimeTaskLogonTriggerRefresh } `
        'WORKER_RUNTIME_TASK_STATE_READBACK_MISMATCH' 'a running task is not mutated by trigger migration'
    $global:MockWorkerTask.State = 'Ready'
    $global:MockWorkerTask.Principal.UserId = 'S-1-5-18'
    Assert-Throws { Invoke-WorkerRuntimeTaskLogonTriggerRefresh } `
        'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_MISMATCH' 'a different task principal blocks trigger migration'
    Assert-Equal $global:MockSetScheduledTaskCalls.Count $preconditionWriteCount `
        'disabled, running, and wrong-principal tasks produce no scheduler writes'
    $global:MockWorkerTask.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $global:MockWorkerTask.State = 'Ready'
    $global:MockWorkerTask.Settings.Enabled = $true

    $global:MockSchedulerThrowAfterApply = $false
    $setCountBeforeMode = $global:MockSetScheduledTaskCalls.Count
    $modeOutput = (Invoke-WorkerRuntimeTaskLogonTriggerRefresh | Out-String)
    Assert-Equal $global:MockSetScheduledTaskCalls.Count ($setCountBeforeMode + 1) `
        'the native migration performs one Task Scheduler write for the legacy task'
    if (-not $modeOutput.Contains('WORKER_TASK_LOGON_TRIGGER=ADDED_FOR_CURRENT_USER')) {
        throw 'WORKER_TASK_TRIGGER_REFRESH_SUCCESS_READBACK_MISSING'
    }
    $backupPathLine = @($modeOutput -split "`r?`n" | Where-Object { $_.StartsWith('WORKER_TASK_BACKUP=') })[0]
    $backupPath = $backupPathLine.Substring('WORKER_TASK_BACKUP='.Length)
    Assert-Equal ([IO.File]::ReadAllText($backupPath)) $legacyEnabledXml `
        'the migration preserves the exact pre-change task XML in its backup'
    $backupHashLine = @($modeOutput -split "`r?`n" | Where-Object { $_.StartsWith('WORKER_TASK_BACKUP_SHA256=') })[0]
    Assert-Equal (Get-WorkerRuntimeFileSha256 $backupPath) $backupHashLine.Substring('WORKER_TASK_BACKUP_SHA256='.Length) `
        'the migration reads back the backup hash from the written file'
    Assert-Equal (Get-WorkerRuntimeTaskTriggerState $global:MockWorkerTaskXml).TriggerKind `
        'CURRENT_TIME_AND_LOGON' 'the migration reads back the current task trigger shape'
    $backupCountAfterUpgrade = @(Get-ChildItem -LiteralPath (Join-Path $homeDir 'backups') -Filter '*.xml' -File).Count

    $setCountBeforeIdempotency = $global:MockSetScheduledTaskCalls.Count
    $idempotentOutput = (Invoke-WorkerRuntimeTaskLogonTriggerRefresh | Out-String)
    Assert-Equal $global:MockSetScheduledTaskCalls.Count $setCountBeforeIdempotency `
        'an already-upgraded task does not receive another scheduler write'
    if (-not $idempotentOutput.Contains('WORKER_TASK_LOGON_TRIGGER=ALREADY_PRESENT_NO_CHANGE')) {
        throw 'WORKER_TASK_TRIGGER_REFRESH_IDEMPOTENT_READBACK_MISSING'
    }
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $homeDir 'backups') -Filter '*.xml' -File).Count `
        $backupCountAfterUpgrade 'an idempotent read does not create another backup'

    # Upgrade the exact current task shape in place: preserve its existing
    # current-user logon trigger and remove only the known P3650D timeout.
    $currentFiniteXml = $validTaskXml.Replace(
        '<Interval>PT5M</Interval>', '<Interval>PT5M</Interval><Duration>P3650D</Duration>')
    $currentFiniteTimeTrigger = [pscustomobject]@{
        CimClass=[pscustomobject]@{ CimClassName='MSFT_TaskTimeTrigger' }
        Enabled=$true; StartBoundary='2026-10-27T00:00:00'
        Repetition=[pscustomobject]@{ Interval='PT5M'; Duration='P3650D'; StopAtDurationEnd=$true }
    }
    $global:MockWorkerTaskXml = $currentFiniteXml
    $global:MockWorkerTask.Triggers = @($currentFiniteTimeTrigger,$logonTriggerMock)
    $global:MockWorkerTask.State = 'Ready'
    $global:MockWorkerTask.Settings.Enabled = $true
    $global:MockSchedulerApply = $true
    $setCountBeforeFiniteMode = $global:MockSetScheduledTaskCalls.Count
    $finiteModeOutput = (Invoke-WorkerRuntimeTaskLogonTriggerRefresh | Out-String)
    Assert-Equal $global:MockSetScheduledTaskCalls.Count ($setCountBeforeFiniteMode + 1) `
        'the current finite task is migrated with one native scheduler write'
    if (-not $finiteModeOutput.Contains('WORKER_TASK_REPETITION=UNBOUNDED_VERIFIED') -or
        -not $finiteModeOutput.Contains('WORKER_TASK_LOGON_TRIGGER=ALREADY_PRESENT')) {
        throw 'WORKER_TASK_FINITE_CURRENT_MIGRATION_RECEIPT_MISSING'
    }
    if ($global:MockWorkerTaskXml.Contains('<Duration>')) { throw 'WORKER_TASK_FINITE_DURATION_REMAINS_AFTER_MODE_MIGRATION' }
    Assert-Equal ([regex]::Matches($global:MockWorkerTaskXml, '<LogonTrigger>')).Count 1 `
        'current task migration preserves exactly one logon trigger'
    $backupPathLine = @($finiteModeOutput -split "`r?`n" | Where-Object { $_.StartsWith('WORKER_TASK_BACKUP=') })[0]
    $finiteBackupPath = $backupPathLine.Substring('WORKER_TASK_BACKUP='.Length)
    Assert-Equal ([IO.File]::ReadAllText($finiteBackupPath)) $currentFiniteXml `
        'the current finite task is backed up byte-for-byte before scheduler mutation'
    $setCountBeforeFiniteIdempotency = $global:MockSetScheduledTaskCalls.Count
    $null = Invoke-WorkerRuntimeTaskLogonTriggerRefresh
    Assert-Equal $global:MockSetScheduledTaskCalls.Count $setCountBeforeFiniteIdempotency `
        'the migrated current task is not rewritten on its next refresh'

    $global:MockWorkerTaskXml = $legacyEnabledXml
    $global:MockWorkerTask.Triggers = @($timeTrigger)
    $global:MockSchedulerApply = $false
    $global:MockSchedulerThrowAfterApply = $true
    $setCountBeforeNoApply = $global:MockSetScheduledTaskCalls.Count
    Assert-Throws { Invoke-WorkerRuntimeTaskLogonTriggerRefresh } `
        'WORKER_RUNTIME_TASK_TRIGGER_UPGRADE_NOT_APPLIED' 'a scheduler error with unchanged exact prestate is reported as not applied'
    Assert-Equal $global:MockSetScheduledTaskCalls.Count ($setCountBeforeNoApply + 1) `
        'an unchanged failure outcome is not automatically replayed'
    Assert-Equal (Get-WorkerRuntimeTaskTriggerState $global:MockWorkerTaskXml).TriggerKind `
        'LEGACY_TIME_ONLY' 'a no-effect failure preserves the legacy task definition'

    $global:MockSchedulerApply = $true
    $setCountBeforeAmbiguousError = $global:MockSetScheduledTaskCalls.Count
    $reconciledOutput = (Invoke-WorkerRuntimeTaskLogonTriggerRefresh | Out-String)
    Assert-Equal $global:MockSetScheduledTaskCalls.Count ($setCountBeforeAmbiguousError + 1) `
        'a scheduler error after apply is reconciled without issuing a second write'
    if (-not $reconciledOutput.Contains('WORKER_TASK_TRIGGER_WRITE=ERROR_RECONCILED_FROM_EXACT_READBACK')) {
        throw 'WORKER_TASK_TRIGGER_REFRESH_AMBIGUOUS_WRITE_READBACK_MISSING'
    }
    Assert-Equal (Get-WorkerRuntimeTaskTriggerState $global:MockWorkerTaskXml).TriggerKind `
        'CURRENT_TIME_AND_LOGON' 'the ambiguous write is accepted only after exact current-state readback'
    $global:MockSchedulerApply = $false
    $global:MockSchedulerThrowAfterApply = $false
    $global:MockWorkerTaskXml = $validTaskXml
    $global:MockWorkerTask.State = 'Disabled'
    $global:MockWorkerTask.Settings.Enabled = $false
    $global:MockWorkerTask.Triggers = @($timeTrigger)
    Remove-Variable MockNodeExecutable -Scope Global -ErrorAction SilentlyContinue

    $head = 'a' * 40
    $repo = 'PT-Original-Point/ptysd-autonomous-factory'
    function New-TrustedRun([string]$WorkflowName, [string]$WorkflowPath, [string]$Event,
        [string]$RunHead, [string]$HeadRepository, [long]$WorkflowId, [string]$Status = 'completed',
        [string]$Conclusion = 'success', [int]$Attempt = 1, [long]$RunId = 100) {
        return [pscustomobject]@{
            name=$WorkflowName; path=$WorkflowPath; event=$Event; status=$Status
            conclusion=$Conclusion; head_sha=$RunHead; workflow_id=$WorkflowId
            run_attempt=$Attempt; id=$RunId; head_repository=[pscustomobject]@{full_name=$HeadRepository}
        }
    }
    function Convert-RunsToPagesJson([object[]]$Runs) {
        $page = [pscustomobject]@{workflow_runs=@($Runs)}
        return ConvertTo-Json -InputObject ([object[]]@($page)) -Depth 8 -Compress
    }
    $trustedRuns = @(
        (New-TrustedRun 'V5.3-R4 CSG trusted verifier (GitHub-hosted)' '.github/workflows/csg-trusted-verifier-hosted.yml' 'pull_request_target' $head $repo 381764260  'completed' 'success' 1 100),
        (New-TrustedRun 'V5.3 main source retirement integrity' '.github/workflows/v53-r4-main-source-retirement.yml' 'pull_request' $head $repo 381351204 'completed' 'success' 1 101),
        (New-TrustedRun 'V53R4 OpenCode V2 CLI zero-token qualification' '.github/workflows/v53r4-v2-cli-qualification.yml' 'pull_request' $head $repo 382735923 'completed' 'success' 1 102)
    )
    $trustedJson = Convert-RunsToPagesJson $trustedRuns
    Assert-WorkerRuntimeTrustedRuns $trustedJson $head
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedJson.Replace($head, ('b' * 40))) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'successful workflows on a different head cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedJson.Replace('"status":"completed"', '"status":"queued"')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a queued workflow cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedJson.Replace($repo, 'untrusted/fork')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a same-named workflow from a different repository cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedJson.Replace('381764260', '123')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a different workflow identity cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedJson.Replace('V5.3-R4 CSG trusted verifier (GitHub-hosted)', 'Untrusted workflow')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a same-path workflow with a different name cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedJson.Replace('pull_request_target', 'pull_request')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a workflow with a different trigger event cannot authorize refresh'
    $failedRetryRuns = @($trustedRuns) + @(
        (New-TrustedRun 'V53R4 OpenCode V2 CLI zero-token qualification' '.github/workflows/v53r4-v2-cli-qualification.yml' 'pull_request' $head $repo 382735923 'completed' 'failure' 2 103)
    )
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns (Convert-RunsToPagesJson $failedRetryRuns) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'the latest failed workflow retry supersedes an older passing run'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns (Convert-RunsToPagesJson @($trustedRuns[0],$trustedRuns[1])) $head } `
        'WORKER_RUNTIME_CI_CHECK_MISSING:v2-native-windows' 'missing Windows qualification blocks refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns '{not-json' $head } `
        'WORKER_RUNTIME_CI_READBACK_MALFORMED' 'malformed provider JSON blocks refresh'

    $gitExe = (Get-Command git.exe -ErrorAction Stop).Source
    $ancestryRoot = Join-Path $testRoot 'pr-ancestry'
    $null = [IO.Directory]::CreateDirectory($ancestryRoot)
    function Invoke-TestGit([string[]]$GitArguments) {
        $output = @(& $gitExe @GitArguments 2>$null)
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) { throw 'TEST_GIT_COMMAND_FAILED' }
        return (($output -join [Environment]::NewLine).Trim())
    }
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'init','--quiet')
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'config','user.name','PTYSD Runtime Test')
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'config','user.email','runtime-test@example.invalid')
    $nativeBridgeFixture = Join-Path $ancestryRoot 'native-bridge'
    $null = [IO.Directory]::CreateDirectory($nativeBridgeFixture)
    [IO.File]::WriteAllText((Join-Path $ancestryRoot 'source.txt'),'candidate tree',
        ([Text.UTF8Encoding]::new($false)))
    [IO.File]::WriteAllText((Join-Path $nativeBridgeFixture 'worker.mjs'),'runtime source',
        ([Text.UTF8Encoding]::new($false)))
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'add','source.txt','native-bridge/worker.mjs')
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'commit','--quiet','-m','candidate source')
    $baseSha = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'rev-parse','HEAD')
    [IO.File]::WriteAllText((Join-Path $ancestryRoot 'source.txt'),'accepted PR tree',
        ([Text.UTF8Encoding]::new($false)))
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'add','source.txt')
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'commit','--quiet','-m','accepted PR head')
    $acceptedHead = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'rev-parse','HEAD')
    $gitPath = Get-WorkerRuntimeGitPath 'worker.mjs'
    $runtimeBlob = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'rev-parse',($acceptedHead + ':' + $gitPath))
    Assert-Equal $runtimeBlob (Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'hash-object','native-bridge/worker.mjs')) `
        'runtime module Git lookup is rooted at native-bridge'
    $acceptedTree = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'rev-parse',($acceptedHead + '^{tree}'))
    $rebasedMain = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'commit-tree',$acceptedTree,
        '-p',$baseSha,'-m','rebased PR with exact tree')
    Assert-WorkerRuntimeAcceptedPrAncestry $gitExe $ancestryRoot $acceptedHead $acceptedHead $acceptedHead @('worker.mjs')
    Assert-WorkerRuntimeAcceptedPrAncestry $gitExe $ancestryRoot $acceptedHead $rebasedMain $rebasedMain @('worker.mjs')
    Assert-Throws {
        Assert-WorkerRuntimeAcceptedPrAncestry $gitExe $ancestryRoot $acceptedHead $acceptedHead $rebasedMain @('worker.mjs')
    } 'WORKER_RUNTIME_ACCEPTED_PR_NOT_IN_MAIN' 'a PR merge commit not reachable from main cannot authorize refresh'
    Assert-Throws {
        Assert-WorkerRuntimeAcceptedPrAncestry $gitExe $ancestryRoot $acceptedHead $rebasedMain $rebasedMain
    } 'WORKER_RUNTIME_ACCEPTED_PR_RUNTIME_BUNDLE_SCOPE_REQUIRED' 'rewritten merge validation requires explicit runtime scope'
    [IO.File]::WriteAllText((Join-Path $ancestryRoot 'source.txt'),'different merge tree',
        ([Text.UTF8Encoding]::new($false)))
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'add','source.txt')
    $differentTree = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'write-tree')
    $differentMerge = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'commit-tree',$differentTree,
        '-p',$baseSha,'-m','different merge result')
    Assert-WorkerRuntimeAcceptedPrAncestry $gitExe $ancestryRoot $acceptedHead $differentMerge $differentMerge @('worker.mjs')
    [IO.File]::WriteAllText((Join-Path $nativeBridgeFixture 'worker.mjs'),'runtime source changed in merge',
        ([Text.UTF8Encoding]::new($false)))
    $null = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'add','native-bridge/worker.mjs')
    $differentRuntimeTree = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'write-tree')
    $differentRuntimeMerge = Invoke-TestGit -GitArguments @('-C',$ancestryRoot,'commit-tree',$differentRuntimeTree,
        '-p',$baseSha,'-m','runtime module differs in merge')
    Assert-Throws {
        Assert-WorkerRuntimeAcceptedPrAncestry $gitExe $ancestryRoot $acceptedHead `
            $differentRuntimeMerge $differentRuntimeMerge @('worker.mjs')
    } 'WORKER_RUNTIME_ACCEPTED_PR_RUNTIME_BUNDLE_MISMATCH:native-bridge/worker.mjs' `
        'a rewritten PR merge that changes a runtime module must be rejected'

    Write-Output 'NATIVE_WORKER_RUNTIME_REFRESH_HELPERS_PASS'
} finally {
    Remove-Item Function:\global:Export-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\global:Get-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\global:New-ScheduledTaskTrigger -ErrorAction SilentlyContinue
    Remove-Item Function:\global:Set-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\Test-GhAuthenticated -ErrorAction SilentlyContinue
    Remove-Item Function:\Require-Command -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-WorkerRuntimePathChain -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-WorkerRuntimeNoActiveProcess -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-WorkerRuntimeSource -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $testRoot).Path)
        if (-not $resolvedTestRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'TEST_CLEANUP_PATH_OUTSIDE_TEMP'
        }
        foreach ($file in [IO.Directory]::EnumerateFiles($resolvedTestRoot, '*',
            [IO.SearchOption]::AllDirectories)) {
            $attributes = [IO.File]::GetAttributes($file)
            if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
                [IO.File]::SetAttributes($file, ($attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
            }
        }
        [IO.Directory]::Delete($resolvedTestRoot, $true)
    }
    Remove-Variable MockWorkerTaskXml -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable MockWorkerTask -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable MockSetScheduledTaskCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable MockSchedulerApply -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable MockSchedulerThrowAfterApply -Scope Global -ErrorAction SilentlyContinue
}
