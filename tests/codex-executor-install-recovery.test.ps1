$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$repoRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $repoRoot 'native-bridge\install-codex-executor.ps1'
$modulePath = Join-Path $repoRoot 'native-bridge\codex-executor-install-state.psm1'

$parseTokens = $null
$parseErrors = $null
$installerAst = [System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ('POWERSHELL_PARSE_FAILED: ' + $installerPath + ': ' + $parseErrors[0].Message) }
$transitionAclFunction = $installerAst.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Assert-CodexExecutorTransitionAcl'
}, $true)
if ($null -eq $transitionAclFunction) { throw 'TRANSITION_ACL_FUNCTION_MISSING' }
Invoke-Expression $transitionAclFunction.Extent.Text
if (Test-Path -LiteralPath $modulePath) { throw 'REDUNDANT_PRIVATE_INSTALL_STATE_MODULE_STILL_PRESENT' }

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase ('pty-codex-install-recovery-' + [guid]::NewGuid().ToString('N'))
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'TEST_PATH_OUTSIDE_TEMP' }
$local = Join-Path $testRoot 'local'
$programData = Join-Path $testRoot 'programdata'
$programFiles = Join-Path $testRoot 'programfiles'
$global:MockRoot = $testRoot
$global:MockProgramData = $programData
$global:MockSpool = Join-Path $programData 'PTYSDCodexExecutor\CodexSpool'
$global:MockRuntime = Join-Path $programData 'PTYSDCodexExecutor\CodexRuntime'
$global:MockTaskRegistered = $false
$global:MockRegistration = $null
$global:MockFailurePoint = ''
$global:MockAclCalls = 0
$global:MockGroupLookupCalls = 0
$global:MockAclOverrides = @{}
$global:MockTransitionAclReads = $false
$global:MockRuntimeCopyCalls = 0
$global:MockRegisterCalls = 0
$global:MockFailureInjected = $false
$global:MockAclStore = @{}
$global:MockProgramDataAcl = New-Object System.Security.AccessControl.DirectorySecurity
$global:MockBadSignaturePath = ''
$global:MockTaskNotFoundThrows = $true
$global:MockReadbackPrincipalUserId = $null
$global:MockNullReadbackTriggers = $false
$global:MockExecutorTaskState = 'Ready'
$global:MockProcesses = @()
$global:MockCreateExecutorLockAtSignature = $false

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw ('ASSERT_EQUAL_FAILED: ' + $Message + ';actual=' + $Actual + ';expected=' + $Expected) }
}

function Get-TestByteSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function global:Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -eq 'PTYSD-Native-OpenCode') {
        return [pscustomobject]@{
            TaskName = $TaskName; State = 'Ready'
            Principal = [pscustomobject]@{ LogonType = 'Interactive'; RunLevel = 'Limited' }
            Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew' }
            Actions = @([pscustomobject]@{ Execute = 'wscript.exe'; Arguments = '"HiddenWorker.vbs"'; WorkingDirectory = $global:MockRoot })
            Triggers = @()
        }
    }
    if ($TaskName -eq 'PTYSD-Codex-Executor' -and $global:MockTaskRegistered) {
        $reg = $global:MockRegistration
        $hidden = $true
        $allowHardTerminate = [bool]$reg.Settings.AllowHardTerminate
        if ($global:MockFailurePoint -eq 'ReadbackMismatch') { $allowHardTerminate = $true }
        $readbackUserId = if ($null -ne $global:MockReadbackPrincipalUserId) {
            $global:MockReadbackPrincipalUserId
        } else { $reg.Principal.UserId }
        $readbackTriggers = if ($global:MockNullReadbackTriggers) { $null } else { @() }
        return [pscustomobject]@{
            TaskName = $TaskName; State = $global:MockExecutorTaskState
            Principal = [pscustomobject]@{ UserId = $readbackUserId; LogonType = $reg.Principal.LogonType; RunLevel = $reg.Principal.RunLevel }
            Settings = [pscustomobject]@{ MultipleInstances = $reg.Settings.MultipleInstances; ExecutionTimeLimit = $reg.Settings.ExecutionTimeLimit; Hidden = $hidden; AllowHardTerminate = $allowHardTerminate }
            Actions = @([pscustomobject]@{ Execute = $reg.Action.Execute; Arguments = $reg.Action.Arguments; WorkingDirectory = $reg.Action.WorkingDirectory })
            Triggers = $readbackTriggers
        }
    }
    if ($TaskName -eq 'PTYSD-Codex-Executor' -and $global:MockTaskNotFoundThrows -and $PSBoundParameters['ErrorAction'] -eq 'Stop') {
        $record = [System.Management.Automation.ErrorRecord]::new(
            [System.Exception]::new('No matching MSFT_ScheduledTask objects found by CIM query.'),
            'CmdletizationQuery_NotFound,Get-ScheduledTask',
            [System.Management.Automation.ErrorCategory]::ObjectNotFound,
            'MSFT_ScheduledTask')
        $PSCmdlet.ThrowTerminatingError($record)
    }
    return @()
}

function global:Get-LocalGroupMember {
    [CmdletBinding()]
    param([string]$Group)
    $global:MockGroupLookupCalls++
    return @([pscustomobject]@{ SID = [pscustomobject]@{ Value = 'S-1-5-21-SYNTHETIC-NONADMIN' } })
}

function global:Get-AuthenticodeSignature {
    [CmdletBinding()]
    param([string]$FilePath)
    if ($global:MockCreateExecutorLockAtSignature) {
        $global:MockCreateExecutorLockAtSignature = $false
        $lockPath = Join-Path $global:MockSpool 'locks\executor.active'
        $lock = [ordered]@{ schema=1; pid=5001; started_at=[DateTime]::UtcNow.ToString('o')
            boot_uptime_seconds=1; phase='DISPATCHER'; request_id=$null; attempt_id=$null; model_pid=$null }
        [IO.File]::WriteAllText($lockPath, (ConvertTo-Json -InputObject $lock -Depth 4 -Compress),
            [Text.UTF8Encoding]::new($false))
    }
    if ($global:MockBadSignaturePath -and [string]::Equals([IO.Path]::GetFullPath($FilePath),
        [IO.Path]::GetFullPath($global:MockBadSignaturePath), [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ Status = 'NotSigned'; SignerCertificate = $null }
    }
    return [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=OpenAI OpCo, LLC' } }
}

function global:Set-Acl {
    [CmdletBinding()]
    param([string]$LiteralPath, $AclObject)
    $global:MockAclCalls++
    if ($global:MockFailurePoint -eq 'AfterAcl' -and $global:MockAclCalls -eq 3 -and -not $global:MockFailureInjected) {
        $global:MockFailureInjected = $true
        throw 'INJECTED_AFTER_ACL'
    }
    $key = [IO.Path]::GetFullPath($LiteralPath).ToLowerInvariant()
    $global:MockAclStore[$key] = $AclObject
}

function global:Get-Acl {
    [CmdletBinding()]
    param([string]$LiteralPath)
    if ([IO.Path]::GetFullPath($LiteralPath).Equals([IO.Path]::GetFullPath($global:MockProgramData),
        [StringComparison]::OrdinalIgnoreCase)) { return $global:MockProgramDataAcl }
    if ($global:MockFailurePoint -eq 'AclReadbackMismatch' -and
        [IO.Path]::GetFullPath($LiteralPath).Equals([IO.Path]::GetFullPath($global:MockSpool), [StringComparison]::OrdinalIgnoreCase)) {
        $bad = New-Object System.Security.AccessControl.DirectorySecurity
        $bad.SetAccessRuleProtection($true, $false)
        return $bad
    }
    $key = [IO.Path]::GetFullPath($LiteralPath).ToLowerInvariant()
    if ($global:MockAclOverrides.ContainsKey($key)) { return $global:MockAclOverrides[$key] }
    if ($global:MockTransitionAclReads) { return New-Object System.Security.AccessControl.DirectorySecurity }
    if (-not $global:MockAclStore.ContainsKey($key)) { throw 'ACL_READBACK_MISSING' }
    return $global:MockAclStore[$key]
}

function global:Copy-Item {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Destination, [switch]$Force)
    $isRuntime = $Destination.StartsWith($global:MockRuntime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force -ErrorAction Stop
    if ($isRuntime) {
        $global:MockRuntimeCopyCalls++
        if ($global:MockFailurePoint -eq 'AfterCopy' -and $global:MockRuntimeCopyCalls -eq 1 -and -not $global:MockFailureInjected) {
            $global:MockFailureInjected = $true
            throw 'INJECTED_AFTER_COPY'
        }
    }
}

function global:New-ScheduledTaskAction {
    [CmdletBinding()]
    param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
    return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}

function global:New-ScheduledTaskSettingsSet {
    [CmdletBinding()]
    param([string]$MultipleInstances, [TimeSpan]$ExecutionTimeLimit, [switch]$Hidden, [switch]$DisallowHardTerminate)
    return [pscustomobject]@{ MultipleInstances = $MultipleInstances; ExecutionTimeLimit = $ExecutionTimeLimit; Hidden = [bool]$Hidden; AllowHardTerminate = -not [bool]$DisallowHardTerminate }
}

function global:New-ScheduledTaskPrincipal {
    [CmdletBinding()]
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}

function global:Register-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath, $Action, $Settings, $Principal, [string]$User, [string]$Password)
    $global:MockRegisterCalls++
    $global:MockRegistration = [pscustomobject]@{ Action = $Action; Settings = $Settings; Principal = $Principal
        User = $User; Password = $Password; TaskPath = $TaskPath }
    $global:MockTaskRegistered = $true
    if ($global:MockFailurePoint -eq 'AfterRegister') { throw 'INJECTED_REGISTER_AMBIGUOUS' }
}

function global:Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -eq 'PTYSD-Codex-Executor') { $global:MockTaskRegistered = $false }
}

function global:Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -eq 'Win32_Process') { return @($global:MockProcesses) }
    if ($ClassName -eq 'Win32_OperatingSystem') {
        return [pscustomobject]@{ LastBootUpTime = (Get-Date).AddHours(-4) }
    }
    throw ('UNEXPECTED_CIM_CLASS: ' + $ClassName)
}

function Invoke-InstallAttempt([string]$ExpectedError = '', [string]$CodexPath = '',
    [string]$ExecutionPhase = 'VM_ISOLATED', [switch]$NoCredential) {
    if (-not $CodexPath) { $CodexPath = $global:MockCodexPath }
    $arguments = @{ Mode='Install'; ExecutionPhase=$ExecutionPhase
        NodeExecutable=(Join-Path $programFiles 'Node\node.exe'); CodexExecutable=$CodexPath }
    if (-not $NoCredential) {
        $password = New-Object Security.SecureString
        foreach ($character in 'synthetic-only'.ToCharArray()) { $password.AppendChar($character) }
        $password.MakeReadOnly()
        $arguments.ExecutorCredential = [Management.Automation.PSCredential]::new('NT AUTHORITY\LOCAL SERVICE', $password)
    }
    $failure = $null
    try {
        & $installerPath @arguments 2>$null | Out-Null
    } catch { $failure = $_.Exception.Message }
    if ($ExpectedError) {
        if ($null -eq $failure -or $failure -notlike ('*' + $ExpectedError + '*')) {
            throw ('EXPECTED_INSTALL_FAILURE_NOT_SEEN: ' + $ExpectedError + ';actual=' + $failure)
        }
    } elseif ($null -ne $failure) {
        throw ('INSTALL_RECOVERY_FAILED: ' + $failure)
    }
    return $failure
}

function Invoke-CliRefreshAttempt([string]$ExpectedError = '', [string]$CodexPath = '') {
    if (-not $CodexPath) { $CodexPath = $global:MockCodexPath }
    $failure = $null
    try {
        & $installerPath -Mode RefreshCodexCli -ExecutionPhase WIN11_TRANSITION `
            -CodexExecutable $CodexPath 2>$null | Out-Null
    } catch { $failure = $_.Exception.Message }
    if ($ExpectedError) {
        if ($null -eq $failure -or $failure -notlike ('*' + $ExpectedError + '*')) {
            throw ('EXPECTED_CLI_REFRESH_FAILURE_NOT_SEEN: ' + $ExpectedError + ';actual=' + $failure)
        }
    } elseif ($null -ne $failure) {
        throw ('CLI_REFRESH_FAILED: ' + $failure)
    }
    return $failure
}

try {
    New-Item -ItemType Directory -Path $local, $programData, $programFiles -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $local 'PTYSDNativeBridge') -Force | Out-Null
    $aclTestParent = Join-Path $testRoot 'acl-inherit-only-parent'
    $aclTestTarget = Join-Path $aclTestParent 'target'
    New-Item -ItemType Directory -Path $aclTestTarget -Force | Out-Null
    $everyoneSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $aclInheritFlags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $inheritOnlyAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $inheritOnlyRule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyoneSid,
        [System.Security.AccessControl.FileSystemRights]::Modify, $aclInheritFlags,
        [System.Security.AccessControl.PropagationFlags]::InheritOnly,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $inheritOnlyAcl.AddAccessRule($inheritOnlyRule)
    $global:MockTransitionAclReads = $true
    $inheritOnlyParentKey = [IO.Path]::GetFullPath($aclTestParent).ToLowerInvariant()
    $global:MockAclOverrides[$inheritOnlyParentKey] = $inheritOnlyAcl
    Assert-CodexExecutorTransitionAcl $aclTestTarget
    $global:MockAclOverrides.Remove($inheritOnlyParentKey)
    $effectiveAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $effectiveRule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyoneSid,
        [System.Security.AccessControl.FileSystemRights]::Modify, $aclInheritFlags,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $effectiveAcl.AddAccessRule($effectiveRule)
    $effectiveTargetKey = [IO.Path]::GetFullPath($aclTestTarget).ToLowerInvariant()
    $global:MockAclOverrides[$effectiveTargetKey] = $effectiveAcl
    $effectiveAceRejected = $false
    try { Assert-CodexExecutorTransitionAcl $aclTestTarget }
    catch { $effectiveAceRejected = $_.Exception.Message -eq 'EXECUTOR_TRANSITION_ACL_BROAD_WRITE' }
    Assert-Equal $effectiveAceRejected $true 'an effective broad-write ACE remains rejected'
    $global:MockAclOverrides.Remove($effectiveTargetKey)
    $global:MockTransitionAclReads = $false
    Remove-Item -LiteralPath $aclTestParent -Recurse -Force

    New-Item -ItemType Directory -Path (Join-Path $programFiles 'Node') -Force | Out-Null
    $global:MockCodexSourceDirectory = Join-Path $local 'OpenAI\Codex\bin\synthetic-version'
    New-Item -ItemType Directory -Path $global:MockCodexSourceDirectory -Force | Out-Null
    $env:COMPUTERNAME = 'DESKTOP-1B6PD2P'
    $env:LOCALAPPDATA = $local
    $env:ProgramData = $programData
    $env:ProgramFiles = $programFiles
    $nodePath = Join-Path $programFiles 'Node\node.exe'
    [IO.File]::WriteAllText($nodePath, 'synthetic node executable')
    $global:MockCodexPath = Join-Path $global:MockCodexSourceDirectory 'codex.exe'
    foreach ($name in @('codex.exe','codex-code-mode-host.exe','codex-command-runner.exe',
        'codex-windows-sandbox-setup.exe')) {
        [IO.File]::WriteAllText((Join-Path $global:MockCodexSourceDirectory $name), ('synthetic signed Codex bundle ' + $name))
    }
    $workerConfigPath = Join-Path $local 'PTYSDNativeBridge\config.json'
    $originalConfig = '{"existing":"preserve"}'
    [IO.File]::WriteAllText($workerConfigPath, $originalConfig)
    $env:LOCALAPPDATA = Join-Path $local 'PTYSDNativeBridge\..'
    $env:LOCALAPPDATA = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    $env:ProgramData = $programData
    $installerPath = Join-Path $repoRoot 'native-bridge\install-codex-executor.ps1'

    $unapprovedCodexDirectory = Join-Path $local 'unapproved-cli'
    New-Item -ItemType Directory -Path $unapprovedCodexDirectory -Force | Out-Null
    $unapprovedCodexPath = Join-Path $unapprovedCodexDirectory 'codex.exe'
    [IO.File]::WriteAllText($unapprovedCodexPath, 'unsigned unrelated executable')
    $null = Invoke-InstallAttempt 'CODEX_EXECUTABLE_MUST_BE_PROGRAM_FILES_OR_OFFICIAL_LOCAL_CODEX' $unapprovedCodexPath
    Assert-Equal $global:MockTaskRegistered $false 'unrelated per-user executable cannot become the Codex Executor'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $local 'PTYSDNativeBridge\codex-executor-install-state-VM_ISOLATED.json')) `
        $false 'unapproved executable is rejected before install state is written'

    $global:MockBadSignaturePath = Join-Path $global:MockCodexSourceDirectory 'codex-command-runner.exe'
    $null = Invoke-InstallAttempt 'CODEX_CLI_BUNDLE_SIGNATURE_NOT_QUALIFIED'
    $global:MockBadSignaturePath = ''
    Assert-Equal $global:MockTaskRegistered $false 'unsigned Codex sidecar prevents executor registration'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $local 'PTYSDNativeBridge\codex-executor-install-state-VM_ISOLATED.json')) `
        $false 'invalid Codex bundle signature is rejected before install state is written'

    $null = New-Item -ItemType Directory -Path $global:MockSpool
    $null = Invoke-InstallAttempt 'CODEX_EXECUTOR_PATH_ALREADY_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE'
    Assert-Equal $global:MockTaskRegistered $false 'preexisting empty spool is not claimed'
    Assert-Equal $global:MockAclCalls 0 'preexisting empty spool ACL is untouched'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config stays unchanged for a path collision'
    Remove-Item -LiteralPath $global:MockSpool -Force

    $unsafeParentAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $unsafeParentAcl.SetAccessRuleProtection($true, $false)
    $batchSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-3')
    $batchDeleteChild = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $batchSid, [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $null = $unsafeParentAcl.AddAccessRule($batchDeleteChild)
    $global:MockProgramDataAcl = $unsafeParentAcl
    $null = Invoke-InstallAttempt 'EXECUTOR_SHARED_PARENT_DELETE_CHILD_EXPOSED'
    Assert-Equal $global:MockTaskRegistered $false 'unsafe parent ACL prevents executor registration'
    Assert-Equal $global:MockAclCalls 0 'unsafe parent ACL stops before changing child ACLs'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $local 'PTYSDNativeBridge\codex-executor-install-state-VM_ISOLATED.json')) `
        $false 'unsafe parent ACL is detected before recording install state'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'unsafe parent ACL leaves worker config unchanged'
    $global:MockProgramDataAcl = New-Object System.Security.AccessControl.DirectorySecurity

    $global:MockFailurePoint = 'AfterAcl'
    $global:MockAclCalls = 0
    $null = Invoke-InstallAttempt 'INJECTED_AFTER_ACL'
    Assert-Equal $global:MockTaskRegistered $false 'task remains absent after ACL failure'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config unchanged after ACL failure'
    $statePath = Join-Path $local 'PTYSDNativeBridge\codex-executor-install-state-VM_ISOLATED.json'
    Assert-Equal (Test-Path -LiteralPath $statePath) $true 'install identity is retained for safe recovery after ACL failure'
    $stateText = Get-Content -LiteralPath $statePath -Raw
    if ($stateText -notlike '*"schema":"ptysd-codex-executor-install-state.v1"*') { throw 'INSTALL_STATE_SCHEMA_MISSING' }
    $aclCallsBeforeStateMismatch = $global:MockAclCalls
    [IO.File]::WriteAllText($statePath, '{"schema":"different"}')
    $null = Invoke-InstallAttempt 'CODEX_EXECUTOR_INSTALL_STATE_MISMATCH_REVIEW_REQUIRED'
    Assert-Equal $global:MockAclCalls $aclCallsBeforeStateMismatch 'mismatched install identity does not alter ACLs'
    Assert-Equal $global:MockTaskRegistered $false 'mismatched install identity does not register a task'
    [IO.File]::WriteAllText($statePath, $stateText)

    $global:MockFailurePoint = 'AclReadbackMismatch'
    $global:MockAclCalls = 0
    $global:MockAclStore = @{}
    $global:MockFailureInjected = $false
    $null = Invoke-InstallAttempt 'EXECUTOR_ACL_READBACK_MISMATCH'
    Assert-Equal $global:MockTaskRegistered $false 'ACL readback mismatch prevents task registration'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config unchanged after ACL readback mismatch'
    Assert-Equal (Test-Path -LiteralPath $statePath) $true 'install identity remains available after ACL readback mismatch'

    $global:MockFailurePoint = 'AfterCopy'
    $global:MockAclStore = @{}
    $global:MockRuntimeCopyCalls = 0
    $global:MockFailureInjected = $false
    $null = Invoke-InstallAttempt 'INJECTED_AFTER_COPY'
    Assert-Equal $global:MockTaskRegistered $false 'task remains absent after copy failure'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config unchanged after copy failure'

    $global:MockFailurePoint = 'ReadbackMismatch'
    $global:MockFailureInjected = $false
    $readbackMismatch = Invoke-InstallAttempt 'EXECUTOR_TASK_READBACK_MISMATCH'
    if ($readbackMismatch -notlike '*fields=Settings.AllowHardTerminate*') { throw ('READBACK_MISMATCH_DID_NOT_IDENTIFY_FIELD: ' + $readbackMismatch) }
    Assert-Equal $global:MockTaskRegistered $false 'registered mock task rolled back after readback mismatch'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config restored after readback mismatch'
    Assert-Equal (Test-Path -LiteralPath $statePath) $true 'install identity remains after task readback rollback for safe retry'

    $global:MockFailurePoint = ''
    $global:MockFailureInjected = $false
    Start-Sleep -Milliseconds 1100
    $null = Invoke-InstallAttempt
    Assert-Equal $global:MockTaskRegistered $true 'mock task registered after safe recovery'
    Assert-Equal (Test-Path -LiteralPath $statePath) $true 'successful install retains exact install identity for future recovery'
    $sharedRoot = Join-Path $programData 'PTYSDCodexExecutor'
    $sharedRootKey = [IO.Path]::GetFullPath($sharedRoot).ToLowerInvariant()
    $sharedRootAcl = $global:MockAclStore[$sharedRootKey]
    Assert-Equal ($null -ne $sharedRootAcl -and $sharedRootAcl.AreAccessRulesProtected) `
        $true 'dedicated shared root has a protected DACL'
    $sharedRootSids = @($sharedRootAcl.GetAccessRules($true, $true,
        [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
    foreach ($sid in @('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-3','S-1-5-4','S-1-5-6')) {
        if ($sharedRootSids -contains $sid) { throw ('UNTRUSTED_SHARED_ROOT_ACL_ENTRY: ' + $sid) }
    }
    $installedConfig = Get-Content -LiteralPath $workerConfigPath -Raw | ConvertFrom-Json
    Assert-Equal $installedConfig.enable_codex_model_runs $false 'model execution remains disabled'
    Assert-Equal $installedConfig.codex_usage_authorized $false 'usage authorization remains disabled'
    $executorConfigReadback = Get-Content -LiteralPath (Join-Path $global:MockRuntime 'executor-config.json') -Raw | ConvertFrom-Json
    Assert-Equal $executorConfigReadback.codex_executable (Join-Path $global:MockRuntime 'codex.exe') `
        'executor uses the protected staged Codex CLI rather than publisher AppData'
    Assert-Equal $executorConfigReadback.codex_executable_sha256 `
        ((Get-FileHash -LiteralPath (Join-Path $global:MockCodexSourceDirectory 'codex.exe') -Algorithm SHA256).Hash.ToLowerInvariant()) `
        'executor config binds the staged codex.exe by SHA-256'
    $installState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    foreach ($name in @('codex.exe','codex-code-mode-host.exe','codex-command-runner.exe',
        'codex-windows-sandbox-setup.exe')) {
        $sourceHash = (Get-FileHash -LiteralPath (Join-Path $global:MockCodexSourceDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        $stagedHash = (Get-FileHash -LiteralPath (Join-Path $global:MockRuntime $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-Equal $stagedHash $sourceHash ('signed Codex bundle staged byte-identically: ' + $name)
        Assert-Equal $installState.runtime_sha256.PSObject.Properties[$name].Value $sourceHash `
            ('Codex bundle hash is included in install readback: ' + $name)
    }

    $successfulConfigBytes = Get-Content -LiteralPath $workerConfigPath -Raw
    & $installerPath -Mode Uninstall 2>$null | Out-Null
    Assert-Equal $global:MockTaskRegistered $false 'mock task removed while runtime artifacts remain hash-verifiable'
    Assert-Equal (Test-Path -LiteralPath $statePath) $true 'uninstall preserves install identity with retained runtime artifacts'
    $global:MockFailurePoint = 'AfterRegister'
    $null = Invoke-InstallAttempt 'CODEX_EXECUTOR_INSTALL_ROLLBACK_INCOMPLETE_REVIEW_REQUIRED'
    Assert-Equal $global:MockTaskRegistered $true 'ambiguous registration remains for exact review'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $successfulConfigBytes 'config restored after ambiguous registration'
    $registerCountAfterAmbiguity = $global:MockRegisterCalls
    $global:MockFailurePoint = ''
    $null = Invoke-InstallAttempt 'EXECUTOR_TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE'
    Assert-Equal $global:MockRegisterCalls $registerCountAfterAmbiguity 'ambiguous registration is not replayed'
    & $installerPath -Mode Uninstall 2>$null | Out-Null
    Assert-Equal $global:MockTaskRegistered $false 'synthetic ambiguous task explicitly removed at test end'

    $preserved = Join-Path $global:MockSpool 'unknown.bin'
    [IO.File]::WriteAllText($preserved, 'do-not-delete')
    $null = Invoke-InstallAttempt 'INSTALL_SPOOL_DATA_REVIEW_REQUIRED'
    Assert-Equal (Get-Content -LiteralPath $preserved -Raw) 'do-not-delete' 'unknown spool data is preserved and blocks install'
    Assert-Equal $global:MockRegisterCalls $registerCountAfterAmbiguity 'ambiguous or preexisting side effects are not replayed'

    $transitionRoot = Join-Path $local 'PTYSDNativeBridge\CodexExecutor'
    $global:MockSpool = Join-Path $transitionRoot 'CodexSpool'
    $global:MockRuntime = Join-Path $transitionRoot 'CodexRuntime'
    $global:MockAclCalls = 0
    $global:MockGroupLookupCalls = 0
    $global:MockRuntimeCopyCalls = 0
    $global:MockFailurePoint = ''
    $global:MockRegistration = $null
    $global:MockReadbackPrincipalUserId = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $global:MockNullReadbackTriggers = $true
    $env:USERPROFILE = $local
    $global:MockTransitionAclReads = $true
    $transitionState = Join-Path $local 'PTYSDNativeBridge\codex-executor-install-state-WIN11_TRANSITION.json'
    $null = Invoke-InstallAttempt -ExecutionPhase 'WIN11_TRANSITION' -NoCredential
    Assert-Equal $global:MockTaskRegistered $true 'same-user transition registers the on-demand task'
    Assert-Equal $global:MockRegistration.Principal.UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        'transition uses the current Windows identity'
    Assert-Equal $global:MockRegistration.Principal.LogonType 'Interactive' 'transition uses an interactive token'
    Assert-Equal $global:MockRegistration.Principal.RunLevel 'Limited' 'transition does not elevate the task'
    Assert-Equal $global:MockRegistration.Password '' 'transition passes no separate account password'
    Assert-Equal $global:MockRegistration.User '' 'transition does not use password-logon registration'
    Assert-Equal $global:MockAclCalls 0 'transition leaves ACLs unchanged'
    Assert-Equal $global:MockGroupLookupCalls 0 'transition does not require standard-user membership'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $global:MockRuntime 'codex.exe')) $false `
        'transition does not copy the Codex CLI into its runtime'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $global:MockRuntime 'codex-command-runner.exe')) $false `
        'transition does not copy CLI sidecars'
    Assert-Equal (Test-Path -LiteralPath $transitionState) $true 'transition records its own phase-bound install identity'
    $transitionInstallState = Get-Content -LiteralPath $transitionState -Raw | ConvertFrom-Json
    Assert-Equal $transitionInstallState.execution_phase 'WIN11_TRANSITION' 'install state records the selected phase'
    $transitionExecutorConfig = Get-Content -LiteralPath (Join-Path $global:MockRuntime 'executor-config.json') -Raw | ConvertFrom-Json
    Assert-Equal $transitionExecutorConfig.codex_executable $global:MockCodexPath `
        'transition invokes the current-user official Codex CLI path directly'
    Assert-Equal $transitionExecutorConfig.codex_executable_sha256 `
        ((Get-FileHash -LiteralPath $global:MockCodexPath -Algorithm SHA256).Hash.ToLowerInvariant()) `
        'transition binds the directly used CLI by SHA-256'
    Assert-Equal $transitionExecutorConfig.codex_executor_execution_phase 'WIN11_TRANSITION' `
        'executor config carries the same phase as the registered task'
    $transitionWorkerConfig = Get-Content -LiteralPath $workerConfigPath -Raw | ConvertFrom-Json
    Assert-Equal $transitionWorkerConfig.codex_executor_execution_phase 'WIN11_TRANSITION' `
        'Publisher readback carries the same task phase'

    $transitionConfigPath = Join-Path $global:MockRuntime 'executor-config.json'
    $transitionConfigBytes = [IO.File]::ReadAllBytes($transitionConfigPath)
    $transitionManifestBytes = [IO.File]::ReadAllBytes($transitionState)
    $transitionWorkerBytes = [IO.File]::ReadAllBytes($workerConfigPath)
    $registerCallsBeforeRefresh = $global:MockRegisterCalls
    $registrationBeforeRefresh = $global:MockRegistration
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_PIN_REFRESH_NOT_REQUIRED'
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'unchanged CLI pin does not rewrite executor config'
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionState))) `
        ([BitConverter]::ToString($transitionManifestBytes)) 'unchanged CLI pin does not rewrite install state'

    Remove-Item -LiteralPath $global:MockCodexPath -Force
    $global:MockCodexRefreshPath = Join-Path $local 'OpenAI\Codex\bin\synthetic-version-2\codex.exe'
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $global:MockCodexRefreshPath) -Force
    [IO.File]::WriteAllText($global:MockCodexRefreshPath, 'synthetic signed refreshed Codex CLI')

    $nodePathForRefresh = $transitionExecutorConfig.codex_executor_node_path
    $global:MockProcesses = @([pscustomobject]@{
        ExecutablePath = $nodePathForRefresh
        CommandLine = ('node "' + (Join-Path $global:MockRuntime 'codex-executor.mjs') + '" "' + $transitionConfigPath + '"')
    })
    $null = Invoke-CliRefreshAttempt 'CODEX_EXECUTOR_PROCESS_RUNNING_DO_NOT_REFRESH' $global:MockCodexRefreshPath
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'live executor process prevents all CLI pin writes'
    $alternateNodePath = Join-Path $programFiles 'alternate-node\node.exe'
    $global:MockProcesses = @([pscustomobject]@{
        ExecutablePath = $alternateNodePath
        CommandLine = ('"' + $alternateNodePath + '" "' +
            (Join-Path $global:MockRuntime 'codex-executor.mjs') + '" "' + $transitionConfigPath + '"')
    })
    $null = Invoke-CliRefreshAttempt 'CODEX_EXECUTOR_PROCESS_RUNNING_DO_NOT_REFRESH' $global:MockCodexRefreshPath
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'matching executor script and config block refresh under alternate Node path'
    $global:MockProcesses = @([pscustomobject]@{
        ExecutablePath = (Join-Path $programFiles 'PowerShell\pwsh.exe')
        CommandLine = ('powershell text contains ' + (Join-Path $global:MockRuntime 'codex-executor.mjs'))
    })
    $global:MockExecutorTaskState = 'Running'
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_TASK_NOT_IDLE' $global:MockCodexRefreshPath
    $global:MockExecutorTaskState = 'Ready'

    $global:MockCreateExecutorLockAtSignature = $true
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_EXECUTOR_LOCK_BUSY' $global:MockCodexRefreshPath
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'executor winning the lock race prevents config writes'
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionState))) `
        ([BitConverter]::ToString($transitionManifestBytes)) 'executor winning the lock race prevents manifest writes'
    $competingLockPath = Join-Path $global:MockSpool 'locks\executor.active'
    Assert-Equal (Test-Path -LiteralPath $competingLockPath) $true 'refresh preserves the competing executor lock'
    Remove-Item -LiteralPath $competingLockPath -Force

    $badSignaturePath = $global:MockCodexRefreshPath
    $global:MockBadSignaturePath = $badSignaturePath
    $null = Invoke-CliRefreshAttempt 'CODEX_EXECUTABLE_SIGNATURE_NOT_QUALIFIED' $badSignaturePath
    $global:MockBadSignaturePath = ''
    $global:MockProcesses = @()

    $lockedConfig = Get-Content -LiteralPath $transitionConfigPath -Raw | ConvertFrom-Json
    $lockedConfig.enable_codex_model_runs = $true
    [IO.File]::WriteAllText($transitionConfigPath, (ConvertTo-Json -InputObject $lockedConfig -Depth 20 -Compress) + [Environment]::NewLine,
        [Text.Encoding]::UTF8)
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_MODEL_AUTHORIZATION_MUST_REMAIN_DISABLED' $global:MockCodexRefreshPath
    [IO.File]::WriteAllBytes($transitionConfigPath, $transitionConfigBytes)

    $manifestTextBeforeMismatch = [IO.File]::ReadAllText($transitionState)
    [IO.File]::WriteAllText($transitionState, $manifestTextBeforeMismatch.Replace('DESKTOP-1B6PD2P','OTHER-HOST'),
        [System.Text.UTF8Encoding]::new($false))
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_INSTALL_STATE_IDENTITY_MISMATCH' $global:MockCodexRefreshPath
    [IO.File]::WriteAllBytes($transitionState, $transitionManifestBytes)

    $claimProbe = Join-Path $global:MockSpool 'claims\unknown-attempt.json'
    [IO.File]::WriteAllText($claimProbe, 'preserve')
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_ACTIVE_CLAIM_OR_LOCK_PRESENT' $global:MockCodexRefreshPath
    Assert-Equal (Get-Content -LiteralPath $claimProbe -Raw) 'preserve' 'unknown claim is preserved and blocks CLI refresh'
    Remove-Item -LiteralPath $claimProbe -Force

    $settledRequestId = 'CODEX_REFRESH_SETTLED_01'
    $settledAttemptId = '123e4567-e89b-42d3-a456-426614174000'
    $settledClaimPath = Join-Path $global:MockSpool ("claims\$settledRequestId-$settledAttemptId.json")
    $settledResultPath = Join-Path $global:MockSpool ("results\$settledRequestId-$settledAttemptId.json")
    $settledClaim = [ordered]@{ schema=1; request_id=$settledRequestId; attempt_id=$settledAttemptId
        source_sha=('a' * 40); fingerprint=('b' * 64) }
    $settledResult = [ordered]@{ schema=1; kind='codex_plan'; request_id=$settledRequestId
        attempt_id=$settledAttemptId; source_sha=$settledClaim.source_sha; fingerprint=$settledClaim.fingerprint
        outcome='BLOCKED'; model_invoked=$false; session_started=$false;
        termination_state='NOT_STARTED'; termination_error=$null }
    [IO.File]::WriteAllText($settledClaimPath, (ConvertTo-Json -InputObject $settledClaim -Compress),
        [Text.UTF8Encoding]::new($false))
    $settledClaimBytes = [IO.File]::ReadAllBytes($settledClaimPath)
    $settledResult.request_id = 'CODEX_REFRESH_OTHER_01'
    [IO.File]::WriteAllText($settledResultPath, (ConvertTo-Json -InputObject $settledResult -Compress),
        [Text.UTF8Encoding]::new($false))
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_ACTIVE_CLAIM_OR_LOCK_PRESENT' $global:MockCodexRefreshPath
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'mismatched settled result blocks refresh without config writes'
    $settledResult.request_id = $settledRequestId
    foreach ($invalidTerminationState in @('ORPHAN_POSSIBLE','TERMINATION_REQUESTED',
        'TERMINATION_UNCONFIRMED','FINISHED','UNKNOWN')) {
        $settledResult.termination_state = $invalidTerminationState
        [IO.File]::WriteAllText($settledResultPath, (ConvertTo-Json -InputObject $settledResult -Compress),
            [Text.UTF8Encoding]::new($false))
        $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_ACTIVE_CLAIM_OR_LOCK_PRESENT' $global:MockCodexRefreshPath
        Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
            ([BitConverter]::ToString($transitionConfigBytes)) ('uncertain termination state blocks refresh without writes: ' + $invalidTerminationState)
    }
    $settledResult.termination_state = 'NOT_STARTED'
    $settledResult.model_invoked = $true
    $settledResult.session_started = $true
    [IO.File]::WriteAllText($settledResultPath, (ConvertTo-Json -InputObject $settledResult -Compress),
        [Text.UTF8Encoding]::new($false))
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_ACTIVE_CLAIM_OR_LOCK_PRESENT' $global:MockCodexRefreshPath
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'NOT_STARTED cannot describe a model invocation'
    $settledResult.termination_state = 'NOT_STARTED'
    $settledResult.model_invoked = $false
    $settledResult.session_started = $false
    $settledResult.termination_error = $null
    [IO.File]::WriteAllText($settledResultPath, (ConvertTo-Json -InputObject $settledResult -Compress),
        [Text.UTF8Encoding]::new($false))
    $notStartedRefreshOutput = & $installerPath -Mode RefreshCodexCli -ExecutionPhase WIN11_TRANSITION `
        -CodexExecutable $global:MockCodexRefreshPath 2>$null
    if (@($notStartedRefreshOutput | Where-Object { $_ -like 'CODEX_CLI_PIN_REFRESH=SUCCESS;*' }).Count -ne 1) {
        throw 'CODEX_CLI_REFRESH_VALID_NOT_STARTED_CLAIM_REJECTED'
    }
    [IO.File]::WriteAllBytes($transitionConfigPath, $transitionConfigBytes)
    [IO.File]::WriteAllBytes($transitionState, $transitionManifestBytes)

    $settledResult.termination_state = 'NOT_REQUESTED'
    $settledResult.model_invoked = $true
    $settledResult.session_started = $true
    $settledResult.termination_error = 'PROCESS_TREE_STILL_ACTIVE'
    [IO.File]::WriteAllText($settledResultPath, (ConvertTo-Json -InputObject $settledResult -Compress),
        [Text.UTF8Encoding]::new($false))
    $null = Invoke-CliRefreshAttempt 'CODEX_CLI_REFRESH_ACTIVE_CLAIM_OR_LOCK_PRESENT' $global:MockCodexRefreshPath
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($transitionConfigPath))) `
        ([BitConverter]::ToString($transitionConfigBytes)) 'termination error conflicts block refresh without writes'
    $settledResult.termination_state = 'NOT_REQUESTED'
    $settledResult.model_invoked = $true
    $settledResult.session_started = $true
    $settledResult.termination_error = $null
    [IO.File]::WriteAllText($settledResultPath, (ConvertTo-Json -InputObject $settledResult -Compress),
        [Text.UTF8Encoding]::new($false))
    $settledResultBytes = [IO.File]::ReadAllBytes($settledResultPath)

    $pendingRequest = Join-Path $global:MockSpool 'requests\pending.json'
    [IO.File]::WriteAllText($pendingRequest, 'leave-queued-request-untouched')

    $refreshOutput = & $installerPath -Mode RefreshCodexCli -ExecutionPhase WIN11_TRANSITION `
        -CodexExecutable $global:MockCodexRefreshPath 2>$null
    if (@($refreshOutput | Where-Object { $_ -like 'CODEX_CLI_PIN_REFRESH=SUCCESS;*' }).Count -ne 1) {
        throw 'CODEX_CLI_PIN_REFRESH_SUCCESS_RECEIPT_MISSING'
    }
    $refreshedConfig = Get-Content -LiteralPath $transitionConfigPath -Raw | ConvertFrom-Json
    Assert-Equal $refreshedConfig.codex_executable $global:MockCodexRefreshPath `
        'refresh updates only the missing official CLI executable path'
    Assert-Equal $refreshedConfig.codex_executable_sha256 `
        ((Get-FileHash -LiteralPath $global:MockCodexRefreshPath -Algorithm SHA256).Hash.ToLowerInvariant()) `
        'refresh reads back the signed CLI hash'
    Assert-Equal $refreshedConfig.enable_codex_model_runs $false 'refresh keeps model execution disabled'
    Assert-Equal $refreshedConfig.codex_usage_authorized $false 'refresh keeps usage authorization disabled'
    $refreshedManifest = Get-Content -LiteralPath $transitionState -Raw | ConvertFrom-Json
    Assert-Equal $refreshedManifest.runtime_sha256.'executor-config.json' `
        ((Get-FileHash -LiteralPath $transitionConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()) `
        'refresh updates the bound config hash in the existing install state'
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($workerConfigPath))) `
        ([BitConverter]::ToString($transitionWorkerBytes)) 'refresh does not change the Publisher config'
    Assert-Equal $global:MockRegisterCalls $registerCallsBeforeRefresh 'refresh does not register or recreate a task'
    Assert-Equal ([object]::ReferenceEquals($global:MockRegistration,$registrationBeforeRefresh)) $true `
        'refresh does not replace Task Scheduler settings or action'
    Assert-Equal (Get-Content -LiteralPath $pendingRequest -Raw) 'leave-queued-request-untouched' `
        'unclaimed queued request is preserved during CLI pin refresh'
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($settledClaimPath))) `
        ([BitConverter]::ToString($settledClaimBytes)) 'refresh preserves a byte-verified settled claim'
    Assert-Equal ([BitConverter]::ToString([IO.File]::ReadAllBytes($settledResultPath))) `
        ([BitConverter]::ToString($settledResultBytes)) 'refresh preserves its matching terminal result'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $global:MockSpool 'locks\executor.active')) $false `
        'refresh releases its shared executor lock after successful config and manifest readback'
    $backupDir = Join-Path (Split-Path -Parent (Split-Path -Parent $global:MockRuntime)) 'CodexExecutor\maintenance-backups'
    $backedUpConfig = @(Get-ChildItem -LiteralPath $backupDir -Filter '*-executor-config.json' -File)
    $backedUpManifest = @(Get-ChildItem -LiteralPath $backupDir -Filter '*-install-state.json' -File)
    Assert-Equal ($backedUpConfig.Count -gt 0) $true 'refresh keeps a byte-verified config rollback copy'
    Assert-Equal ($backedUpManifest.Count -gt 0) $true 'refresh keeps a byte-verified install-state rollback copy'
    Assert-Equal (Get-FileHash -LiteralPath $backedUpConfig[-1].FullName -Algorithm SHA256).Hash.ToLowerInvariant() `
        (Get-TestByteSha256 $transitionConfigBytes) 'config backup is byte-identical to the original'
    Assert-Equal (Get-FileHash -LiteralPath $backedUpManifest[-1].FullName -Algorithm SHA256).Hash.ToLowerInvariant() `
        (Get-TestByteSha256 $transitionManifestBytes) 'install-state backup is byte-identical to the original'

    # Restore the synthetic pre-refresh fixture so later installer recovery tests
    # continue from the original registered task/config state.
    [IO.File]::WriteAllBytes($transitionConfigPath, $transitionConfigBytes)
    [IO.File]::WriteAllBytes($transitionState, $transitionManifestBytes)
    [IO.File]::WriteAllText($global:MockCodexPath, 'synthetic signed Codex bundle codex.exe')
    Remove-Item -LiteralPath $global:MockCodexRefreshPath -Force
    Remove-Item -LiteralPath $pendingRequest -Force
    Remove-Item -LiteralPath $settledClaimPath,$settledResultPath -Force

    & $installerPath -Mode Uninstall 2>$null | Out-Null
    Assert-Equal $global:MockTaskRegistered $false 'transition task can be unregistered without deleting its evidence'
    Assert-Equal (Test-Path -LiteralPath $global:MockSpool) $true 'transition uninstall preserves the spool and install evidence'

    $configBeforePrincipalMismatch = Get-Content -LiteralPath $workerConfigPath -Raw
    $global:MockReadbackPrincipalUserId = 'S-1-5-18'
    $wrongPrincipalReadback = Invoke-InstallAttempt 'EXECUTOR_TASK_READBACK_MISMATCH' `
        -ExecutionPhase 'WIN11_TRANSITION' -NoCredential
    if ($wrongPrincipalReadback -notlike '*fields=Principal.UserId*' -or
        $wrongPrincipalReadback -like '*Triggers.Count*') {
        throw ('PRINCIPAL_SID_MISMATCH_NOT_ISOLATED: ' + $wrongPrincipalReadback)
    }
    Assert-Equal $global:MockTaskRegistered $false 'different principal SID is rejected and rolled back'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $configBeforePrincipalMismatch `
        'worker config is restored after principal SID mismatch'
    $global:MockReadbackPrincipalUserId = $null
    $global:MockNullReadbackTriggers = $false

    $broadAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $broadRule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,
        [System.Security.AccessControl.FileSystemRights]::Modify, $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $broadAcl.AddAccessRule($broadRule)
    $runtimeKey = [IO.Path]::GetFullPath($global:MockRuntime).ToLowerInvariant()
    $global:MockAclOverrides[$runtimeKey] = $broadAcl
    $registersBeforeAclRejection = $global:MockRegisterCalls
    $null = Invoke-InstallAttempt 'EXECUTOR_TRANSITION_ACL_BROAD_WRITE' `
        -ExecutionPhase 'WIN11_TRANSITION' -NoCredential
    Assert-Equal $global:MockRegisterCalls $registersBeforeAclRejection `
        'broad-writable transition runtime is rejected before Task Scheduler registration'
    $global:MockAclOverrides.Remove($runtimeKey)

    $parentAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $parentRule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,
        [System.Security.AccessControl.FileSystemRights]::Modify, $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $parentAcl.AddAccessRule($parentRule)
    $transitionParentKey = [IO.Path]::GetFullPath((Join-Path $local 'PTYSDNativeBridge')).ToLowerInvariant()
    $global:MockAclOverrides[$transitionParentKey] = $parentAcl
    $null = Invoke-InstallAttempt 'EXECUTOR_TRANSITION_ACL_BROAD_PARENT_REPLACEMENT' `
        -ExecutionPhase 'WIN11_TRANSITION' -NoCredential
    Assert-Equal $global:MockRegisterCalls $registersBeforeAclRejection `
        'broad parent replacement access is rejected before Task Scheduler registration'
    $global:MockAclOverrides.Remove($transitionParentKey)
    Write-Output 'INSTALL_RECOVERY_SYNTHETIC_TESTS=PASS;RECOVERY=FILE_HASH_AND_TASK_XML_READBACK;TASK_SCHEDULER=MOCKED;MODEL_EXECUTION=NOT_RUN'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'REFUSE_TEMP_CLEANUP_OUTSIDE_TEMP' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
