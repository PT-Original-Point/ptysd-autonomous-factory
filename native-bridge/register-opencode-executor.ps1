# Registration-only path for the existing on-demand W1/W2 Executors.
# WIN11_TRANSITION uses the current interactive identity without account or
# credential provisioning; VM_ISOLATED retains the separate-account contract.
# This script never starts the registered task or changes model-run flags.
[CmdletBinding()]
param(
    [ValidateSet('Audit','Register')][string]$Mode = 'Audit',
    [ValidateSet('opencode','antigravity')][string]$ExecutorLane = 'opencode',
    [PSCredential]$ExecutorCredential,
    [string]$PublisherConfigPath = (Join-Path $env:LOCALAPPDATA 'PTYSDNativeBridge\config.json'),
    [string]$NodeExecutable = (Join-Path $env:ProgramFiles 'nodejs\node.exe')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedRepo = 'PT-Original-Point/ptysd-autonomous-factory'
$expectedProject = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE'
$laneUpper = $ExecutorLane.ToUpperInvariant()
$builderPath = Join-Path $PSScriptRoot 'build-executor-task-xml.mjs'

function Fail([string]$Code) { throw $Code }

function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-TaskOptional([string]$TaskName, [string]$TaskPath) {
    $items = @(Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue)
    if ($items.Count -gt 1) { Fail 'EXECUTOR_TASK_NAME_NOT_UNIQUE' }
    if ($items.Count -eq 0) { return $null }
    return $items[0]
}

function Test-TaskFolder([string]$TaskPath) {
    try {
        $service = New-Object -ComObject Schedule.Service
        $service.Connect()
        $null = $service.GetFolder($TaskPath)
        return $true
    } catch { return $false }
}

function Resolve-Sid([string]$Name) {
    if ($Name -match '^S-1-(?:\d+-)+\d+$') { return $Name.ToUpperInvariant() }
    try { return ([Security.Principal.NTAccount]$Name).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { Fail 'EXECUTOR_ACCOUNT_SID_UNRESOLVED' }
}
function Assert-PhysicalPath([string]$Path, [switch]$Directory) {
    if (-not $Path -or -not [IO.Path]::IsPathRooted($Path)) { Fail 'EXECUTOR_PATH_NOT_ABSOLUTE' }
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail 'EXECUTOR_PATH_REPARSE_POINT_REVIEW_REQUIRED'
            }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    if (-not (Test-Path -LiteralPath $full -PathType $(if ($Directory) { 'Container' } else { 'Leaf' }))) {
        Fail 'EXECUTOR_PATH_MISSING'
    }
    return $full
}

function Assert-MachineExecutable([string]$Path) {
    $full = Assert-PhysicalPath $Path
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    $machinePath = $false
    foreach ($root in $roots) {
        $prefix = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar) +
            [IO.Path]::DirectorySeparatorChar
        if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $machinePath = $true; break }
    }
    if (-not $machinePath) { Fail 'EXECUTOR_NODE_MUST_BE_MACHINE_ACCESSIBLE' }
    return $full
}

function Assert-ExplicitRole([string]$Path, [string]$Sid,
    [System.Security.AccessControl.FileSystemRights]$RequiredRights, [switch]$Protected) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if ($Protected -and -not $acl.AreAccessRulesProtected) { Fail 'EXECUTOR_ACL_INHERITANCE_NOT_PROTECTED' }
    $required = [int]$RequiredRights
    $matchingRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
        Where-Object { $_.IdentityReference.Value -ieq $Sid })
    foreach ($rule in $matchingRules) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
            (([int]$rule.FileSystemRights -band $required) -ne 0)) {
            Fail 'EXECUTOR_ACL_REQUIRED_ROLE_DENIED'
        }
    }
    $found = $false
    foreach ($rule in $matchingRules) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $rights = [int]$rule.FileSystemRights
        if (($rights -band $required) -eq $required) { $found = $true; break }
    }
    if (-not $found) { Fail 'EXECUTOR_ACL_REQUIRED_ROLE_MISSING' }
}

function Get-ExecutorWriteRightsMask {
    # Modify includes ReadAndExecute bits; testing the composite flag therefore
    # misclassifies ordinary read-only ACLs as writable. Keep only write/delete
    # rights so inherited Users/Authenticated Users read ACEs remain admissible.
    return [int]([System.Security.AccessControl.FileSystemRights]::Write -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
}

function Get-ExecutorParentReplacementRightsMask {
    # DELETE on an ancestor applies to that directory itself, not its children.
    # DELETE_CHILD can remove a child subtree; permission/ownership changes can
    # take it over. The protected path itself receives the full write-mask check.
    return [int]([System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
}

function Assert-NoBroadWrite([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $broadSids = @('S-1-1-0','S-1-5-11','S-1-5-32-545')
    $writeMask = Get-ExecutorWriteRightsMask
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($rule.IdentityReference.Value -notin $broadSids) { continue }
        if (([int]$rule.FileSystemRights -band $writeMask) -ne 0) {
            Fail 'EXECUTOR_ACL_BROAD_WRITE_PRINCIPAL'
        }
    }
}

function Assert-NoBroadParentReplacement([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $broadSids = @('S-1-1-0','S-1-5-11','S-1-5-32-545')
    $replacementMask = Get-ExecutorParentReplacementRightsMask
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -notin $broadSids) { continue }
        if (([int]$rule.FileSystemRights -band $replacementMask) -ne 0) {
            Fail 'EXECUTOR_ACL_BROAD_PARENT_REPLACEMENT'
        }
    }
}

function Assert-RoleReadOnly([string]$Path, [string]$Sid) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $writeMask = Get-ExecutorWriteRightsMask
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -ine $Sid) { continue }
        if (([int]$rule.FileSystemRights -band $writeMask) -ne 0) {
            Fail 'EXECUTOR_RUNTIME_MUST_BE_READ_ONLY'
        }
    }
}

function Test-ExecutorWritableMailboxAlias([string]$Path, $Descriptor) {
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@([char]92,[char]47))
    foreach ($mailboxPath in @([string]$Descriptor.manifest_dir, [string]$Descriptor.results_dir)) {
        $mailbox = [IO.Path]::GetFullPath($mailboxPath).TrimEnd([char[]]@([char]92,[char]47))
        if ([String]::Equals($fullPath, $mailbox, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Assert-ExecutorWorkingDirectoryReadOnlyOrMailbox([string]$Path, $Descriptor, [string]$ExecutorSid) {
    if (Test-ExecutorWritableMailboxAlias $Path $Descriptor) { return }
    Assert-RoleReadOnly $Path $ExecutorSid
}

function Assert-ExecutorPathParentsReadOnly([string]$Path, [string]$ExecutorSid, [switch]$BroadOnly) {
    # Ancestors may grant child-creation rights without allowing a broad principal
    # to replace the protected subtree. In WIN11_TRANSITION, same-SID role ACLs
    # cannot distinguish Publisher from Executor, so retain only broad-principal checks.
    $cursor = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    while ($cursor) {
        Assert-NoBroadParentReplacement $cursor
        if (-not $BroadOnly) { Assert-RoleReadOnly $cursor $ExecutorSid }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Assert-ExecutorConfig($Config, $Descriptor, [string]$ExecutorSid, [string]$PublisherSid, [string]$ExecutorLane) {
    $issue = [string](Get-Field $Config 'issue')
    # Get-Field intentionally unwraps singleton arrays; preserve dispatchers as
    # an array because this identity field is validated as a list.
    $dispatchersProperty = $Config.PSObject.Properties['dispatchers']
    if ($null -eq $dispatchersProperty) { $dispatchers = $null }
    else { $dispatchers = $dispatchersProperty.Value }
    if ((Get-Field $Config 'repo') -cne $expectedRepo -or
        (Get-Field $Config 'project_id') -cne $expectedProject -or
        [string](Get-Field $Config 'host') -ine $env:COMPUTERNAME -or
        $issue -ne '407' -or
        -not ($dispatchers -is [System.Array]) -or $dispatchers.Count -lt 1) {
        Fail 'EXECUTOR_CONFIG_IDENTITY_INVALID'
    }
    $runtime = Get-Field $Config 'executor_runtime'
    $descriptorPhase = [string](Get-Field $Descriptor 'execution_phase')
    $runtimePhase = [string](Get-Field $runtime 'execution_phase')
    if (-not $descriptorPhase) { $descriptorPhase = 'VM_ISOLATED' }
    if (-not $runtimePhase) { $runtimePhase = 'VM_ISOLATED' }
    if ($descriptorPhase -notin @('WIN11_TRANSITION','VM_ISOLATED') -or
        $runtimePhase -notin @('WIN11_TRANSITION','VM_ISOLATED') -or
        $descriptorPhase -cne $runtimePhase) {
        Fail 'EXECUTOR_EXECUTION_PHASE_MISMATCH'
    }
    if ((Get-Field $Descriptor 'user_sid') -ine $ExecutorSid -or
        (Get-Field $Descriptor 'publisher_sid') -ine $PublisherSid) { Fail 'EXECUTOR_DESCRIPTOR_IDENTITY_MISMATCH' }
    if ($null -eq $runtime -or (Get-Field $runtime 'user_sid') -ine $ExecutorSid -or
        (Get-Field $runtime 'publisher_sid') -ine $PublisherSid -or
        [IO.Path]::GetFullPath([string](Get-Field $runtime 'manifest_dir')) -ine
            [IO.Path]::GetFullPath([string](Get-Field $Descriptor 'manifest_dir')) -or
        [IO.Path]::GetFullPath([string](Get-Field $runtime 'results_dir')) -ine
            [IO.Path]::GetFullPath([string](Get-Field $Descriptor 'results_dir')) -or
        [IO.Path]::GetFullPath([string](Get-Field $Config 'state_dir')) -ine
            [IO.Path]::GetFullPath([string](Get-Field $Descriptor 'results_dir'))) {
        Fail 'EXECUTOR_RUNTIME_DESCRIPTOR_MISMATCH'
    }
    if (($descriptorPhase -eq 'WIN11_TRANSITION' -and $ExecutorSid -ine $PublisherSid) -or
        ($descriptorPhase -eq 'VM_ISOLATED' -and $ExecutorSid -ieq $PublisherSid)) {
        Fail 'EXECUTOR_IDENTITY_NOT_SEPARATE'
    }
}
if (-not (Test-Path -LiteralPath $PublisherConfigPath -PathType Leaf)) {
    if ($Mode -eq 'Audit') {
        Write-Output 'OPENCODE_EXECUTOR_DESCRIPTOR=NOT_CONFIGURED;TASK_REGISTRATION=NOT_ATTEMPTED;MODEL_EXECUTION=NOT_TESTED'
        return
    }
    Fail 'EXISTING_PUBLISHER_CONFIG_REQUIRED'
}

$publisherConfig = Get-Content -LiteralPath $PublisherConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json
$executorMap = Get-Field $publisherConfig 'executors'
$legacyDescriptor = Get-Field $publisherConfig 'executor'
$configuredLaneProperty = $publisherConfig.PSObject.Properties['executor_lane']
$configuredLaneConfigured = $null -ne $configuredLaneProperty
$configuredLane = $null
if ($configuredLaneConfigured) { $configuredLane = $configuredLaneProperty.Value }
if (($null -ne $executorMap -and $null -ne $legacyDescriptor) -or
    ($null -ne $executorMap -and $configuredLaneConfigured)) {
    Fail 'EXECUTOR_ROUTING_CONFIG_AMBIGUOUS'
}
if ($null -ne $executorMap) {
    $descriptor = Get-Field $executorMap $ExecutorLane
} elseif ($configuredLaneConfigured) {
    if ($configuredLane -isnot [string] -or
        $configuredLane -cnotin @('opencode', 'antigravity') -or
        $null -eq $legacyDescriptor) {
        Fail 'EXECUTOR_LANE_CONFIG_INVALID'
    }
    if ($configuredLane -ceq $ExecutorLane) { $descriptor = $legacyDescriptor }
    else { $descriptor = $null }
} elseif ($ExecutorLane -eq 'opencode') {
    # Compatibility for existing single-OpenCode configurations. Antigravity
    # always requires an explicit lane entry and cannot inherit the W1 task.
    $descriptor = $legacyDescriptor
} else {
    $descriptor = $null
}
if ($null -eq $descriptor) {
    if ($Mode -eq 'Audit') {
        Write-Output ($laneUpper + '_EXECUTOR_DESCRIPTOR=NOT_CONFIGURED;TASK_REGISTRATION=NOT_ATTEMPTED;MODEL_EXECUTION=NOT_TESTED')
        return
    }
    Fail ('EXECUTOR_NOT_CONFIGURED_FOR_' + $laneUpper)
}

$executionPhase = [string](Get-Field $descriptor 'execution_phase')
if (-not $executionPhase) { $executionPhase = 'VM_ISOLATED' }
if ($executionPhase -notin @('WIN11_TRANSITION','VM_ISOLATED')) { Fail 'EXECUTOR_EXECUTION_PHASE_INVALID' }
$isTransition = $executionPhase -eq 'WIN11_TRANSITION'
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $builderPath -PathType Leaf)) { Fail 'TASK_XML_BUILDER_OR_NODE_MISSING' }
$nodePath = Assert-MachineExecutable $NodeExecutable
$descriptorNodePath = [IO.Path]::GetFullPath([string](Get-Field $descriptor 'node_bin'))
if ($nodePath -ine $descriptorNodePath) { Fail 'TASK_BUILDER_NODE_DESCRIPTOR_MISMATCH' }
$null = Assert-PhysicalPath $builderPath
$null = Assert-PhysicalPath $PublisherConfigPath
$publisherSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($publisherSid -ine [string](Get-Field $descriptor 'publisher_sid')) { Fail 'PUBLISHER_IDENTITY_READBACK_MISMATCH' }
$taskNameFull = [string](Get-Field $descriptor 'task_name')
$separator = $taskNameFull.LastIndexOf('\')
if ($separator -eq 0) {
    # A root task such as \PTYSD-OpenCode-Executor needs no custom folder.
    $taskPath = '\'
} elseif ($separator -lt 0 -or $separator -eq ($taskNameFull.Length - 1)) {
    Fail 'EXECUTOR_TASK_NAME_INVALID'
} else {
    $taskPath = $taskNameFull.Substring(0, $separator + 1)
}
$taskName = $taskNameFull.Substring($separator + 1)
$taskFolderExists = ($taskPath -eq '\') -or (Test-TaskFolder $taskPath)
$existing = Get-TaskOptional $taskName $taskPath
if ($Mode -eq 'Audit') {
    if (-not $taskFolderExists) {
        Write-Output ($laneUpper + '_EXECUTOR_TASK_FOLDER=ABSENT;DESCRIPTOR=' + $taskNameFull + ';TASK_REGISTRATION=NOT_ATTEMPTED')
        return
    }
    if ($null -eq $existing) {
        Write-Output ($laneUpper + '_EXECUTOR_TASK=ABSENT;DESCRIPTOR=' + $taskNameFull + ';MODEL_EXECUTION=NOT_TESTED')
        return
    }
    Write-Output ($laneUpper + '_EXECUTOR_TASK=' + $existing.State + ';DESCRIPTOR=' + $taskNameFull + ';MODEL_EXECUTION=NOT_TESTED')
    return
}
if (-not $taskFolderExists) { Fail 'EXECUTOR_TASK_FOLDER_NOT_FOUND_NO_CREATE' }
if ($null -ne $existing) { Fail 'EXECUTOR_TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE' }
if ($isTransition) {
    if ($null -ne $ExecutorCredential) { Fail 'TRANSITION_MUST_NOT_USE_SEPARATE_CREDENTIAL' }
    $executorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($executorSid -ine [string](Get-Field $descriptor 'user_sid') -or $executorSid -ine $publisherSid) {
        Fail 'EXECUTOR_TRANSITION_IDENTITY_MISMATCH'
    }
} else {
    if ($null -eq $ExecutorCredential) { Fail 'SEPARATE_EXECUTOR_CREDENTIAL_REQUIRED' }
    $executorSid = Resolve-Sid $ExecutorCredential.UserName
    if ($executorSid -ine [string](Get-Field $descriptor 'user_sid') -or $executorSid -ieq $publisherSid -or
        $executorSid -in @('S-1-5-18','S-1-5-19','S-1-5-20','S-1-5-32-544') -or
        $executorSid -match '^S-1-5-80-') {
        Fail 'EXECUTOR_IDENTITY_NOT_SEPARATE'
    }
    try {
        $admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop)
        if ($admins.SID.Value -contains $executorSid) { Fail 'EXECUTOR_MUST_BE_STANDARD_USER' }
    } catch {
        if ($_.Exception.Message -eq 'EXECUTOR_MUST_BE_STANDARD_USER') { throw }
        Fail 'EXECUTOR_ADMIN_MEMBERSHIP_UNKNOWN_STOP'
    }
}
$descriptorPaths = @{
    wscript_path=@{ Directory=$false; Rights=$null }
    node_bin=@{ Directory=$false; Rights=$null }
    launcher_path=@{ Directory=$false; Rights=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute }
    script_path=@{ Directory=$false; Rights=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute }
    config_path=@{ Directory=$false; Rights=[System.Security.AccessControl.FileSystemRights]::Read }
    manifest_dir=@{ Directory=$true; Rights=[System.Security.AccessControl.FileSystemRights]::Modify }
    results_dir=@{ Directory=$true; Rights=[System.Security.AccessControl.FileSystemRights]::Modify }
    working_directory=@{ Directory=$true; Rights=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute }
}
foreach ($entry in $descriptorPaths.GetEnumerator()) {
    $path = [string](Get-Field $descriptor $entry.Key)
    $isDirectory = [bool]$entry.Value.Directory
    $null = Assert-PhysicalPath $path -Directory:$isDirectory
    Assert-NoBroadWrite $path
    if (-not $isTransition) {
        if ($null -ne $entry.Value.Rights) {
            Assert-ExplicitRole $path $executorSid $entry.Value.Rights -Protected:$isDirectory
        }
        if ($entry.Key -in @('wscript_path','launcher_path','node_bin','script_path','config_path')) {
            Assert-RoleReadOnly $path $executorSid
        }
        if ($entry.Key -eq 'working_directory') {
            Assert-ExecutorWorkingDirectoryReadOnlyOrMailbox $path $descriptor $executorSid
        }
    }
    if ($entry.Key -in @('wscript_path','launcher_path','node_bin','script_path','config_path','working_directory')) {
        Assert-ExecutorPathParentsReadOnly $path $executorSid -BroadOnly:$isTransition
    }
}
if (-not $isTransition) {
    Assert-ExplicitRole ([string](Get-Field $descriptor 'manifest_dir')) $publisherSid `
        ([System.Security.AccessControl.FileSystemRights]::Modify) -Protected
    Assert-ExplicitRole ([string](Get-Field $descriptor 'results_dir')) $publisherSid `
        ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) -Protected
}
$executorConfigPath = Assert-PhysicalPath ([string](Get-Field $descriptor 'config_path'))
$executorConfig = Get-Content -LiteralPath $executorConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json
Assert-ExecutorConfig $executorConfig $descriptor $executorSid $publisherSid $ExecutorLane
$executorProfile = @(Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$executorSid'" -ErrorAction Stop)
if ($executorProfile.Count -ne 1 -or -not $executorProfile[0].LocalPath) { Fail 'EXECUTOR_PROFILE_NOT_RESOLVED' }
$profileRoot = [IO.Path]::GetFullPath([string]$executorProfile[0].LocalPath).TrimEnd([char[]]@('\','/')) +
    [IO.Path]::DirectorySeparatorChar
if ($isTransition) {
    if (-not $executorProfile[0].Loaded -or -not $env:USERPROFILE -or
        [IO.Path]::GetFullPath($env:USERPROFILE) -ine [IO.Path]::GetFullPath([string]$executorProfile[0].LocalPath)) {
        Fail 'EXECUTOR_CURRENT_PROFILE_NOT_LOADED'
    }
    foreach ($profileField in @('workspace','state_dir')) {
        $null = Assert-PhysicalPath ([IO.Path]::GetFullPath([string](Get-Field $executorConfig $profileField))) -Directory
    }
} else {
    foreach ($profileField in @('workspace','state_dir')) {
        $profilePath = [IO.Path]::GetFullPath([string](Get-Field $executorConfig $profileField))
        if (-not $profilePath.StartsWith($profileRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Fail 'EXECUTOR_WORKSPACE_OR_STATE_OUTSIDE_PROFILE'
        }
        $null = Assert-PhysicalPath $profilePath -Directory
    }
}
# The shared JS template is the sole source for Task Scheduler XML. The helper
# validates the descriptor again and emits no configuration or credential data.
$xmlOutput = & $NodeExecutable $builderPath $PublisherConfigPath $ExecutorLane
if ($LASTEXITCODE -ne 0 -or -not $xmlOutput) { Fail 'EXECUTOR_TASK_XML_BUILD_FAILED' }
$xmlText = $xmlOutput -join [Environment]::NewLine
[xml]$taskDefinition = $xmlText
$namespace = New-Object System.Xml.XmlNamespaceManager($taskDefinition.NameTable)
$namespace.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
$expectedArguments = $taskDefinition.SelectSingleNode('//t:Arguments', $namespace).InnerText
$password = $null
try {
    if ($isTransition) {
        Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Xml $xmlText -ErrorAction Stop | Out-Null
    } else {
        $password = $ExecutorCredential.GetNetworkCredential().Password
        Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Xml $xmlText `
            -User $ExecutorCredential.UserName -Password $password -ErrorAction Stop | Out-Null
    }
} catch {
    # Registration can succeed before a provider/readback error. Never retry or
    # remove an ambiguously-created task; the next action is exact OS readback.
    Fail 'EXECUTOR_TASK_REGISTRATION_OUTCOME_UNKNOWN_READBACK_REQUIRED'
} finally { $password = $null }
$readback = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
$timeLimit = [string]$readback.Settings.ExecutionTimeLimit
$zeroLimit = ($readback.Settings.ExecutionTimeLimit -eq [TimeSpan]::Zero) -or
    ($timeLimit -eq 'PT0S') -or ($timeLimit -eq '00:00:00')
$expectedLogonType = if ($isTransition) { 'InteractiveToken' } else { 'Password' }
$readbackUserSid = Resolve-Sid ([string]$readback.Principal.UserId)
if ([int]$readback.State -ne 3 -or
    $readbackUserSid -ine $executorSid -or
    $readback.Principal.LogonType -ne $expectedLogonType -or $readback.Principal.RunLevel -ne 'Limited' -or
    $readback.Settings.MultipleInstances -ne 'IgnoreNew' -or -not $zeroLimit -or
    $readback.Settings.Hidden -ne $true -or $readback.Settings.AllowHardTerminate -ne $false -or
    @($readback.Triggers).Count -ne 0 -or @($readback.Actions).Count -ne 1 -or
    [IO.Path]::GetFullPath($readback.Actions[0].Execute) -ine
        [IO.Path]::GetFullPath([string](Get-Field $descriptor 'wscript_path')) -or
    $readback.Actions[0].Arguments -ne $expectedArguments -or
    $readback.Actions[0].WorkingDirectory -ine [string](Get-Field $descriptor 'working_directory')) {
    Fail 'EXECUTOR_TASK_READBACK_MISMATCH'
}
Write-Output ($laneUpper + '_EXECUTOR_TASK_REGISTERED=' + $taskNameFull + ';Logon=' +
    $expectedLogonType + ';RunLevel=Limited;Instances=IgnoreNew;ExecutionTimeLimit=PT0S;Triggers=0')
Write-Output 'MODEL_EXECUTION=UNCHANGED;NO_TASK_START_PERFORMED'
