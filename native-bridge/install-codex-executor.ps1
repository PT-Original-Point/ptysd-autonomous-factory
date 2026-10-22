# Source-only installer for the on-demand Codex Executor.
# It never changes PTYSD-Native-OpenCode or HiddenWorker.vbs. Do not execute this
# installer before the exact source and the Human model/cost gates are accepted.
[CmdletBinding()]
param(
    [ValidateSet('Audit','Install','Uninstall')][string]$Mode = 'Audit',
    [ValidateSet('WIN11_TRANSITION','VM_ISOLATED')][string]$ExecutionPhase = 'VM_ISOLATED',
    [PSCredential]$ExecutorCredential,
    [string]$NodeExecutable = '',
    [string]$CodexExecutable = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedHost = 'DESKTOP-1B6PD2P'
$executorTaskName = 'PTYSD-Codex-Executor'
$dispatcherTaskName = 'PTYSD-Native-OpenCode'
$project = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE'
$repo = 'PT-Original-Point/ptysd-autonomous-factory'
$sourceRoot = $PSScriptRoot
$isTransition = $ExecutionPhase -eq 'WIN11_TRANSITION'
$publisherSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$workerConfigPath = Join-Path $env:LOCALAPPDATA 'PTYSDNativeBridge\config.json'
# A same-user transition runs from the loaded x profile and does not change ACLs
# or stage a second Codex CLI. VM_ISOLATED retains the dedicated ProgramData tree.
$sharedBase = if ($isTransition) {
    Join-Path $env:LOCALAPPDATA 'PTYSDNativeBridge\CodexExecutor'
} else {
    Join-Path $env:ProgramData 'PTYSDCodexExecutor'
}
$spoolDir = Join-Path $sharedBase 'CodexSpool'
$runtimeDir = Join-Path $sharedBase 'CodexRuntime'
$executorConfigPath = Join-Path $runtimeDir 'executor-config.json'
$executorScriptPath = Join-Path $runtimeDir 'codex-executor.mjs'
$continuationScriptPath = Join-Path $runtimeDir 'codex-continuation.mjs'
$launcherPath = Join-Path $runtimeDir 'HiddenCodexExecutor.vbs'
$installStatePath = Join-Path (Split-Path -Parent $workerConfigPath) `
    ('codex-executor-install-state-' + $ExecutionPhase + '.json')
$backupPath = $null
$registeredHere = $false

function Get-TaskOptional([string]$Name, [switch]$Strict) {
    $readErrorAction = if ($Strict) { 'Stop' } else { 'SilentlyContinue' }
    $items = @(Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction $readErrorAction)
    if ($items.Count -gt 1) { throw ('TASK_NAME_NOT_UNIQUE: ' + $Name) }
    if ($items.Count -eq 0) { return $null }
    return $items[0]
}

function Assert-CodexExecutorInstallPathChain([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'INSTALL_REPARSE_POINT_REVIEW_REQUIRED'
            }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-CodexExecutorTransitionAcl([string]$Path) {
    $target = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $writeMask = [int]([System.Security.AccessControl.FileSystemRights]::Write -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
    $parentReplacementMask = [int]([System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
    $broadSids = @('S-1-1-0','S-1-5-11','S-1-5-32-545')
    $cursor = $target
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'EXECUTOR_TRANSITION_REPARSE_POINT_REVIEW_REQUIRED'
            }
            try { $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop }
            catch { throw 'EXECUTOR_TRANSITION_ACL_READBACK_FAILED' }
            $isTarget = [string]::Equals($cursor, $target, [StringComparison]::OrdinalIgnoreCase)
            $deniedRights = if ($isTarget) { $writeMask } else { $parentReplacementMask }
            foreach ($rule in @($acl.GetAccessRules($true, $true,
                [System.Security.Principal.SecurityIdentifier]))) {
                if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                    $rule.IdentityReference.Value -notin $broadSids) { continue }
                if (([int]$rule.FileSystemRights -band $deniedRights) -ne 0) {
                    if ($isTarget) { throw 'EXECUTOR_TRANSITION_ACL_BROAD_WRITE' }
                    throw 'EXECUTOR_TRANSITION_ACL_BROAD_PARENT_REPLACEMENT'
                }
            }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-CodexExecutorInstallTree([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) {
        return [pscustomobject]@{ Exists = $false; Directories = @(); Files = @() }
    }
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (-not $rootItem.PSIsContainer) { throw 'INSTALL_TARGET_NOT_DIRECTORY_REVIEW_REQUIRED' }
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'INSTALL_REPARSE_POINT_REVIEW_REQUIRED'
    }
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($fullRoot)
    $directories = New-Object System.Collections.Generic.List[string]
    $files = New-Object System.Collections.Generic.List[string]
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            $item = Get-Item -LiteralPath $entry -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'INSTALL_REPARSE_POINT_REVIEW_REQUIRED'
            }
            $relative = $item.FullName.Substring($fullRoot.Length).TrimStart([char[]]@(
                [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
            if ($item.PSIsContainer) {
                $directories.Add($relative)
                $stack.Push($item.FullName)
            } else {
                $files.Add($relative)
            }
        }
    }
    return [pscustomobject]@{ Exists = $true; Directories = @($directories.ToArray()); Files = @($files.ToArray()) }
}

function Assert-CodexExecutorInstallArtifacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SpoolPath,
        [Parameter(Mandatory)][string]$RuntimePath,
        [Parameter(Mandatory)][string[]]$SpoolDirectoryNames,
        [Parameter(Mandatory)][System.Collections.IDictionary]$ExpectedRuntimeHashes,
        [switch]$RequireComplete
    )
    Assert-CodexExecutorInstallPathChain $SpoolPath
    Assert-CodexExecutorInstallPathChain $RuntimePath
    $spool = Get-CodexExecutorInstallTree $SpoolPath
    $runtime = Get-CodexExecutorInstallTree $RuntimePath
    foreach ($relative in $spool.Directories) {
        if (-not (@($SpoolDirectoryNames | Where-Object { $_ -ieq $relative }).Count)) {
            throw 'INSTALL_UNEXPECTED_SPOOL_DIRECTORY_REVIEW_REQUIRED'
        }
    }
    if ($spool.Files.Count -gt 0) { throw 'INSTALL_SPOOL_DATA_REVIEW_REQUIRED' }
    if ($runtime.Directories.Count -gt 0) { throw 'INSTALL_UNEXPECTED_RUNTIME_DIRECTORY_REVIEW_REQUIRED' }
    foreach ($relative in $runtime.Files) {
        $name = @($ExpectedRuntimeHashes.Keys | Where-Object { $_ -ieq $relative }) | Select-Object -First 1
        if (-not $name) { throw 'INSTALL_UNEXPECTED_RUNTIME_FILE_REVIEW_REQUIRED' }
        $actualHash = (Get-FileHash -LiteralPath (Join-Path $RuntimePath $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne [string]$ExpectedRuntimeHashes[$name]) { throw 'INSTALL_RUNTIME_HASH_MISMATCH_REVIEW_REQUIRED' }
    }
    if ($RequireComplete) {
        foreach ($relative in $SpoolDirectoryNames) {
            if (-not (Test-Path -LiteralPath (Join-Path $SpoolPath $relative) -PathType Container)) {
                throw 'INSTALL_REQUIRED_DIRECTORY_MISSING'
            }
        }
        if (-not $runtime.Exists -or $runtime.Files.Count -ne $ExpectedRuntimeHashes.Count) {
            throw 'INSTALL_RUNTIME_FILES_INCOMPLETE'
        }
        foreach ($name in $ExpectedRuntimeHashes.Keys) {
            if (-not (@($runtime.Files | Where-Object { $_ -ieq [string]$name }).Count)) {
                throw 'INSTALL_RUNTIME_FILES_INCOMPLETE'
            }
        }
    }
}

function Initialize-CodexExecutorInstallState([string]$ManifestPath, [string]$ManifestText,
    [string]$SpoolPath, [string]$RuntimePath, [string[]]$SpoolDirectoryNames,
    [System.Collections.IDictionary]$ExpectedRuntimeHashes) {
    Assert-CodexExecutorInstallPathChain $ManifestPath
    Assert-CodexExecutorInstallPathChain $SpoolPath
    Assert-CodexExecutorInstallPathChain $RuntimePath
    if (Test-Path -LiteralPath $ManifestPath) {
        $item = Get-Item -LiteralPath $ManifestPath -Force
        if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'CODEX_EXECUTOR_INSTALL_STATE_REVIEW_REQUIRED'
        }
        $existing = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop
        if ($existing -cne $ManifestText) { throw 'CODEX_EXECUTOR_INSTALL_STATE_MISMATCH_REVIEW_REQUIRED' }
        Assert-CodexExecutorInstallArtifacts -SpoolPath $SpoolPath -RuntimePath $RuntimePath `
            -SpoolDirectoryNames $SpoolDirectoryNames -ExpectedRuntimeHashes $ExpectedRuntimeHashes
        return 'RESUME_SAFE'
    }
    if ((Test-Path -LiteralPath $SpoolPath) -or (Test-Path -LiteralPath $RuntimePath)) {
        throw 'CODEX_EXECUTOR_PATH_ALREADY_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE'
    }
    $parent = Split-Path -Parent $ManifestPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw 'CODEX_EXECUTOR_INSTALL_STATE_PARENT_MISSING'
    }
    $bytes = ([System.Text.UTF8Encoding]::new($false)).GetBytes($ManifestText)
    $stream = $null
    try {
        $stream = [IO.File]::Open($ManifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } catch { throw 'CODEX_EXECUTOR_INSTALL_STATE_CREATE_FAILED_REVIEW_REQUIRED' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    if ((Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop) -cne $ManifestText) {
        throw 'CODEX_EXECUTOR_INSTALL_STATE_READBACK_MISMATCH'
    }
    return 'CREATED'
}

function Ensure-CodexExecutorInstallDirectories([string]$SharedPath, [string]$SpoolPath, [string]$RuntimePath,
    [string[]]$SpoolDirectoryNames) {
    foreach ($path in @($SharedPath,$SpoolPath) + @($SpoolDirectoryNames | ForEach-Object { Join-Path $SpoolPath $_ }) + @($RuntimePath)) {
        Assert-CodexExecutorInstallPathChain $path
        if (Test-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path -Force
            if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                throw 'INSTALL_DIRECTORY_COLLISION_REVIEW_REQUIRED'
            }
        } else {
            $null = New-Item -ItemType Directory -Path $path -ErrorAction Stop
        }
    }
}

function Copy-CodexExecutorInstallFile([string]$SourcePath, [string]$DestinationPath,
    [string]$ExpectedSha256) {
    $sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($sourceHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_SOURCE_HASH_CHANGED' }
    if (Test-Path -LiteralPath $DestinationPath) {
        $item = Get-Item -LiteralPath $DestinationPath -Force
        if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'INSTALL_RUNTIME_FILE_COLLISION_REVIEW_REQUIRED'
        }
        $existingHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_RUNTIME_HASH_MISMATCH_REVIEW_REQUIRED' }
        return 'EXISTING_MATCH'
    }
    Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -ErrorAction Stop
    $copiedHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copiedHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_RUNTIME_COPY_READBACK_MISMATCH' }
    return 'COPIED'
}

function Write-CodexExecutorInstallBytes([byte[]]$Bytes, [string]$DestinationPath,
    [string]$ExpectedSha256) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualBytesHash = [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($actualBytesHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_CONFIG_BYTES_HASH_MISMATCH' }
    if (Test-Path -LiteralPath $DestinationPath) {
        $item = Get-Item -LiteralPath $DestinationPath -Force
        if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'INSTALL_RUNTIME_FILE_COLLISION_REVIEW_REQUIRED'
        }
        $existingHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_RUNTIME_HASH_MISMATCH_REVIEW_REQUIRED' }
        return 'EXISTING_MATCH'
    }
    $stream = $null
    try {
        $stream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } catch { throw 'INSTALL_CONFIG_WRITE_FAILED_REVIEW_REQUIRED' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    if ((Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256.ToLowerInvariant()) {
        throw 'INSTALL_CONFIG_READBACK_MISMATCH'
    }
    return 'WRITTEN'
}

function Resolve-Sid([string]$Name) {
    try { return ([Security.Principal.NTAccount]$Name).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'EXECUTOR_ACCOUNT_SID_UNRESOLVED' }
}

function Assert-SafeSharedParentAcl([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'EXECUTOR_SHARED_PARENT_PATH_UNSAFE'
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $untrustedSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-3', 'S-1-5-4', 'S-1-5-6')
    $deleteChild = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    foreach ($rule in @($acl.GetAccessRules($true, $true,
        [System.Security.Principal.SecurityIdentifier]))) {
        $sid = $rule.IdentityReference.Value.ToUpperInvariant()
        if ($untrustedSids -contains $sid -and $rule.AccessControlType -eq $allow -and
            (([int]$rule.FileSystemRights -band [int]$deleteChild) -ne 0)) {
            throw 'EXECUTOR_SHARED_PARENT_DELETE_CHILD_EXPOSED'
        }
    }
}

function Set-RoleAcl([string]$Path, [string]$ExecutorSid,
    [System.Security.AccessControl.FileSystemRights]$ExecutorRights) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $publisher = New-Object System.Security.Principal.SecurityIdentifier($publisherSid)
    $executor = New-Object System.Security.Principal.SecurityIdentifier($ExecutorSid)
    foreach ($entry in @(
        @{ Sid=$systemSid; Rights=[System.Security.AccessControl.FileSystemRights]::FullControl },
        @{ Sid=$adminSid; Rights=[System.Security.AccessControl.FileSystemRights]::FullControl },
        @{ Sid=$publisher; Rights=[System.Security.AccessControl.FileSystemRights]::FullControl }
    )) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $entry.Sid, $entry.Rights, $inherit, $propagation, $allow)
        $null = $acl.AddAccessRule($rule)
    }
    $executorRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $executor, $ExecutorRights, $inherit, $propagation, $allow)
    $null = $acl.AddAccessRule($executorRule)
    Set-Acl -LiteralPath $Path -AclObject $acl

    # A successful Set-Acl call is not proof that NTFS retained the intended
    # protected DACL. Read it back before any executor task can be registered.
    $readback = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $expected = @{
        'S-1-5-18' = [System.Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-544' = [System.Security.AccessControl.FileSystemRights]::FullControl
        $publisher.Value.ToUpperInvariant() = [System.Security.AccessControl.FileSystemRights]::FullControl
        $executor.Value.ToUpperInvariant() = $ExecutorRights
    }
    $rules = @($readback.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    # Windows adds Synchronize to file-system access rules during generic-rights
    # mapping. Compare the configured data rights while allowing only that bit.
    $synchronize = [int][System.Security.AccessControl.FileSystemRights]::Synchronize
    $seen = @{}
    if (-not $readback.AreAccessRulesProtected -or -not $readback.AreAccessRulesCanonical -or
        $rules.Count -ne $expected.Count) { throw 'EXECUTOR_ACL_READBACK_MISMATCH' }
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value.ToUpperInvariant()
        if (-not $expected.ContainsKey($sid) -or $seen.ContainsKey($sid) -or
            $rule.IsInherited -or $rule.AccessControlType -ne $allow -or
            (([int]$rule.FileSystemRights -band (-bnot $synchronize)) -ne
                ([int]$expected[$sid] -band (-bnot $synchronize))) -or
            $rule.InheritanceFlags -ne $expectedInheritance -or
            $rule.PropagationFlags -ne $propagation) {
            throw 'EXECUTOR_ACL_READBACK_MISMATCH'
        }
        $seen[$sid] = $true
    }
    foreach ($sid in $expected.Keys) {
        if (-not $seen.ContainsKey($sid)) { throw 'EXECUTOR_ACL_READBACK_MISMATCH' }
    }
}

if ($env:COMPUTERNAME.ToUpperInvariant() -ne $expectedHost) { throw 'WRONG_HOST_STOP' }
if ($Mode -eq 'Audit') {
    Write-Output ('EXECUTION_PHASE=' + $ExecutionPhase)
    $dispatcher = Get-TaskOptional $dispatcherTaskName
    if ($null -eq $dispatcher) { Write-Output 'DISPATCHER_TASK=ABSENT' }
    else {
        Write-Output ('DISPATCHER_TASK=' + $dispatcher.TaskName + ';state=' + $dispatcher.State +
            ';logon=' + $dispatcher.Principal.LogonType + ';runlevel=' + $dispatcher.Principal.RunLevel +
            ';instances=' + $dispatcher.Settings.MultipleInstances)
        foreach ($action in @($dispatcher.Actions)) {
            Write-Output ('DISPATCHER_ACTION=' + $action.Execute + ' ' + $action.Arguments)
        }
    }
    $executor = Get-TaskOptional $executorTaskName
    if ($null -eq $executor) { Write-Output 'CODEX_EXECUTOR_TASK=ABSENT' }
    else {
        Write-Output ('CODEX_EXECUTOR_TASK=' + $executor.State + ';logon=' + $executor.Principal.LogonType +
            ';runlevel=' + $executor.Principal.RunLevel + ';instances=' + $executor.Settings.MultipleInstances)
        foreach ($action in @($executor.Actions)) { Write-Output ('CODEX_EXECUTOR_ACTION=' + $action.Execute + ' ' + $action.Arguments) }
    }
    Write-Output ('WORKER_CONFIG_EXISTS=' + (Test-Path -LiteralPath $workerConfigPath -PathType Leaf))
    Write-Output ('CODEX_SPOOL_EXISTS=' + (Test-Path -LiteralPath $spoolDir -PathType Container))
    Write-Output 'MODEL_EXECUTION=NOT_TESTED_NO_MODEL_CALL'
    return
}

if ($Mode -eq 'Uninstall') {
    $task = Get-TaskOptional $executorTaskName
    if ($null -eq $task) { Write-Output 'CODEX_EXECUTOR_TASK=ALREADY_ABSENT'; return }
    if (@($task.Actions).Count -ne 1 -or
        $task.Actions[0].Arguments -notlike '*HiddenCodexExecutor.vbs*codex-executor.mjs*') {
        throw 'EXECUTOR_TASK_IDENTITY_MISMATCH_DO_NOT_REMOVE'
    }
    if ($task.State -eq 'Running') { throw 'EXECUTOR_STILL_RUNNING_DO_NOT_REMOVE' }
    Unregister-ScheduledTask -TaskName $executorTaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
    if ($null -ne (Get-TaskOptional $executorTaskName -Strict)) { throw 'EXECUTOR_TASK_REMOVE_READBACK_FAILED' }
    Write-Output 'CODEX_EXECUTOR_TASK_REMOVED;REQUESTS_AND_EVIDENCE_PRESERVED'
    return
}

if (-not (Test-Path -LiteralPath $workerConfigPath -PathType Leaf)) { throw 'EXISTING_WORKER_CONFIG_REQUIRED' }
if ($null -ne (Get-TaskOptional $executorTaskName)) { throw 'EXECUTOR_TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE' }
$dispatcher = Get-TaskOptional $dispatcherTaskName
if ($null -eq $dispatcher -or @($dispatcher.Actions).Count -ne 1 -or
    $dispatcher.Actions[0].Arguments -notlike '*HiddenWorker.vbs*') {
    throw 'EXISTING_DISPATCHER_IDENTITY_MISMATCH'
}

if ($isTransition) {
    if ($null -ne $ExecutorCredential) { throw 'TRANSITION_MUST_NOT_USE_SEPARATE_CREDENTIAL' }
    if (-not $env:USERPROFILE -or -not $env:LOCALAPPDATA -or
        -not (Test-Path -LiteralPath $env:USERPROFILE -PathType Container) -or
        -not (Test-Path -LiteralPath $env:LOCALAPPDATA -PathType Container) -or
        [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) {
        throw 'TRANSITION_CURRENT_PROFILE_OR_INTERACTIVE_SESSION_UNAVAILABLE'
    }
    Assert-CodexExecutorTransitionAcl $sharedBase
    $executorName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $executorSid = $publisherSid
} else {
    if ($null -eq $ExecutorCredential) { throw 'SEPARATE_EXECUTOR_CREDENTIAL_REQUIRED' }
    $executorName = $ExecutorCredential.UserName
    $executorSid = Resolve-Sid $executorName
    if ($executorSid -eq $publisherSid) { throw 'PUBLISHER_EXECUTOR_IDENTITY_MUST_DIFFER' }
    try {
        $admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop)
        if ($admins.SID.Value -contains $executorSid) { throw 'EXECUTOR_MUST_BE_STANDARD_USER' }
    } catch {
        if ($_.Exception.Message -eq 'EXECUTOR_MUST_BE_STANDARD_USER') { throw }
        throw 'EXECUTOR_ADMIN_MEMBERSHIP_UNKNOWN_STOP'
    }
    Assert-SafeSharedParentAcl -Path $env:ProgramData
}

if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw 'MACHINE_ACCESSIBLE_NODE_PATH_REQUIRED'
}
$nodePath = [IO.Path]::GetFullPath($NodeExecutable)
$programFilesRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
if (-not ($programFilesRoots | Where-Object {
    $nodePath.StartsWith([IO.Path]::GetFullPath($_) + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase) })) {
    throw 'NODE_MUST_BE_MACHINE_ACCESSIBLE'
}
Assert-CodexExecutorInstallPathChain $nodePath

if (-not $CodexExecutable -or -not (Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) {
    throw 'CODEX_EXECUTABLE_NOT_FOUND'
}
$codexSourcePath = [IO.Path]::GetFullPath($CodexExecutable)
if ([IO.Path]::GetFileName($codexSourcePath) -ine 'codex.exe') {
    throw 'CODEX_EXECUTABLE_PATH_NOT_QUALIFIED'
}
$codexProgramFilesInstall = @($programFilesRoots | Where-Object {
    $codexSourcePath.StartsWith([IO.Path]::GetFullPath($_) + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
$localCodexBin = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'))
$codexVersionDirectory = Split-Path -Parent $codexSourcePath
$codexBinDirectory = Split-Path -Parent $codexVersionDirectory
$officialUserCodexInstall = [string]::Equals([IO.Path]::GetFullPath($codexBinDirectory), $localCodexBin,
    [StringComparison]::OrdinalIgnoreCase)
if (-not ($codexProgramFilesInstall -or $officialUserCodexInstall)) {
    throw 'CODEX_EXECUTABLE_MUST_BE_PROGRAM_FILES_OR_OFFICIAL_LOCAL_CODEX'
}
Assert-CodexExecutorInstallPathChain $codexSourcePath

$codexSignature = Get-AuthenticodeSignature -FilePath $codexSourcePath
if ($codexSignature.Status -ne 'Valid' -or
    $codexSignature.SignerCertificate.Subject -notmatch 'OpenAI OpCo, LLC') {
    throw 'CODEX_EXECUTABLE_SIGNATURE_NOT_QUALIFIED'
}

# The VM account cannot depend on the publisher's per-user AppData, so VM mode
# stages and hashes the signed official bundle. The Win11 transition runs as x
# and invokes x's already installed Codex CLI directly; it never copies OAuth- or
# profile-bound CLI files into another runtime directory.
$codexCliBundleNames = if ($isTransition) { @() } else {
    @('codex.exe','codex-code-mode-host.exe','codex-command-runner.exe',
        'codex-windows-sandbox-setup.exe')
}
$codexCliSources = [ordered]@{}
$codexCliHashes = [ordered]@{}
$codexSourceDirectory = Split-Path -Parent $codexSourcePath
foreach ($name in $codexCliBundleNames) {
    $source = Join-Path $codexSourceDirectory $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw ('CODEX_CLI_BUNDLE_FILE_MISSING: ' + $name)
    }
    Assert-CodexExecutorInstallPathChain $source
    $sourceSignature = Get-AuthenticodeSignature -FilePath $source
    if ($sourceSignature.Status -ne 'Valid' -or
        $sourceSignature.SignerCertificate.Subject -notmatch 'OpenAI OpCo, LLC') {
        throw ('CODEX_CLI_BUNDLE_SIGNATURE_NOT_QUALIFIED: ' + $name)
    }
    $codexCliSources[$name] = $source
    $codexCliHashes[$name] = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
}
$codexRuntimePath = if ($isTransition) { $codexSourcePath } else { Join-Path $runtimeDir 'codex.exe' }
$codexHash = (Get-FileHash -LiteralPath $codexSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()

$sourceNames = @('codex-executor.mjs','codex-continuation.mjs','captured-process.mjs','safe-error-code.mjs',
    'windows-executor.mjs','HiddenCodexExecutor.vbs')
$runtimeSources = [ordered]@{}
foreach ($name in $sourceNames) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('SOURCE_FILE_MISSING: ' + $name) }
    $runtimeSources[$name] = $source
}
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$executorConfig = [ordered]@{
    project_id=$project; repo=$repo; spool_dir=$spoolDir
    codex_executor_execution_phase=$ExecutionPhase
    workspace_root=(Join-Path $spoolDir 'workspaces')
    codex_executable=$codexRuntimePath; codex_executable_sha256=$codexHash
    publisher_identity_sid=$publisherSid; executor_identity_sid=$executorSid
    codex_executor_task=$executorTaskName; codex_executor_task_user=$executorName
    codex_executor_wscript_path=$wscript; codex_executor_launcher_path=$launcherPath
    codex_executor_node_path=$nodePath; codex_executor_script_path=$executorScriptPath
    codex_executor_config_path=$executorConfigPath; codex_executor_working_directory=$spoolDir
    github_transport_verified=$false; codex_cli_qualified=$false; codex_login_verified=$false
    enable_codex_model_runs=$false; codex_usage_authorized=$false
    codex_sandbox_boundary='UNKNOWN'; allowed_codex_models=@{}
}
$configText = (ConvertTo-Json -InputObject $executorConfig -Depth 10 -Compress) + [Environment]::NewLine
$configEncoding = [Text.Encoding]::UTF8
$configBytes = $configEncoding.GetPreamble() + $configEncoding.GetBytes($configText)
$configSha = [Security.Cryptography.SHA256]::Create()
try { $configHash = [BitConverter]::ToString($configSha.ComputeHash($configBytes)).Replace('-', '').ToLowerInvariant() }
finally { $configSha.Dispose() }
$runtimeHashes = [ordered]@{}
foreach ($name in $sourceNames) {
    $runtimeHashes[$name] = (Get-FileHash -LiteralPath $runtimeSources[$name] -Algorithm SHA256).Hash.ToLowerInvariant()
}
foreach ($name in $codexCliBundleNames) { $runtimeHashes[$name] = $codexCliHashes[$name] }
$runtimeHashes['executor-config.json'] = $configHash
$installState = [ordered]@{
    schema='ptysd-codex-executor-install-state.v1'
    execution_phase=$ExecutionPhase
    host=$env:COMPUTERNAME.ToUpperInvariant()
    publisher_sid=$publisherSid
    executor_sid=$executorSid
    spool_dir=[IO.Path]::GetFullPath($spoolDir)
    runtime_dir=[IO.Path]::GetFullPath($runtimeDir)
    runtime_sha256=$runtimeHashes
}
$installStateText = (ConvertTo-Json -InputObject $installState -Depth 5 -Compress) + [Environment]::NewLine
Write-Output ('CODEX_EXECUTOR_INSTALL_STATE=' + (Initialize-CodexExecutorInstallState `
    -ManifestPath $installStatePath -ManifestText $installStateText -SpoolPath $spoolDir `
    -RuntimePath $runtimeDir -SpoolDirectoryNames @('requests','bundles','claims','results','evidence','workspaces','locks') `
    -ExpectedRuntimeHashes $runtimeHashes))
Assert-CodexExecutorInstallArtifacts -SpoolPath $spoolDir -RuntimePath $runtimeDir `
    -SpoolDirectoryNames @('requests','bundles','claims','results','evidence','workspaces','locks') `
    -ExpectedRuntimeHashes $runtimeHashes
Ensure-CodexExecutorInstallDirectories -SharedPath $sharedBase -SpoolPath $spoolDir -RuntimePath $runtimeDir `
    -SpoolDirectoryNames @('requests','bundles','claims','results','evidence','workspaces','locks')
if ($isTransition) {
    foreach ($path in @($sharedBase,$spoolDir,$runtimeDir) + @(
        'requests','bundles','claims','results','evidence','workspaces','locks' |
            ForEach-Object { Join-Path $spoolDir $_ })) {
        Assert-CodexExecutorTransitionAcl $path
    }
}
if (-not $isTransition) {
    $readOnly = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $modify = [System.Security.AccessControl.FileSystemRights]::Modify
    Set-RoleAcl $sharedBase $executorSid $readOnly
    Set-RoleAcl $spoolDir $executorSid $readOnly
    foreach ($name in @('requests','bundles')) {
        Set-RoleAcl (Join-Path $spoolDir $name) $executorSid $readOnly
    }
    foreach ($name in @('claims','results','evidence','workspaces','locks')) {
        Set-RoleAcl (Join-Path $spoolDir $name) $executorSid $modify
    }
    Set-RoleAcl $runtimeDir $executorSid $readOnly
}

foreach ($name in $sourceNames) {
    Copy-CodexExecutorInstallFile -SourcePath $runtimeSources[$name] `
        -DestinationPath (Join-Path $runtimeDir $name) -ExpectedSha256 $runtimeHashes[$name] | Out-Null
}
foreach ($name in $codexCliBundleNames) {
    $destination = Join-Path $runtimeDir $name
    Copy-CodexExecutorInstallFile -SourcePath $codexCliSources[$name] `
        -DestinationPath $destination -ExpectedSha256 $runtimeHashes[$name] | Out-Null
    $stagedSignature = Get-AuthenticodeSignature -FilePath $destination
    if ($stagedSignature.Status -ne 'Valid' -or
        $stagedSignature.SignerCertificate.Subject -notmatch 'OpenAI OpCo, LLC') {
        throw ('CODEX_CLI_STAGED_SIGNATURE_NOT_QUALIFIED: ' + $name)
    }
}
Write-CodexExecutorInstallBytes -Bytes $configBytes -DestinationPath $executorConfigPath `
    -ExpectedSha256 $runtimeHashes['executor-config.json'] | Out-Null

$actionArgs = ('//B //NoLogo "' + $launcherPath + '" "' + $nodePath + '" "' +
    $executorScriptPath + '" "' + $executorConfigPath + '"')
$action = New-ScheduledTaskAction -Execute $wscript -Argument $actionArgs -WorkingDirectory $spoolDir
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden -DisallowHardTerminate
$scheduledLogonType = if ($isTransition) { 'Interactive' } else { 'Password' }
$expectedReadbackLogonType = if ($isTransition) { 'Interactive' } else { 'Password' }
$principal = New-ScheduledTaskPrincipal -UserId $executorName -LogonType $scheduledLogonType -RunLevel Limited
$workerConfig = Get-Content -LiteralPath $workerConfigPath -Raw | ConvertFrom-Json
$backupPath = Join-Path (Split-Path -Parent $workerConfigPath) ('config.codex-before-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.json')
Copy-Item -LiteralPath $workerConfigPath -Destination $backupPath

try {
    $registration = @{ TaskName=$executorTaskName; TaskPath='\'; Action=$action; Settings=$settings
        Principal=$principal; ErrorAction='Stop' }
    if (-not $isTransition) {
        $registration.User = $executorName
        $registration.Password = $ExecutorCredential.GetNetworkCredential().Password
    }
    Register-ScheduledTask @registration | Out-Null
    $registeredHere = $true
    $readback = Get-ScheduledTask -TaskName $executorTaskName -TaskPath '\' -ErrorAction Stop
    $timeLimit = [string]$readback.Settings.ExecutionTimeLimit
    $zeroLimit = ($readback.Settings.ExecutionTimeLimit -eq [TimeSpan]::Zero) -or
        ($timeLimit -eq 'PT0S') -or ($timeLimit -eq '00:00:00')
    if ($readback.Principal.UserId -ne $executorName -or $readback.Principal.LogonType -ne $expectedReadbackLogonType -or
        $readback.Principal.RunLevel -ne 'Limited' -or $readback.Settings.MultipleInstances -ne 'IgnoreNew' -or
        -not $zeroLimit -or $readback.Settings.Hidden -ne $true -or
        $readback.Settings.AllowHardTerminate -ne $false -or
        @($readback.Triggers).Count -ne 0 -or @($readback.Actions).Count -ne 1 -or
        $readback.Actions[0].Execute -ne $wscript -or
        $readback.Actions[0].Arguments -ne $actionArgs -or
        $readback.Actions[0].WorkingDirectory -ne $spoolDir) {
        throw 'EXECUTOR_TASK_READBACK_MISMATCH'
    }
    foreach ($property in @{
        codex_spool=$spoolDir; publisher_identity_sid=$publisherSid; executor_identity_sid=$executorSid
        codex_executor_execution_phase=$ExecutionPhase
        codex_executor_task=$executorTaskName; codex_executor_task_user=$executorName
        codex_executor_wscript_path=$wscript; codex_executor_launcher_path=$launcherPath
        codex_executor_node_path=$nodePath; codex_executor_script_path=$executorScriptPath
        codex_executor_config_path=$executorConfigPath; codex_executor_working_directory=$spoolDir
        github_transport_verified=$false
        codex_cli_qualified=$false; codex_login_verified=$false; enable_codex_model_runs=$false
        codex_usage_authorized=$false; codex_sandbox_boundary='UNKNOWN'; allowed_codex_models=@{}
    }.GetEnumerator()) {
        $workerConfig | Add-Member -MemberType NoteProperty -Name $property.Key -Value $property.Value -Force
    }
    $tempConfig = $workerConfigPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $workerConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tempConfig -Encoding UTF8
    Move-Item -LiteralPath $tempConfig -Destination $workerConfigPath -Force
    $readWorkerConfig = Get-Content -LiteralPath $workerConfigPath -Raw | ConvertFrom-Json
    if ($readWorkerConfig.codex_executor_task -ne $executorTaskName -or
        $readWorkerConfig.codex_executor_task_user -ne $executorName -or
        $readWorkerConfig.codex_executor_wscript_path -ne $wscript -or
        $readWorkerConfig.codex_executor_launcher_path -ne $launcherPath -or
        $readWorkerConfig.codex_executor_node_path -ne $nodePath -or
        $readWorkerConfig.codex_executor_script_path -ne $executorScriptPath -or
        $readWorkerConfig.codex_executor_config_path -ne $executorConfigPath -or
        $readWorkerConfig.codex_executor_working_directory -ne $spoolDir -or
        $readWorkerConfig.codex_executor_execution_phase -ne $ExecutionPhase -or
        $readWorkerConfig.enable_codex_model_runs -ne $false -or
        $readWorkerConfig.codex_usage_authorized -ne $false) { throw 'WORKER_CONFIG_READBACK_MISMATCH' }
Assert-CodexExecutorInstallArtifacts -SpoolPath $spoolDir -RuntimePath $runtimeDir `
    -SpoolDirectoryNames @('requests','bundles','claims','results','evidence','workspaces','locks') `
    -ExpectedRuntimeHashes $runtimeHashes -RequireComplete
if ($isTransition) {
    foreach ($path in @($workerConfigPath,$installStatePath,$executorConfigPath,$executorScriptPath,
        $continuationScriptPath,$launcherPath,$NodeExecutable,$codexRuntimePath)) {
        Assert-CodexExecutorTransitionAcl $path
    }
}
    Write-Output 'CODEX_EXECUTOR_REGISTERED_ON_DEMAND_ONLY'
    Write-Output ('EXECUTION_PHASE=' + $ExecutionPhase)
    Write-Output ('EXECUTOR_TASK=' + $executorTaskName + ';Logon=' + $expectedReadbackLogonType +
        ';RunLevel=Limited;Instances=IgnoreNew;ExecutionTimeLimit=PT0S')
    Write-Output ('EXISTING_DISPATCHER=' + $dispatcherTaskName + ';ACTION_UNCHANGED')
    Write-Output ('WORKER_CONFIG_BACKUP=' + $backupPath)
    Write-Output ('CODEX_CLI_PATH=' + $codexRuntimePath + ';CLI_COPY=' + (-not $isTransition))
    Write-Output 'MODEL_EXECUTION=DISABLED;COST_AUTHORIZATION=FALSE;SANDBOX_BOUNDARY=UNKNOWN'
    if ($isTransition) {
        Write-Output 'NEXT=Qualify current-user Codex CLI and exact model/cost permissions; no model was invoked'
    } else {
        Write-Output 'NEXT=Authenticate Codex only within the dedicated standard-user account; audit sandbox boundary before enabling any model run'
    }
} catch {
    $failureMessage = $_.Exception.Message
    $rollbackProblems = New-Object System.Collections.Generic.List[string]
    if ($registeredHere) {
        try {
            Unregister-ScheduledTask -TaskName $executorTaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
            if ($null -ne (Get-TaskOptional $executorTaskName -Strict)) { throw 'EXECUTOR_TASK_STILL_PRESENT_AFTER_ROLLBACK' }
        } catch { $rollbackProblems.Add('TASK_REMOVE_OR_READBACK_FAILED') }
    } else {
        try {
            if ($null -ne (Get-TaskOptional $executorTaskName -Strict)) { $rollbackProblems.Add('REGISTRATION_OUTCOME_UNKNOWN_DO_NOT_REMOVE') }
        } catch { $rollbackProblems.Add('REGISTRATION_READBACK_FAILED') }
    }
    try {
        if (-not $backupPath -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) { throw 'WORKER_CONFIG_BACKUP_MISSING' }
        Copy-Item -LiteralPath $backupPath -Destination $workerConfigPath -Force -ErrorAction Stop
        $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $restoredHash = (Get-FileHash -LiteralPath $workerConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($restoredHash -ne $backupHash) { throw 'WORKER_CONFIG_RESTORE_HASH_MISMATCH' }
    } catch { $rollbackProblems.Add('WORKER_CONFIG_RESTORE_OR_READBACK_FAILED') }
    if ($rollbackProblems.Count -gt 0) {
        throw ('CODEX_EXECUTOR_INSTALL_ROLLBACK_INCOMPLETE_REVIEW_REQUIRED;failure=' + $failureMessage + ';issues=' + ($rollbackProblems -join ','))
    }
    throw
}
