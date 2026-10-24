# Source-only installer for the on-demand Codex Executor.
# It never changes PTYSD-Native-OpenCode or HiddenWorker.vbs. Do not execute this
# installer before the exact source and the Human model/cost gates are accepted.
[CmdletBinding()]
param(
    [ValidateSet('Audit','Install','Uninstall','RefreshCodexCli')][string]$Mode = 'Audit',
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
    try {
        $items = @(Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction $readErrorAction)
    } catch {
        # NotFound is a valid absent-task readback after rollback or uninstall.
        if ($Strict -and $_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound,Get-ScheduledTask*') {
            return $null
        }
        throw
    }
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
                # This ACE does not apply to the directory whose ACL is being
                # checked. If inherited by a descendant where it is effective,
                # that descendant is checked separately while walking the path.
                if (([int]$rule.PropagationFlags -band
                    [int][System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
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

function Assert-CodexExecutorCliRefreshArtifacts([string]$SpoolPath, [string]$RuntimePath,
    [string[]]$SpoolDirectoryNames, [System.Collections.IDictionary]$ExpectedRuntimeHashes) {
    $spool = Get-CodexExecutorInstallTree $SpoolPath
    if (-not $spool.Exists) { throw 'CODEX_CLI_REFRESH_SPOOL_MISSING' }
    foreach ($relative in $spool.Directories + $spool.Files) {
        $top = $relative.Split([char[]]@('\','/'), [StringSplitOptions]::RemoveEmptyEntries)[0]
        if (-not (@($SpoolDirectoryNames | Where-Object { $_ -ieq $top }).Count)) {
            throw 'CODEX_CLI_REFRESH_UNEXPECTED_SPOOL_ENTRY'
        }
    }
    foreach ($name in $SpoolDirectoryNames) {
        if (-not (Test-Path -LiteralPath (Join-Path $SpoolPath $name) -PathType Container)) {
            throw 'CODEX_CLI_REFRESH_SPOOL_LAYOUT_INCOMPLETE'
        }
    }
    foreach ($name in @('claims','locks')) {
        if (@(Get-ChildItem -LiteralPath (Join-Path $SpoolPath $name) -Force -Recurse -ErrorAction Stop).Count -gt 0) {
            throw 'CODEX_CLI_REFRESH_ACTIVE_CLAIM_OR_LOCK_PRESENT'
        }
    }
    $runtime = Get-CodexExecutorInstallTree $RuntimePath
    if (-not $runtime.Exists -or $runtime.Directories.Count -gt 0 -or
        $runtime.Files.Count -ne $ExpectedRuntimeHashes.Count) {
        throw 'CODEX_CLI_REFRESH_RUNTIME_LAYOUT_MISMATCH'
    }
    foreach ($name in $ExpectedRuntimeHashes.Keys) {
        if (-not (@($runtime.Files | Where-Object { $_ -ieq [string]$name }).Count)) {
            throw 'CODEX_CLI_REFRESH_RUNTIME_FILE_MISSING'
        }
        $actual = (Get-FileHash -LiteralPath (Join-Path $RuntimePath $name) -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        if ($actual -ne [string]$ExpectedRuntimeHashes[$name]) {
            throw 'CODEX_CLI_REFRESH_RUNTIME_HASH_MISMATCH'
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

function Get-CodexExecutorBytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Write-CodexExecutorAtomicReplacement([byte[]]$Bytes, [string]$DestinationPath,
    [string]$ExpectedSha256) {
    if ((Get-CodexExecutorBytesSha256 $Bytes) -ne $ExpectedSha256.ToLowerInvariant()) {
        throw 'CODEX_CLI_REFRESH_BYTES_HASH_MISMATCH'
    }
    Assert-CodexExecutorInstallPathChain $DestinationPath
    $destinationItem = Get-Item -LiteralPath $DestinationPath -Force -ErrorAction Stop
    if ($destinationItem.PSIsContainer -or
        (($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'CODEX_CLI_REFRESH_DESTINATION_REVIEW_REQUIRED'
    }
    $temporaryPath = $DestinationPath + '.refresh-' + [guid]::NewGuid().ToString('N') + '.tmp'
    $replaceBackupPath = $DestinationPath + '.replace-backup-' + [guid]::NewGuid().ToString('N')
    $stream = $null
    try {
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if ((Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            $ExpectedSha256.ToLowerInvariant()) { throw 'CODEX_CLI_REFRESH_STAGED_HASH_MISMATCH' }
        # ReplaceFile preserves the destination's security descriptor on Windows.
        [IO.File]::Replace($temporaryPath, $DestinationPath, $replaceBackupPath)
        if ((Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            $ExpectedSha256.ToLowerInvariant()) { throw 'CODEX_CLI_REFRESH_READBACK_MISMATCH' }
        if (Test-Path -LiteralPath $replaceBackupPath) {
            Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction Stop
        }
    } catch {
        $replaceError = $_.Exception.Message
        if (Test-Path -LiteralPath $replaceBackupPath) {
            try {
                $failedReplacementPath = $DestinationPath + '.failed-replacement-' + [guid]::NewGuid().ToString('N')
                [IO.File]::Replace($replaceBackupPath, $DestinationPath, $failedReplacementPath)
                if (Test-Path -LiteralPath $failedReplacementPath) {
                    Remove-Item -LiteralPath $failedReplacementPath -Force -ErrorAction Stop
                }
            } catch { throw 'CODEX_CLI_REFRESH_ATOMIC_REPLACE_ROLLBACK_UNKNOWN' }
        }
        throw ('CODEX_CLI_REFRESH_ATOMIC_REPLACE_FAILED:' + $replaceError)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-CodexExecutorCliPinRefresh([string]$NewCodexExecutable) {
    if ($ExecutionPhase -ne 'WIN11_TRANSITION' -or $null -ne $ExecutorCredential) {
        throw 'CODEX_CLI_REFRESH_WIN11_TRANSITION_ONLY'
    }
    if (-not $env:USERPROFILE -or -not $env:LOCALAPPDATA -or
        -not (Test-Path -LiteralPath $env:USERPROFILE -PathType Container) -or
        -not (Test-Path -LiteralPath $env:LOCALAPPDATA -PathType Container) -or
        [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) {
        throw 'CODEX_CLI_REFRESH_CURRENT_PROFILE_REQUIRED'
    }
    foreach ($path in @($workerConfigPath,$executorConfigPath,$installStatePath)) {
        Assert-CodexExecutorInstallPathChain $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'CODEX_CLI_REFRESH_INSTALLED_STATE_REQUIRED'
        }
    }

    $task = Get-TaskOptional $executorTaskName -Strict
    if ($null -eq $task) { throw 'CODEX_CLI_REFRESH_TASK_ABSENT' }
    if ($task.State -ne 'Ready') { throw 'CODEX_CLI_REFRESH_TASK_NOT_IDLE' }
    $configText = Get-Content -LiteralPath $executorConfigPath -Raw -ErrorAction Stop
    $config = $configText | ConvertFrom-Json -ErrorAction Stop
    $workerConfig = (Get-Content -LiteralPath $workerConfigPath -Raw -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop
    if ($config.project_id -ne $project -or $config.repo -ne $repo -or
        $config.codex_executor_execution_phase -ne 'WIN11_TRANSITION' -or
        [IO.Path]::GetFullPath([string]$config.spool_dir) -ne [IO.Path]::GetFullPath($spoolDir) -or
        [IO.Path]::GetFullPath([string]$config.codex_executor_config_path) -ne [IO.Path]::GetFullPath($executorConfigPath) -or
        [IO.Path]::GetFullPath([string]$config.codex_executor_script_path) -ne [IO.Path]::GetFullPath($executorScriptPath) -or
        [IO.Path]::GetFullPath([string]$config.codex_executor_launcher_path) -ne [IO.Path]::GetFullPath($launcherPath) -or
        [IO.Path]::GetFullPath([string]$config.codex_executor_wscript_path) -ne
            [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\wscript.exe')) -or
        [IO.Path]::GetFullPath([string]$config.codex_executor_working_directory) -ne [IO.Path]::GetFullPath($spoolDir) -or
        $config.codex_executor_task -ne $executorTaskName -or
        $config.codex_executor_task_user -ne [Security.Principal.WindowsIdentity]::GetCurrent().Name -or
        $config.publisher_identity_sid -ne $publisherSid -or $config.executor_identity_sid -ne $publisherSid) {
        throw 'CODEX_CLI_REFRESH_INSTALLED_IDENTITY_MISMATCH'
    }
    if ($workerConfig.codex_executor_execution_phase -ne 'WIN11_TRANSITION' -or
        $workerConfig.codex_executor_task -ne $config.codex_executor_task -or
        $workerConfig.codex_executor_task_user -ne $config.codex_executor_task_user -or
        $workerConfig.codex_executor_config_path -ne $executorConfigPath -or
        $workerConfig.codex_executor_script_path -ne $executorScriptPath -or
        $workerConfig.enable_codex_model_runs -ne $false -or $workerConfig.codex_usage_authorized -ne $false -or
        $workerConfig.codex_cli_qualified -ne $false -or $workerConfig.codex_login_verified -ne $false -or
        $null -eq $workerConfig.allowed_codex_models -or
        @($workerConfig.allowed_codex_models.PSObject.Properties).Count -ne 0) {
        throw 'CODEX_CLI_REFRESH_PUBLISHER_CONFIG_MISMATCH'
    }
    $installedNodePath = [IO.Path]::GetFullPath([string]$config.codex_executor_node_path)
    if (-not (Test-Path -LiteralPath $installedNodePath -PathType Leaf)) {
        throw 'CODEX_CLI_REFRESH_INSTALLED_NODE_UNAVAILABLE'
    }
    if ($config.enable_codex_model_runs -ne $false -or $config.codex_usage_authorized -ne $false -or
        $config.codex_cli_qualified -ne $false -or $config.codex_login_verified -ne $false -or
        $null -eq $config.allowed_codex_models -or
        @($config.allowed_codex_models.PSObject.Properties).Count -ne 0) {
        throw 'CODEX_CLI_REFRESH_MODEL_AUTHORIZATION_MUST_REMAIN_DISABLED'
    }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $expectedArgs = ('//B //NoLogo "' + $launcherPath + '" "' + $installedNodePath + '" "' +
        $executorScriptPath + '" "' + $executorConfigPath + '"')
    $taskUserSid = $null
    try { $taskUserSid = Resolve-Sid ([string]$task.Principal.UserId) } catch { $taskUserSid = $null }
    if ($taskUserSid -ne $publisherSid -or $task.Principal.LogonType -ne 'Interactive' -or
        $task.Principal.RunLevel -ne 'Limited' -or $task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        $task.Settings.Hidden -ne $true -or $task.Settings.AllowHardTerminate -ne $false -or
        -not ($task.Settings.ExecutionTimeLimit -eq [TimeSpan]::Zero -or
            [string]$task.Settings.ExecutionTimeLimit -in @('PT0S','00:00:00')) -or
        @($task.Triggers | Where-Object { $null -ne $_ }).Count -ne 0 -or
        @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $wscript -or
        $task.Actions[0].Arguments -ne $expectedArgs -or
        [IO.Path]::GetFullPath([string]$task.Actions[0].WorkingDirectory) -ne [IO.Path]::GetFullPath($spoolDir)) {
        throw 'CODEX_CLI_REFRESH_TASK_IDENTITY_MISMATCH'
    }
    try { $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
    catch { throw 'CODEX_CLI_REFRESH_PROCESS_STATE_UNKNOWN' }
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine.IndexOf($executorScriptPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            $commandLine.IndexOf($executorConfigPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $processExecutable = [string]$process.ExecutablePath
        if (-not $processExecutable) { throw 'CODEX_CLI_REFRESH_PROCESS_IDENTITY_UNKNOWN' }
        try { $processExecutableName = [IO.Path]::GetFileName([IO.Path]::GetFullPath($processExecutable)) }
        catch { throw 'CODEX_CLI_REFRESH_PROCESS_IDENTITY_UNKNOWN' }
        # The CLI refresh must wait for any Node executable running this exact
        # executor/config pair, even if Node itself was replaced or moved.
        if ([string]::Equals($processExecutableName, 'node.exe', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'CODEX_EXECUTOR_PROCESS_RUNNING_DO_NOT_REFRESH'
        }
    }

    $manifestText = Get-Content -LiteralPath $installStatePath -Raw -ErrorAction Stop
    $manifest = $manifestText | ConvertFrom-Json -ErrorAction Stop
    $preflightManifestHash = (Get-FileHash -LiteralPath $installStatePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($manifest.schema -ne 'ptysd-codex-executor-install-state.v1' -or
        $manifest.execution_phase -ne 'WIN11_TRANSITION' -or
        $manifest.host -ne $env:COMPUTERNAME.ToUpperInvariant() -or
        $manifest.publisher_sid -ne $publisherSid -or $manifest.executor_sid -ne $publisherSid -or
        [IO.Path]::GetFullPath([string]$manifest.spool_dir) -ne [IO.Path]::GetFullPath($spoolDir) -or
        [IO.Path]::GetFullPath([string]$manifest.runtime_dir) -ne [IO.Path]::GetFullPath($runtimeDir)) {
        throw 'CODEX_CLI_REFRESH_INSTALL_STATE_IDENTITY_MISMATCH'
    }
    $runtimeHashes = [ordered]@{}
    foreach ($property in $manifest.runtime_sha256.PSObject.Properties) {
        if ([string]$property.Value -notmatch '^[0-9a-fA-F]{64}$') {
            throw 'CODEX_CLI_REFRESH_INSTALL_STATE_HASH_INVALID'
        }
        $runtimeHashes[$property.Name] = ([string]$property.Value).ToLowerInvariant()
    }
    if (-not $runtimeHashes.Contains('executor-config.json')) {
        throw 'CODEX_CLI_REFRESH_CONFIG_HASH_MISSING'
    }
    if ((Get-FileHash -LiteralPath $executorConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $runtimeHashes['executor-config.json']) { throw 'CODEX_CLI_REFRESH_CONFIG_HASH_MISMATCH' }
    Assert-CodexExecutorCliRefreshArtifacts -SpoolPath $spoolDir -RuntimePath $runtimeDir `
        -SpoolDirectoryNames @('requests','bundles','claims','results','evidence','workspaces','locks') `
        -ExpectedRuntimeHashes $runtimeHashes

    $oldCodexPath = [IO.Path]::GetFullPath([string]$config.codex_executable)
    if (Test-Path -LiteralPath $oldCodexPath) { throw 'CODEX_CLI_PIN_REFRESH_NOT_REQUIRED' }
    if ([string]$config.codex_executable_sha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'CODEX_CLI_REFRESH_OLD_HASH_INVALID'
    }
    if (-not $NewCodexExecutable -or -not (Test-Path -LiteralPath $NewCodexExecutable -PathType Leaf)) {
        throw 'CODEX_EXECUTABLE_NOT_FOUND'
    }
    $newCodexPath = [IO.Path]::GetFullPath($NewCodexExecutable)
    if ([IO.Path]::GetFileName($newCodexPath) -ine 'codex.exe') { throw 'CODEX_EXECUTABLE_PATH_NOT_QUALIFIED' }
    $localCodexBin = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'))
    $codexBinDirectory = Split-Path -Parent (Split-Path -Parent $newCodexPath)
    if (-not [string]::Equals([IO.Path]::GetFullPath($codexBinDirectory), $localCodexBin,
        [StringComparison]::OrdinalIgnoreCase)) { throw 'CODEX_EXECUTABLE_MUST_BE_OFFICIAL_LOCAL_CODEX' }
    Assert-CodexExecutorInstallPathChain $newCodexPath
    $signature = Get-AuthenticodeSignature -FilePath $newCodexPath
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI OpCo, LLC') {
        throw 'CODEX_EXECUTABLE_SIGNATURE_NOT_QUALIFIED'
    }
    $newCodexHash = (Get-FileHash -LiteralPath $newCodexPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $config.codex_executable = $newCodexPath
    $config.codex_executable_sha256 = $newCodexHash
    $configEncoding = [Text.Encoding]::UTF8
    $newConfigText = (ConvertTo-Json -InputObject $config -Depth 20 -Compress) + [Environment]::NewLine
    $newConfigBytes = $configEncoding.GetPreamble() + $configEncoding.GetBytes($newConfigText)
    $newConfigHash = Get-CodexExecutorBytesSha256 $newConfigBytes
    $manifestPattern = '("executor-config\.json"\s*:\s*")[0-9a-fA-F]{64}(")'
    $matches = [regex]::Matches($manifestText, $manifestPattern)
    if ($matches.Count -ne 1) { throw 'CODEX_CLI_REFRESH_MANIFEST_CONFIG_HASH_AMBIGUOUS' }
    $newManifestText = [regex]::Replace($manifestText, $manifestPattern,
        ('${1}' + $newConfigHash + '${2}'), 1)
    $newManifest = $newManifestText | ConvertFrom-Json -ErrorAction Stop
    if ($newManifest.runtime_sha256.'executor-config.json' -ne $newConfigHash) {
        throw 'CODEX_CLI_REFRESH_MANIFEST_UPDATE_FAILED'
    }
    $manifestBytes = ([System.Text.UTF8Encoding]::new($false)).GetBytes($newManifestText)
    $newManifestHash = Get-CodexExecutorBytesSha256 $manifestBytes

    $backupDir = Join-Path $sharedBase 'maintenance-backups'
    Assert-CodexExecutorInstallPathChain $backupDir
    if (-not (Test-Path -LiteralPath $backupDir -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop
    }
    Assert-CodexExecutorTransitionAcl $backupDir
    $backupStem = 'codex-cli-refresh-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' +
        [guid]::NewGuid().ToString('N')
    $configBackup = Join-Path $backupDir ($backupStem + '-executor-config.json')
    $manifestBackup = Join-Path $backupDir ($backupStem + '-install-state.json')
    [IO.File]::Copy($executorConfigPath, $configBackup, $false)
    [IO.File]::Copy($installStatePath, $manifestBackup, $false)
    $oldConfigHash = (Get-FileHash -LiteralPath $configBackup -Algorithm SHA256).Hash.ToLowerInvariant()
    $oldManifestHash = (Get-FileHash -LiteralPath $manifestBackup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($oldConfigHash -ne $runtimeHashes['executor-config.json'] -or
        $oldManifestHash -ne $preflightManifestHash) {
        throw 'CODEX_CLI_REFRESH_SOURCE_CHANGED_NO_WRITE'
    }
    try {
        if ((Get-FileHash -LiteralPath $executorConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oldConfigHash -or
            (Get-FileHash -LiteralPath $installStatePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oldManifestHash) {
            throw 'CODEX_CLI_REFRESH_SOURCE_CHANGED_NO_WRITE'
        }
        Write-CodexExecutorAtomicReplacement $newConfigBytes $executorConfigPath $newConfigHash
        if ((Get-FileHash -LiteralPath $installStatePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oldManifestHash) {
            throw 'CODEX_CLI_REFRESH_INSTALL_STATE_CHANGED_DURING_UPDATE'
        }
        Write-CodexExecutorAtomicReplacement $manifestBytes $installStatePath $newManifestHash
        if ((Get-Content -LiteralPath $executorConfigPath -Raw | ConvertFrom-Json).codex_executable_sha256 -ne $newCodexHash -or
            (Get-Content -LiteralPath $installStatePath -Raw | ConvertFrom-Json).runtime_sha256.'executor-config.json' -ne $newConfigHash) {
            throw 'CODEX_CLI_REFRESH_READBACK_MISMATCH'
        }
    } catch {
        $originalError = $_.Exception.Message
        $rollbackErrors = New-Object System.Collections.Generic.List[string]
        foreach ($rollback in @(
            @{ Path=$installStatePath; Backup=$manifestBackup; Hash=$oldManifestHash },
            @{ Path=$executorConfigPath; Backup=$configBackup; Hash=$oldConfigHash }
        )) {
            try {
                $currentHash = (Get-FileHash -LiteralPath $rollback.Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
                if ($currentHash -ne $rollback.Hash) {
                    Write-CodexExecutorAtomicReplacement ([IO.File]::ReadAllBytes($rollback.Backup)) `
                        $rollback.Path $rollback.Hash
                }
            } catch { $rollbackErrors.Add([string]$rollback.Path) }
        }
        if ($rollbackErrors.Count -gt 0) {
            throw ('CODEX_CLI_REFRESH_PARTIAL_STATE_REVIEW_REQUIRED;backup=' + $backupDir +
                ';paths=' + ($rollbackErrors -join ','))
        }
        throw ('CODEX_CLI_REFRESH_FAILED_ROLLED_BACK:' + $originalError + ';backup=' + $backupDir)
    }
    Write-Output ('CODEX_CLI_PIN_REFRESH=SUCCESS;path=' + $newCodexPath + ';sha256=' + $newCodexHash)
    Write-Output ('CODEX_CLI_PIN_REFRESH_BACKUP=' + $backupDir)
    Write-Output ('CODEX_CLI_PIN_REFRESH_OLD_CONFIG_SHA256=' + $oldConfigHash)
    Write-Output ('CODEX_CLI_PIN_REFRESH_OLD_INSTALL_STATE_SHA256=' + $oldManifestHash)
    Write-Output 'MODEL_EXECUTION=UNCHANGED_DISABLED'
}

function Resolve-Sid([string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Name)) { throw 'EXECUTOR_ACCOUNT_SID_UNRESOLVED' }
    try {
        $identity = $Name.Trim()
        if ($identity -match '^S-\d+(?:-\d+)+$') {
            return ([Security.Principal.SecurityIdentifier]::new($identity)).Value
        }
        return ([Security.Principal.NTAccount]::new($identity)).Translate(
            [Security.Principal.SecurityIdentifier]).Value
    }
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

if ($Mode -eq 'RefreshCodexCli') {
    $refreshMutex = [Threading.Mutex]::new($false, ('Local\PTYSD-CodexExecutor-CliRefresh-' + $publisherSid))
    $refreshMutexAcquired = $false
    try {
        try { $refreshMutexAcquired = $refreshMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $refreshMutexAcquired = $true }
        if (-not $refreshMutexAcquired) { throw 'CODEX_CLI_REFRESH_ALREADY_RUNNING' }
        Invoke-CodexExecutorCliPinRefresh -NewCodexExecutable $CodexExecutable
    } finally {
        if ($refreshMutexAcquired) { $refreshMutex.ReleaseMutex() }
        $refreshMutex.Dispose()
    }
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
    $readbackMismatches = New-Object System.Collections.Generic.List[string]
    $readbackPrincipalSid = $null
    try { $readbackPrincipalSid = Resolve-Sid ([string]$readback.Principal.UserId) }
    catch { $readbackPrincipalSid = $null }
    if ([string]::IsNullOrWhiteSpace($readbackPrincipalSid) -or $readbackPrincipalSid -ne $executorSid) {
        $readbackMismatches.Add('Principal.UserId')
    }
    if ($readback.Principal.LogonType -ne $expectedReadbackLogonType) { $readbackMismatches.Add('Principal.LogonType') }
    if ($readback.Principal.RunLevel -ne 'Limited') { $readbackMismatches.Add('Principal.RunLevel') }
    if ($readback.Settings.MultipleInstances -ne 'IgnoreNew') { $readbackMismatches.Add('Settings.MultipleInstances') }
    if (-not $zeroLimit) { $readbackMismatches.Add('Settings.ExecutionTimeLimit') }
    if ($readback.Settings.Hidden -ne $true) { $readbackMismatches.Add('Settings.Hidden') }
    if ($readback.Settings.AllowHardTerminate -ne $false) { $readbackMismatches.Add('Settings.AllowHardTerminate') }
    $readbackTriggers = @($readback.Triggers | Where-Object { $null -ne $_ })
    if ($readbackTriggers.Count -ne 0) { $readbackMismatches.Add('Triggers.Count') }
    $readbackActions = @($readback.Actions)
    if ($readbackActions.Count -ne 1) {
        $readbackMismatches.Add('Actions.Count')
    } else {
        if ($readbackActions[0].Execute -ne $wscript) { $readbackMismatches.Add('Actions[0].Execute') }
        if ($readbackActions[0].Arguments -ne $actionArgs) { $readbackMismatches.Add('Actions[0].Arguments') }
        if ($readbackActions[0].WorkingDirectory -ne $spoolDir) { $readbackMismatches.Add('Actions[0].WorkingDirectory') }
    }
    if ($readbackMismatches.Count -gt 0) {
        throw ('EXECUTOR_TASK_READBACK_MISMATCH;fields=' + ($readbackMismatches -join ','))
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
