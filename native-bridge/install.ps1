# Windows PowerShell 5.1 native, least-privilege, version-neutral OpenCode ingress.
[CmdletBinding()]
param(
    [ValidateSet('Audit','Install','RunOnce','RefreshRuntimeModules','Uninstall')][string]$Mode = 'Audit',
    [ValidateRange(1,99999999)][int]$IssueNumber = 1,
    [string]$Workspace = '',
    [string]$TrustedDispatcher = 't14210184',
    [string]$SourceMainSha = '',
    [ValidateRange(0,99999999)][int]$AcceptedPr = 0,
    [string]$AcceptedPrHead = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# gh auth status returns 1 on first login and writes to stderr by design.
# Windows PowerShell 5.1 + ErrorActionPreference=Stop must not convert that
# expected status into a terminating NativeCommandError.
function Test-GhAuthenticated([string]$GhExe) {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $GhExe auth status --hostname github.com *> $null
        $authExit = $LASTEXITCODE
        return ($authExit -eq 0)
    } finally {
        $ErrorActionPreference = $oldPreference
    }
}
$repo = 'PT-Original-Point/ptysd-autonomous-factory'
$project = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE'
$taskName = 'PTYSD-Native-OpenCode'
$expectedHost = 'DESKTOP-1B6PD2P'
$homeDir = Join-Path $env:LOCALAPPDATA 'PTYSDNativeBridge'
$worker = Join-Path $homeDir 'worker.mjs'
$configPath = Join-Path $homeDir 'config.json'
$configWriteLockPath = $configPath + '.write.lock'
$hiddenWorker = Join-Path $homeDir 'HiddenWorker.vbs'
$hiddenWorkerSha256 = 'BEB20341D759C4F6380A62197AB0FAD79B2F0D0B52798BFBF734346A05B82A89'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$runtimeFiles = @(
    'worker.mjs',
    'opencode-v2.mjs',
    'v2-readiness.mjs',
    'antigravity-quota.mjs',
    'codex-continuation.mjs',
    'operator-observation.mjs',
    'captured-process.mjs',
    'safe-error-code.mjs',
    'windows-executor.mjs'
)

function Merge-WorkerConfig {
    param(
        [AllowNull()][object]$ExistingConfig,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$BaseConfig
    )
    $merged = [ordered]@{}
    if ($null -ne $ExistingConfig) {
        foreach ($property in $ExistingConfig.PSObject.Properties) {
            $merged[$property.Name] = $property.Value
        }
    }
    foreach ($key in $BaseConfig.Keys) { $merged[$key] = $BaseConfig[$key] }
    return $merged
}

function Write-WorkerConfigAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $parentPath = [IO.Path]::GetDirectoryName($fullPath)
    if (-not [IO.Directory]::Exists($parentPath)) { throw 'WORKER_CONFIG_PARENT_MISSING_DO_NOT_OVERWRITE' }

    $temporaryPath = $fullPath + '.worker-install-' + [guid]::NewGuid().ToString('N') + '.tmp'
    $backupPath = $null
    $bytes = ([Text.UTF8Encoding]::new($false)).GetBytes($Text)
    $stream = $null
    try {
        try {
            $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write, [IO.FileShare]::None)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
            $stream.Dispose()
            $stream = $null
        } catch {
            throw 'WORKER_CONFIG_STAGE_WRITE_FAILED_DO_NOT_OVERWRITE'
        }

        if ([IO.File]::Exists($fullPath)) {
            $originalBytes = [IO.File]::ReadAllBytes($fullPath)
            $backupPath = $fullPath + '.worker-install-' + [guid]::NewGuid().ToString('N') + '.bak'
            try {
                # ReplaceFile publishes complete bytes atomically and preserves the existing file ACL.
                [IO.File]::Replace($temporaryPath, $fullPath, $backupPath)
            } catch {
                throw 'WORKER_CONFIG_ATOMIC_PUBLISH_FAILED_DO_NOT_OVERWRITE'
            }
        } else {
            try {
                [IO.File]::Move($temporaryPath, $fullPath)
            } catch {
                throw 'WORKER_CONFIG_ATOMIC_PUBLISH_FAILED_DO_NOT_OVERWRITE'
            }
        }

        $readBack = [IO.File]::ReadAllBytes($fullPath)
        if ([Convert]::ToBase64String($readBack) -cne [Convert]::ToBase64String($bytes)) {
            throw 'WORKER_CONFIG_READBACK_MISMATCH_REVIEW_REQUIRED'
        }
        if ($null -ne $backupPath) {
            $backupBytes = [IO.File]::ReadAllBytes($backupPath)
            if ([Convert]::ToBase64String($backupBytes) -cne [Convert]::ToBase64String($originalBytes)) {
                throw 'WORKER_CONFIG_BACKUP_READBACK_MISMATCH_REVIEW_REQUIRED'
            }
            [IO.File]::Delete($backupPath)
            if ([IO.File]::Exists($backupPath)) { throw 'WORKER_CONFIG_BACKUP_CLEANUP_FAILED_REVIEW_REQUIRED' }
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
    }
}

function Get-WorkerRuntimeBytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-WorkerRuntimeFileSha256([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'WORKER_RUNTIME_PATH_NOT_REGULAR_FILE'
    }
    return Get-WorkerRuntimeBytesSha256 ([IO.File]::ReadAllBytes($Path))
}

function Resolve-WorkerRuntimeIdentitySid([string]$Identity) {
    if ([string]::IsNullOrWhiteSpace($Identity)) { throw 'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_UNKNOWN' }
    try {
        if ($Identity -match '^S-\d-\d+(?:-\d+)+$') {
            return (New-Object Security.Principal.SecurityIdentifier($Identity)).Value
        }
        return (New-Object Security.Principal.NTAccount($Identity)).Translate(
            [Security.Principal.SecurityIdentifier]).Value
    } catch { throw 'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_UNKNOWN' }
}

function Assert-WorkerRuntimePathChain([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'WORKER_RUNTIME_PATH_CHAIN_REPARSE_POINT'
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Write-WorkerRuntimeAtomicReplacement([byte[]]$Bytes, [string]$DestinationPath,
    [string]$ExpectedCurrentSha256, [string]$ExpectedNewSha256) {
    if ((Get-WorkerRuntimeBytesSha256 $Bytes) -cne $ExpectedNewSha256.ToLowerInvariant()) {
        throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_BYTES_HASH_MISMATCH'
    }
    if ((Get-WorkerRuntimeFileSha256 $DestinationPath) -cne $ExpectedCurrentSha256.ToLowerInvariant()) {
        throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_PRESTATE_MISMATCH'
    }
    $temporaryPath = $DestinationPath + '.worker-refresh-' + [guid]::NewGuid().ToString('N') + '.tmp'
    $replaceBackupPath = $DestinationPath + '.worker-refresh-backup-' + [guid]::NewGuid().ToString('N')
    $stream = $null
    try {
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if ((Get-WorkerRuntimeFileSha256 $temporaryPath) -cne $ExpectedNewSha256.ToLowerInvariant()) {
            throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_STAGE_HASH_MISMATCH'
        }
        [IO.File]::Replace($temporaryPath, $DestinationPath, $replaceBackupPath)
        if ((Get-WorkerRuntimeFileSha256 $DestinationPath) -cne $ExpectedNewSha256.ToLowerInvariant()) {
            throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_READBACK_MISMATCH'
        }
        if ((Get-WorkerRuntimeFileSha256 $replaceBackupPath) -cne $ExpectedCurrentSha256.ToLowerInvariant()) {
            throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_BACKUP_MISMATCH'
        }
        [IO.File]::Delete($replaceBackupPath)
        if ([IO.File]::Exists($replaceBackupPath)) { throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_BACKUP_CLEANUP_FAILED' }
    } catch {
        $originalError = $_.Exception.Message
        if ([IO.File]::Exists($replaceBackupPath)) {
            try {
                $currentHash = Get-WorkerRuntimeFileSha256 $DestinationPath
                $backupHash = Get-WorkerRuntimeFileSha256 $replaceBackupPath
                if ($currentHash -eq $ExpectedNewSha256.ToLowerInvariant() -and
                    $backupHash -eq $ExpectedCurrentSha256.ToLowerInvariant()) {
                    $failedBytesPath = $DestinationPath + '.worker-refresh-failed-' + [guid]::NewGuid().ToString('N')
                    [IO.File]::Replace($replaceBackupPath, $DestinationPath, $failedBytesPath)
                    if ((Get-WorkerRuntimeFileSha256 $DestinationPath) -cne $ExpectedCurrentSha256.ToLowerInvariant() -or
                        (Get-WorkerRuntimeFileSha256 $failedBytesPath) -cne $ExpectedNewSha256.ToLowerInvariant()) {
                        throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_ROLLBACK_READBACK_MISMATCH'
                    }
                    [IO.File]::Delete($failedBytesPath)
                } elseif ($currentHash -eq $ExpectedCurrentSha256.ToLowerInvariant() -and
                    $backupHash -eq $ExpectedCurrentSha256.ToLowerInvariant()) {
                    [IO.File]::Delete($replaceBackupPath)
                } else {
                    throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_THIRD_HASH_PRESERVED'
                }
            } catch { throw 'WORKER_RUNTIME_ATOMIC_REPLACEMENT_ROLLBACK_UNKNOWN' }
        }
        throw ('WORKER_RUNTIME_ATOMIC_REPLACEMENT_FAILED:' + $originalError)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
    }
}

function Get-WorkerRuntimeTaskDefinitionSha256 {
    try { $text = Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop }
    catch { throw 'WORKER_RUNTIME_TASK_XML_READBACK_UNKNOWN' }
    if ([string]::IsNullOrWhiteSpace([string]$text)) { throw 'WORKER_RUNTIME_TASK_XML_READBACK_UNKNOWN' }
    try { [xml]$document = [string]$text }
    catch { throw 'WORKER_RUNTIME_TASK_XML_INVALID' }
    $triggerNodes = @($document.SelectNodes("//*[local-name()='Triggers']/*"))
    $settingsNode = $document.SelectSingleNode("//*[local-name()='Settings']")
    if ($triggerNodes.Count -ne 1 -or $triggerNodes[0].LocalName -cne 'TimeTrigger' -or
        $null -eq $settingsNode) { throw 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' }
    $intervalNode = $triggerNodes[0].SelectSingleNode("./*[local-name()='Repetition']/*[local-name()='Interval']")
    $durationNode = $triggerNodes[0].SelectSingleNode("./*[local-name()='Repetition']/*[local-name()='Duration']")
    $executionLimitNode = $settingsNode.SelectSingleNode("./*[local-name()='ExecutionTimeLimit']")
    $multipleInstancesNode = $settingsNode.SelectSingleNode("./*[local-name()='MultipleInstancesPolicy']")
    $disallowStartIfOnBatteriesNode = $settingsNode.SelectSingleNode("./*[local-name()='DisallowStartIfOnBatteries']")
    $stopIfGoingOnBatteriesNode = $settingsNode.SelectSingleNode("./*[local-name()='StopIfGoingOnBatteries']")
    $startWhenAvailableNode = $settingsNode.SelectSingleNode("./*[local-name()='StartWhenAvailable']")
    if ($null -eq $disallowStartIfOnBatteriesNode -or
        [string]$disallowStartIfOnBatteriesNode.InnerText -ine 'false' -or
        $null -eq $stopIfGoingOnBatteriesNode -or
        [string]$stopIfGoingOnBatteriesNode.InnerText -ine 'false') {
        throw 'WORKER_RUNTIME_TASK_POWER_POLICY_MISMATCH'
    }
    if ($null -eq $intervalNode -or [string]$intervalNode.InnerText -cne 'PT5M' -or
        $null -eq $durationNode -or [string]$durationNode.InnerText -cne 'P3650D' -or
        $null -eq $executionLimitNode -or [string]$executionLimitNode.InnerText -cne 'PT15M' -or
        $null -eq $multipleInstancesNode -or [string]$multipleInstancesNode.InnerText -cne 'IgnoreNew' -or
        $null -eq $startWhenAvailableNode -or [string]$startWhenAvailableNode.InnerText -ine 'true') {
        throw 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH'
    }
    $enabledNodes = @($document.SelectNodes("//*[local-name()='Settings']/*[local-name()='Enabled']"))
    if ($enabledNodes.Count -gt 1) { throw 'WORKER_RUNTIME_TASK_XML_ENABLED_FIELD_AMBIGUOUS' }
    foreach ($node in $enabledNodes) { $null = $node.ParentNode.RemoveChild($node) }
    $bytes = ([Text.UTF8Encoding]::new($false)).GetBytes($document.OuterXml)
    return Get-WorkerRuntimeBytesSha256 $bytes
}

function Get-WorkerRuntimeTaskReadback([bool]$ExpectedEnabled, [string]$ExpectedState,
    [string]$ExpectedDefinitionSha256 = '', [string[]]$AdditionalStates = @()) {
    $task = Get-TaskOptional
    if ($null -eq $task -or $task.TaskPath -cne '\' -or
        ([string]$task.State -cne $ExpectedState -and [string]$task.State -notin $AdditionalStates)) {
        throw 'WORKER_RUNTIME_TASK_STATE_READBACK_MISMATCH'
    }
    $enabledProperty = $task.Settings.PSObject.Properties['Enabled']
    if ($null -eq $enabledProperty -or $enabledProperty.Value -isnot [bool] -or
        $enabledProperty.Value -ne $ExpectedEnabled) { throw 'WORKER_RUNTIME_TASK_ENABLED_READBACK_MISMATCH' }
    $taskPrincipalProperty = $task.Principal.PSObject.Properties['UserId']
    if ($null -eq $taskPrincipalProperty) { throw 'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_UNKNOWN' }
    $taskPrincipalSid = Resolve-WorkerRuntimeIdentitySid ([string]$taskPrincipalProperty.Value)
    $currentIdentity = $null
    try {
        $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $currentIdentity.User -or
            $taskPrincipalSid -cne $currentIdentity.User.Value) {
            throw 'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_MISMATCH'
        }
    } catch {
        if ($_.Exception.Message -eq 'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_MISMATCH') { throw }
        throw 'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_UNKNOWN'
    } finally {
        if ($null -ne $currentIdentity) { $currentIdentity.Dispose() }
    }
    if ($task.Settings.DisallowStartIfOnBatteries -isnot [bool] -or
        $task.Settings.DisallowStartIfOnBatteries -ne $false -or
        $task.Settings.StopIfGoingOnBatteries -isnot [bool] -or
        $task.Settings.StopIfGoingOnBatteries -ne $false) {
        throw 'WORKER_RUNTIME_TASK_POWER_POLICY_MISMATCH'
    }
    $actions = @($task.Actions)
    if (@($actions).Count -ne 1 -or
        [string]$actions[0].Execute -ine $wscript -or
        [string]$actions[0].Arguments -cne ('//B //NoLogo "' + $hiddenWorker + '"') -or
        [string]$actions[0].WorkingDirectory -ine $homeDir -or
        [string]$task.Principal.LogonType -cne 'Interactive' -or
        [string]$task.Principal.RunLevel -cne 'Limited' -or
        [string]$task.Settings.MultipleInstances -cne 'IgnoreNew' -or
        [string]$task.Settings.ExecutionTimeLimit -cne 'PT15M' -or
        $task.Settings.StartWhenAvailable -isnot [bool] -or
        $task.Settings.StartWhenAvailable -ne $true) {
        throw 'WORKER_RUNTIME_TASK_IDENTITY_MISMATCH'
    }
    $definitionHash = Get-WorkerRuntimeTaskDefinitionSha256
    if ($ExpectedDefinitionSha256 -and $definitionHash -cne $ExpectedDefinitionSha256.ToLowerInvariant()) {
        throw 'WORKER_RUNTIME_TASK_DEFINITION_CHANGED'
    }
    return [pscustomobject]@{ Task = $task; DefinitionSha256 = $definitionHash }
}

function Assert-WorkerRuntimeNoActiveProcess([string]$NodePath) {
    try { $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
    catch { throw 'WORKER_RUNTIME_PROCESS_STATE_UNKNOWN' }
    foreach ($process in $processes) {
        $name = [string]$process.Name
        $commandProperty = $process.PSObject.Properties['CommandLine']
        $command = if ($null -ne $commandProperty) { [string]$commandProperty.Value } else { '' }
        $exe = [string]$process.ExecutablePath
        $expectedNode = $false
        if ($exe) {
            try { $expectedNode = [string]::Equals([IO.Path]::GetFullPath($exe),
                [IO.Path]::GetFullPath($NodePath), [StringComparison]::OrdinalIgnoreCase) }
            catch { throw 'WORKER_RUNTIME_PROCESS_IDENTITY_UNKNOWN' }
        }
        if ([string]::IsNullOrWhiteSpace($command)) {
            if ($expectedNode -or $name -ieq 'wscript.exe') { throw 'WORKER_RUNTIME_PROCESS_STATE_UNKNOWN' }
            continue
        }
        if ($command.IndexOf($worker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $command.IndexOf($hiddenWorker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw 'WORKER_RUNTIME_PROCESS_RUNNING_DO_NOT_REFRESH'
        }
    }
}

function Invoke-WorkerRuntimeCommandText([string]$Executable, [string[]]$Arguments,
    [string]$FailureCode) {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable @Arguments 2>$null)
        $exitCode = $LASTEXITCODE
    } catch { throw $FailureCode }
    finally { $ErrorActionPreference = $oldPreference }
    if ($exitCode -ne 0) { throw $FailureCode }
    return (($output -join "`n").Trim())
}

function Assert-WorkerRuntimeTrustedRuns([string]$RunPagesJson, [string]$ExpectedHead) {
    if ($ExpectedHead -notmatch '^[0-9a-fA-F]{40}$') { throw 'WORKER_RUNTIME_CI_HEAD_PIN_INVALID' }
    try { $pages = ConvertFrom-Json -InputObject $RunPagesJson -ErrorAction Stop }
    catch { throw 'WORKER_RUNTIME_CI_READBACK_MALFORMED' }
    if ($null -eq $pages) { throw 'WORKER_RUNTIME_CI_READBACK_MALFORMED' }
    $required = @{
        'csg-trusted-verifier-hosted' = [pscustomobject]@{
            Name='V5.3-R4 CSG trusted verifier (GitHub-hosted)'
            Path='.github/workflows/csg-trusted-verifier-hosted.yml'
            Event='pull_request_target'; WorkflowId='381764260'
        }
        'check-native-only' = [pscustomobject]@{
            Name='V5.3 main source retirement integrity'
            Path='.github/workflows/v53-r4-main-source-retirement.yml'
            Event='pull_request'; WorkflowId='381351204'
        }
        'v2-native-windows' = [pscustomobject]@{
            Name='V53R4 OpenCode V2 CLI zero-token qualification'
            Path='.github/workflows/v53r4-v2-cli-qualification.yml'
            Event='pull_request'; WorkflowId='382735923'
        }
    }
    $latest = @{}
    foreach ($page in @($pages)) {
        if ($null -eq $page -or $null -eq $page.PSObject.Properties['workflow_runs']) {
            throw 'WORKER_RUNTIME_CI_READBACK_MALFORMED'
        }
        foreach ($run in @($page.workflow_runs)) {
            if ($null -eq $run) { throw 'WORKER_RUNTIME_CI_READBACK_MALFORMED' }
            $pathProperty = $run.PSObject.Properties['path']
            if ($null -eq $pathProperty) { throw 'WORKER_RUNTIME_CI_READBACK_MALFORMED' }
            $path = [string]$pathProperty.Value
            $name = $null
            foreach ($requiredName in $required.Keys) {
                if ($path -ceq $required[$requiredName].Path) { $name = $requiredName; break }
            }
            if ($null -eq $name) { continue }
            foreach ($propertyName in @('name','event','status','conclusion','head_sha',
                'workflow_id','run_attempt','id','head_repository')) {
                if ($null -eq $run.PSObject.Properties[$propertyName]) {
                    throw 'WORKER_RUNTIME_CI_READBACK_MALFORMED'
                }
            }
            $attemptText = [string]$run.run_attempt
            $runIdText = [string]$run.id
            if ($attemptText -notmatch '^\d+$' -or $runIdText -notmatch '^\d+$') {
                throw 'WORKER_RUNTIME_CI_RUN_ID_INVALID'
            }
            $attempt = [int]$attemptText
            $runId = [long]$runIdText
            $headRepository = ''
            if ($null -ne $run.head_repository -and
                $null -ne $run.head_repository.PSObject.Properties['full_name']) {
                $headRepository = [string]$run.head_repository.full_name
            }
            $normalized = [pscustomobject]@{
                Attempt=$attempt; RunId=$runId; Name=[string]$run.name; Path=$path
                Event=[string]$run.event; Status=[string]$run.status
                Conclusion=[string]$run.conclusion; HeadSha=[string]$run.head_sha
                HeadRepository=$headRepository; WorkflowId=[string]$run.workflow_id
            }
            if (-not $latest.ContainsKey($name) -or
                $attempt -gt $latest[$name].Attempt -or
                ($attempt -eq $latest[$name].Attempt -and $runId -gt $latest[$name].RunId)) {
                $latest[$name] = $normalized
            }
        }
    }
    foreach ($name in @('csg-trusted-verifier-hosted','check-native-only','v2-native-windows')) {
        if (-not $latest.ContainsKey($name)) { throw ('WORKER_RUNTIME_CI_CHECK_MISSING:' + $name) }
        $run = $latest[$name]
        $identity = $required[$name]
        if ($run.Name -cne $identity.Name -or $run.Path -cne $identity.Path -or
            $run.Event -cne $identity.Event -or $run.Status -cne 'completed' -or
            $run.Conclusion -cne 'success' -or $run.HeadSha -ine $ExpectedHead -or
            $run.HeadRepository -cne $repo -or $run.WorkflowId -cne $identity.WorkflowId) {
            throw ('WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS:' + $name)
        }
    }
}

function Assert-WorkerRuntimeAcceptedPrAncestry([string]$GitExe, [string]$RepoRoot,
    [string]$AcceptedPrHead, [string]$MergeCommitSha, [string]$SourceMainSha) {
    foreach ($sha in @($AcceptedPrHead,$MergeCommitSha,$SourceMainSha)) {
        if ($sha -notmatch '^[0-9a-fA-F]{40}$') { throw 'WORKER_RUNTIME_ACCEPTED_PR_SHA_INVALID' }
    }
    $null = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$RepoRoot,'merge-base','--is-ancestor',
        $MergeCommitSha,$SourceMainSha) 'WORKER_RUNTIME_ACCEPTED_PR_NOT_IN_MAIN'
    try {
        $null = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$RepoRoot,'merge-base','--is-ancestor',
            $AcceptedPrHead,$SourceMainSha) 'WORKER_RUNTIME_ACCEPTED_PR_HEAD_NOT_IN_MAIN'
        return
    } catch {
        # GitHub rebase and squash merges can rewrite the PR head commit. If so,
        # accept only an exact tree match to the provider-reported merge commit.
        $acceptedTree = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$RepoRoot,'rev-parse',
            ($AcceptedPrHead + '^{tree}')) 'WORKER_RUNTIME_ACCEPTED_PR_TREE_READBACK_FAILED'
        $mergeTree = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$RepoRoot,'rev-parse',
            ($MergeCommitSha + '^{tree}')) 'WORKER_RUNTIME_MERGE_TREE_READBACK_FAILED'
        if ($acceptedTree -cne $mergeTree) {
            throw 'WORKER_RUNTIME_ACCEPTED_PR_MERGE_TREE_MISMATCH'
        }
    }
}

function Get-WorkerRuntimeGitPath([string]$File) {
    return ('native-bridge/' + $File)
}

function Assert-WorkerRuntimeSource([string]$GitExe, [string]$GhExe) {
    if ($SourceMainSha -notmatch '^[0-9a-fA-F]{40}$' -or
        $AcceptedPr -lt 1 -or $AcceptedPrHead -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'WORKER_RUNTIME_SOURCE_PINS_REQUIRED'
    }
    if ([IO.Path]::GetFileName([IO.Path]::GetFullPath($PSScriptRoot)) -ine 'native-bridge') {
        throw 'WORKER_RUNTIME_SOURCE_ROOT_INVALID'
    }
    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $gitRoot = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$repoRoot,'rev-parse','--show-toplevel') `
        'WORKER_RUNTIME_LOCAL_GIT_READBACK_FAILED'
    if (-not [string]::Equals([IO.Path]::GetFullPath($gitRoot), $repoRoot,
        [StringComparison]::OrdinalIgnoreCase)) { throw 'WORKER_RUNTIME_LOCAL_GIT_ROOT_MISMATCH' }
    $localHead = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$repoRoot,'rev-parse','HEAD') `
        'WORKER_RUNTIME_LOCAL_HEAD_READBACK_FAILED'
    if ($localHead -ine $SourceMainSha) { throw 'WORKER_RUNTIME_LOCAL_HEAD_MISMATCH' }
    $status = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$repoRoot,'status','--porcelain=v1','--untracked-files=all') `
        'WORKER_RUNTIME_LOCAL_STATUS_READBACK_FAILED'
    if ($status) { throw 'WORKER_RUNTIME_SOURCE_WORKTREE_DIRTY' }
    $mainJson = Invoke-WorkerRuntimeCommandText $GhExe @('api',('repos/' + $repo + '/commits/main')) `
        'WORKER_RUNTIME_GITHUB_MAIN_READBACK_FAILED'
    try { $mainReadback = ConvertFrom-Json -InputObject $mainJson -ErrorAction Stop }
    catch { throw 'WORKER_RUNTIME_GITHUB_MAIN_READBACK_FAILED' }
    if ($null -eq $mainReadback -or [string]$mainReadback.sha -ine $SourceMainSha) {
        throw 'WORKER_RUNTIME_GITHUB_MAIN_CHANGED'
    }
    $prJson = Invoke-WorkerRuntimeCommandText $GhExe @('api',('repos/' + $repo + '/pulls/' + $AcceptedPr)) `
        'WORKER_RUNTIME_ACCEPTED_PR_READBACK_FAILED'
    try { $pr = ConvertFrom-Json -InputObject $prJson -ErrorAction Stop }
    catch { throw 'WORKER_RUNTIME_ACCEPTED_PR_READBACK_FAILED' }
    if ($null -eq $pr -or $null -eq $pr.base -or $null -eq $pr.head -or
        $null -eq $pr.base.repo -or $null -eq $pr.head.repo -or
        [string]$pr.state -cne 'closed' -or -not $pr.merged_at -or
        [string]$pr.base.ref -cne 'main' -or
        [string]$pr.base.repo.full_name -cne $repo -or
        [string]$pr.head.repo.full_name -cne $repo -or
        [string]$pr.head.sha -ine $AcceptedPrHead -or
        [string]$pr.merge_commit_sha -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'WORKER_RUNTIME_ACCEPTED_PR_IDENTITY_MISMATCH'
    }
    $runsJson = Invoke-WorkerRuntimeCommandText $GhExe @('api',
        ('repos/' + $repo + '/actions/runs?head_sha=' + $AcceptedPrHead + '&per_page=100'),
        '--paginate','--slurp') 'WORKER_RUNTIME_CI_READBACK_FAILED'
    Assert-WorkerRuntimeTrustedRuns $runsJson $AcceptedPrHead
    Assert-WorkerRuntimeAcceptedPrAncestry $GitExe $repoRoot $AcceptedPrHead ([string]$pr.merge_commit_sha) $SourceMainSha
    foreach ($file in $runtimeFiles) {
        $gitPath = Get-WorkerRuntimeGitPath $file
        $mainBlob = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$repoRoot,'rev-parse',($SourceMainSha + ':' + $gitPath)) `
            'WORKER_RUNTIME_MAIN_TREE_READBACK_FAILED'
        $prBlob = Invoke-WorkerRuntimeCommandText $GitExe @('-C',$repoRoot,'rev-parse',($AcceptedPrHead + ':' + $gitPath)) `
            'WORKER_RUNTIME_PR_TREE_READBACK_FAILED'
        if ($mainBlob -cne $prBlob) { throw ('WORKER_RUNTIME_ACCEPTED_PR_BUNDLE_MISMATCH:' + $file) }
    }
    return $repoRoot
}

function Write-WorkerRuntimeNewFile([string]$Path, [byte[]]$Bytes) {
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
    if ((Get-WorkerRuntimeFileSha256 $Path) -cne (Get-WorkerRuntimeBytesSha256 $Bytes)) {
        throw 'WORKER_RUNTIME_STAGED_FILE_READBACK_MISMATCH'
    }
}

function Invoke-WorkerRuntimeRefresh {
    if ($env:COMPUTERNAME.ToUpperInvariant() -ne $expectedHost) { throw 'WRONG_HOST_STOP' }
    if (-not (Test-GhAuthenticated 'gh.exe')) { throw 'GH_AUTH_NOT_READY_HUMAN_OAUTH_GATE' }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'WORKER_RUNTIME_CONFIG_REQUIRED' }
    foreach ($path in @($homeDir,$configPath,$configWriteLockPath,$hiddenWorker,$worker)) {
        Assert-WorkerRuntimePathChain $path
    }
    $gh = Require-Command 'gh.exe'
    $git = Require-Command 'git.exe'
    $node = $null
    if (-not (Test-Path -LiteralPath $hiddenWorker -PathType Leaf) -or
        (Get-WorkerRuntimeFileSha256 $hiddenWorker) -cne $hiddenWorkerSha256.ToLowerInvariant()) {
        throw 'HIDDEN_WORKER_WRAPPER_MISSING_OR_UNVERIFIED'
    }
    $wrapperText = [IO.File]::ReadAllText($hiddenWorker)
    $nodeMatch = [regex]::Match($wrapperText, '(?m)^\s*commandLine\s*=\s*"""([^"\r\n]+)"{2}')
    if (-not $nodeMatch.Success) { throw 'HIDDEN_WORKER_NODE_COMMAND_UNREADABLE' }
    $node = $nodeMatch.Groups[1].Value
    if (-not [IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
        throw 'HIDDEN_WORKER_NODE_EXECUTABLE_MISSING'
    }
    if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) { throw 'WINDOWS_SCRIPT_HOST_NOT_FOUND' }

    $configLock = $null
    $backupDir = ''
    $stagingDir = ''
    $acceptedDir = ''
    $initialTaskDefinitionSha256 = ''
    $initialConfigSha256 = ''
    $modules = [ordered]@{}
    $changedNames = New-Object System.Collections.Generic.List[string]
    $taskDisableAttempted = $false
    try {
        try { $configLock = [IO.File]::Open($configWriteLockPath, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { throw 'WORKER_CONFIG_WRITE_LOCK_BUSY_DO_NOT_REFRESH' }

        $repoRoot = Assert-WorkerRuntimeSource $git $gh
        $taskReadback = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $true -ExpectedState 'Ready'
        $initialTaskDefinitionSha256 = $taskReadback.DefinitionSha256
        $initialConfigSha256 = Get-WorkerRuntimeFileSha256 $configPath
        $sourcePrestate = [ordered]@{}
        foreach ($file in $runtimeFiles) {
            $sourcePath = Join-Path $PSScriptRoot $file
            $targetPath = Join-Path $homeDir $file
            Assert-WorkerRuntimePathChain $sourcePath
            Assert-WorkerRuntimePathChain $targetPath
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf) -or
                -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
                throw ('WORKER_RUNTIME_MODULE_MISSING:' + $file)
            }
            $sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
            $targetBytes = [IO.File]::ReadAllBytes($targetPath)
            $sourceHash = Get-WorkerRuntimeBytesSha256 $sourceBytes
            $targetHash = Get-WorkerRuntimeBytesSha256 $targetBytes
            & $node --check $sourcePath
            if ($LASTEXITCODE -ne 0) { throw ('WORKER_RUNTIME_SOURCE_SYNTAX_INVALID:' + $file) }
            $modules[$file] = [pscustomobject]@{ SourcePath=$sourcePath; TargetPath=$targetPath;
                SourceBytes=$sourceBytes; SourceHash=$sourceHash; OldBytes=$targetBytes; OldHash=$targetHash }
            $sourcePrestate[$file] = $targetHash
            if ($sourceHash -ne $targetHash) { $changedNames.Add($file) }
        }
        if ($changedNames.Count -eq 0) {
            Write-Output 'WORKER_RUNTIME_REFRESH=NOT_REQUIRED'
            Write-Output 'MODEL_EXECUTION=NOT_INVOKED_BY_REFRESH; W2_CLAIMS_AND_RECEIPTS=UNCHANGED'
            return
        }

        $backupRoot = Join-Path $homeDir 'backups'
        if (Test-Path -LiteralPath $backupRoot) {
            $backupRootItem = Get-Item -LiteralPath $backupRoot -Force -ErrorAction Stop
            if (-not $backupRootItem.PSIsContainer -or
                (($backupRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                throw 'WORKER_RUNTIME_BACKUP_ROOT_INVALID'
            }
        } else { $null = New-Item -ItemType Directory -Path $backupRoot -ErrorAction Stop }
        Assert-WorkerRuntimePathChain $backupRoot
        $operationId = [guid]::NewGuid().ToString('N')
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
        $backupDir = Join-Path $backupRoot ('worker-runtime-refresh-' + $stamp + '-' + $operationId)
        $stagingDir = Join-Path $backupRoot ('.worker-deploy-stage-' + $operationId)
        $acceptedDir = Join-Path $backupRoot ('worker-deploy-accepted-' + $AcceptedPr + '-' +
            $AcceptedPrHead.Substring(0,12).ToLowerInvariant() + '-' + $operationId)
        if ((Test-Path -LiteralPath $backupDir) -or (Test-Path -LiteralPath $stagingDir) -or
            (Test-Path -LiteralPath $acceptedDir)) { throw 'WORKER_RUNTIME_REFRESH_PATH_COLLISION' }
        $null = New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop
        $null = New-Item -ItemType Directory -Path $stagingDir -ErrorAction Stop
        Assert-WorkerRuntimePathChain $backupDir
        Assert-WorkerRuntimePathChain $stagingDir
        foreach ($file in $runtimeFiles) {
            $module = $modules[$file]
            Write-WorkerRuntimeNewFile (Join-Path $backupDir $file) $module.OldBytes
            Write-WorkerRuntimeNewFile (Join-Path $stagingDir $file) $module.SourceBytes
        }
        $manifest = [ordered]@{ schema=1; source_main_sha=$SourceMainSha.ToLowerInvariant();
            accepted_pr=$AcceptedPr; accepted_pr_head=$AcceptedPrHead.ToLowerInvariant();
            files=@($runtimeFiles | ForEach-Object { [ordered]@{ file=$_; stage_sha256=$modules[$_].SourceHash } }) }
        $manifestBytes = ([Text.UTF8Encoding]::new($false)).GetBytes(
            ((ConvertTo-Json -InputObject $manifest -Depth 8 -Compress) + [Environment]::NewLine))
        Write-WorkerRuntimeNewFile (Join-Path $stagingDir 'manifest.json') $manifestBytes
        $prestate = [ordered]@{ schema=1; recorded_at_utc=[DateTime]::UtcNow.ToString('o');
            source_main_sha=$SourceMainSha.ToLowerInvariant(); accepted_pr=$AcceptedPr;
            accepted_pr_head=$AcceptedPrHead.ToLowerInvariant(); task_definition_sha256=$initialTaskDefinitionSha256;
            config_sha256=$initialConfigSha256; installed_runtime_sha256=$sourcePrestate }
        $prestateBytes = ([Text.UTF8Encoding]::new($false)).GetBytes(
            ((ConvertTo-Json -InputObject $prestate -Depth 8 -Compress) + [Environment]::NewLine))
        Write-WorkerRuntimeNewFile (Join-Path $backupDir 'prestate.json') $prestateBytes

        try {
            $null = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $true -ExpectedState 'Ready' `
                -ExpectedDefinitionSha256 $initialTaskDefinitionSha256
            if ((Get-WorkerRuntimeFileSha256 $configPath) -cne $initialConfigSha256) {
                throw 'WORKER_RUNTIME_CONFIG_CHANGED_BEFORE_DISABLE'
            }
            $taskDisableAttempted = $true
            Disable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
            $null = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
                -ExpectedDefinitionSha256 $initialTaskDefinitionSha256
            Assert-WorkerRuntimeNoActiveProcess $node

            if ((Get-WorkerRuntimeFileSha256 $configPath) -cne $initialConfigSha256) {
                throw 'WORKER_RUNTIME_CONFIG_CHANGED_BEFORE_WRITE'
            }
            foreach ($file in $runtimeFiles) {
                $module = $modules[$file]
                if ((Get-WorkerRuntimeFileSha256 $module.TargetPath) -cne $module.OldHash -or
                    (Get-WorkerRuntimeFileSha256 $module.SourcePath) -cne $module.SourceHash) {
                    throw ('WORKER_RUNTIME_SOURCE_OR_TARGET_CHANGED_BEFORE_WRITE:' + $file)
                }
            }
            $null = Assert-WorkerRuntimeSource $git $gh
            foreach ($file in $changedNames) {
                $module = $modules[$file]
                Write-WorkerRuntimeAtomicReplacement $module.SourceBytes $module.TargetPath $module.OldHash $module.SourceHash
            }
            foreach ($file in $runtimeFiles) {
                if ((Get-WorkerRuntimeFileSha256 $modules[$file].TargetPath) -cne $modules[$file].SourceHash) {
                    throw ('WORKER_RUNTIME_FINAL_COMPONENT_READBACK_MISMATCH:' + $file)
                }
            }
            if ((Get-WorkerRuntimeFileSha256 $configPath) -cne $initialConfigSha256) {
                throw 'WORKER_RUNTIME_CONFIG_CHANGED_DURING_REFRESH'
            }
            $null = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
                -ExpectedDefinitionSha256 $initialTaskDefinitionSha256
            [IO.Directory]::Move($stagingDir, $acceptedDir)
            $stagingDir = ''
            $readManifest = Get-Content -LiteralPath (Join-Path $acceptedDir 'manifest.json') -Raw -ErrorAction Stop |
                ConvertFrom-Json -ErrorAction Stop
            if ($readManifest.schema -ne 1 -or $readManifest.source_main_sha -cne $SourceMainSha.ToLowerInvariant() -or
                $readManifest.accepted_pr -ne $AcceptedPr -or
                $readManifest.accepted_pr_head -cne $AcceptedPrHead.ToLowerInvariant() -or
                @($readManifest.files).Count -ne $runtimeFiles.Count) {
                throw 'WORKER_RUNTIME_ACCEPTED_MANIFEST_READBACK_MISMATCH'
            }
            foreach ($file in $runtimeFiles) {
                $entries = @($readManifest.files | Where-Object { $_.file -ceq $file })
                if ($entries.Count -ne 1 -or $entries[0].stage_sha256 -cne $modules[$file].SourceHash -or
                    (Get-WorkerRuntimeFileSha256 (Join-Path $acceptedDir $file)) -cne $modules[$file].SourceHash) {
                    throw ('WORKER_RUNTIME_ACCEPTED_MANIFEST_COMPONENT_MISMATCH:' + $file)
                }
            }
            Enable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
            $null = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $true -ExpectedState 'Ready' `
                -ExpectedDefinitionSha256 $initialTaskDefinitionSha256 -AdditionalStates @('Running','Queued')
        } catch {
            $originalError = $_.Exception.Message
            $rollbackErrors = New-Object System.Collections.Generic.List[string]
            if ($taskDisableAttempted) {
                $safeToRollback = $false
                try {
                    $current = Get-TaskOptional
                    if ($null -eq $current -or (Get-WorkerRuntimeTaskDefinitionSha256) -cne $initialTaskDefinitionSha256) {
                        throw 'WORKER_RUNTIME_TASK_IDENTITY_CHANGED'
                    }
                    if ([string]$current.State -eq 'Running') { throw 'WORKER_RUNTIME_TASK_RUNNING_DURING_ROLLBACK' }
                    if ($current.Settings.Enabled -eq $true) {
                        Disable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
                    }
                    $null = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
                        -ExpectedDefinitionSha256 $initialTaskDefinitionSha256
                    Assert-WorkerRuntimeNoActiveProcess $node
                    $safeToRollback = $true
                } catch { $rollbackErrors.Add('TaskScheduler-or-active-process') }
                if ($safeToRollback) {
                    for ($index = $changedNames.Count - 1; $index -ge 0; $index--) {
                        $file = $changedNames[$index]
                        $module = $modules[$file]
                        try {
                            $currentHash = Get-WorkerRuntimeFileSha256 $module.TargetPath
                            if ($currentHash -eq $module.OldHash) { continue }
                            if ($currentHash -cne $module.SourceHash) { throw 'WORKER_RUNTIME_THIRD_HASH_PRESERVED' }
                            Write-WorkerRuntimeAtomicReplacement $module.OldBytes $module.TargetPath `
                                $module.SourceHash $module.OldHash
                        } catch { $rollbackErrors.Add($file) }
                    }
                }
                if ($rollbackErrors.Count -eq 0) {
                    foreach ($file in $runtimeFiles) {
                        try {
                            if ((Get-WorkerRuntimeFileSha256 $modules[$file].TargetPath) -cne $modules[$file].OldHash) {
                                $rollbackErrors.Add($file)
                            }
                        } catch { $rollbackErrors.Add($file) }
                    }
                    try {
                        if ((Get-WorkerRuntimeFileSha256 $configPath) -cne $initialConfigSha256 -or
                            (Get-WorkerRuntimeTaskDefinitionSha256) -cne $initialTaskDefinitionSha256) {
                            $rollbackErrors.Add('config-or-task-definition')
                        }
                    } catch { $rollbackErrors.Add('config-or-task-definition') }
                }
                if ($rollbackErrors.Count -eq 0) {
                    try {
                        Enable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
                        $null = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $true -ExpectedState 'Ready' `
                            -ExpectedDefinitionSha256 $initialTaskDefinitionSha256 -AdditionalStates @('Running','Queued')
                    } catch { $rollbackErrors.Add('TaskScheduler-enable') }
                }
            }
            if ($rollbackErrors.Count -gt 0) {
                throw ('WORKER_RUNTIME_REFRESH_PARTIAL_STATE_REVIEW_REQUIRED:' + $originalError +
                    ';paths=' + ($rollbackErrors -join ',') + ';backup=' + $backupDir)
            }
            if ($taskDisableAttempted) {
                throw ('WORKER_RUNTIME_REFRESH_FAILED_ROLLED_BACK:' + $originalError + ';backup=' + $backupDir)
            }
            throw $originalError
        }
        Write-Output ('WORKER_RUNTIME_REFRESH=SUCCESS;updated=' + ($changedNames -join ','))
        Write-Output ('WORKER_RUNTIME_REFRESH_BACKUP=' + $backupDir)
        Write-Output ('WORKER_RUNTIME_ACCEPTED_MANIFEST=' + (Join-Path $acceptedDir 'manifest.json'))
        Write-Output 'TASK_DEFINITION=UNCHANGED;CONFIG=UNCHANGED;W2_CLAIMS_AND_RECEIPTS=UNCHANGED'
        Write-Output 'MODEL_EXECUTION=NOT_INVOKED_BY_REFRESH'
    } finally {
        if ($null -ne $configLock) { $configLock.Dispose() }
    }
}

function Require-Command([string]$Name) {
    $entry = Get-Command $Name -ErrorAction Stop | Select-Object -First 1
    if (-not $entry.Source) { throw ('COMMAND_WITHOUT_SOURCE: ' + $Name) }
    return $entry.Source
}
function Get-QualifiedOpenCodeV2([string]$NodeExecutable) {
    if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        return [pscustomobject]@{ ready = $false; bin = $null; version = $null; candidates_checked = -1; status = 'NODE_UNAVAILABLE' }
    }
    $probe = "import { qualifyOpenCodeV2 } from './opencode-v2.mjs'; console.log(JSON.stringify(qualifyOpenCodeV2(process.env, true)));"
    $output = $null
    $probeExit = -1
    Push-Location -LiteralPath $PSScriptRoot
    try {
        $output = & $NodeExecutable --input-type=module --eval $probe 2>$null
        $probeExit = $LASTEXITCODE
    } catch {
        return [pscustomobject]@{ ready = $false; bin = $null; version = $null; candidates_checked = -1; status = 'QUALIFIER_EXECUTION_FAILED' }
    } finally {
        Pop-Location
    }
    $json = (@($output) -join "`n").Trim()
    if ($probeExit -ne 0 -or -not $json) {
        return [pscustomobject]@{ ready = $false; bin = $null; version = $null; candidates_checked = -1; status = 'QUALIFIER_EXECUTION_FAILED' }
    }
    try { $result = $json | ConvertFrom-Json -ErrorAction Stop }
    catch { return [pscustomobject]@{ ready = $false; bin = $null; version = $null; candidates_checked = -1; status = 'QUALIFIER_OUTPUT_INVALID' } }
    if ($result.ready -eq $true) {
        return [pscustomobject]@{ ready = $true; bin = $result.bin; version = $result.version; candidates_checked = $result.candidates_checked; status = 'QUALIFIED' }
    }
    $status = if ([int]$result.candidates_checked -eq 0) { 'NOT_FOUND' } else { 'NOT_QUALIFIED' }
    return [pscustomobject]@{ ready = $false; bin = $null; version = $null; candidates_checked = $result.candidates_checked; status = $status }
}
function Get-TaskOptional {
    # Exact visible task identity. If the provider refuses enumeration, fail-closed;
    # registration itself also rejects an ACL-hidden name collision.
    $all = @(Get-ScheduledTask -ErrorAction Stop)
    $matches = @($all | Where-Object { $_.TaskName -eq $taskName -and $_.TaskPath -eq '\' })
    if ($matches.Count -gt 1) { throw 'TASK_NAME_NOT_UNIQUE' }
    if ($matches.Count -eq 0) { return $null }
    return $matches[0]
}
function Inspect-Task {
    $task = Get-TaskOptional
    if ($null -eq $task) { Write-Output 'NATIVE_TASK=ABSENT'; return }
    Write-Output ('NATIVE_TASK=EXISTS state=' + $task.State + ' logon=' + $task.Principal.LogonType + ' runlevel=' + $task.Principal.RunLevel)
    foreach ($a in @($task.Actions)) { Write-Output ('NATIVE_TASK_ACTION=' + $a.Execute + ' ' + $a.Arguments) }
}
if ($env:COMPUTERNAME.ToUpperInvariant() -ne $expectedHost) { throw 'WRONG_HOST_STOP' }
if ($Mode -eq 'Audit') {
    Write-Output ('PROJECT_ID=' + $project)
    Write-Output ('HOST=' + $env:COMPUTERNAME)
    Write-Output ('ISSUE_NUMBER_ARGUMENT=' + $IssueNumber)
    $node = $null
    try { $node = Require-Command 'node.exe'; Write-Output ('node.exe=' + $node) }
    catch { Write-Output 'node.exe=UNAVAILABLE' }
    try { Write-Output ('gh.exe=' + (Require-Command 'gh.exe')) }
    catch { Write-Output 'gh.exe=UNAVAILABLE' }
    if ($node) {
        $openCode = Get-QualifiedOpenCodeV2 $node
        if ($openCode.ready) {
            Write-Output ('OPENCODE_V2_CLI_QUALIFIED=' + $openCode.bin + ';VERSION=' + $openCode.version + ';SIGNATURE=VALID')
        } else {
            Write-Output ('OPENCODE_V2_CLI_UNAVAILABLE=' + $openCode.status + ';CANDIDATES_CHECKED=' + $openCode.candidates_checked)
        }
    } else {
        Write-Output 'OPENCODE_V2_CLI_UNAVAILABLE=NODE_UNAVAILABLE'
    }
    Write-Output ('CONFIG_EXISTS=' + (Test-Path -LiteralPath $configPath))
    Inspect-Task
    return
}
if ($Mode -eq 'RunOnce') {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'BRIDGE_NOT_INSTALLED' }
    $node = Require-Command 'node.exe'
    & $node $worker --config $configPath
    if ($LASTEXITCODE -ne 0) { throw ('WORKER_EXIT=' + $LASTEXITCODE) }
    return
}
if ($Mode -eq 'Uninstall') {
    $task = Get-TaskOptional
    if ($null -eq $task) { Write-Output 'ALREADY_ABSENT'; return }
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Arguments -notlike '*PTYSDNativeBridge*worker.mjs*') {
        throw 'TASK_IDENTITY_MISMATCH_DO_NOT_DELETE'
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    if ($null -ne (Get-TaskOptional)) { throw 'TASK_UNREGISTER_READBACK_FAILED' }
    Write-Output 'NATIVE_TASK_REMOVED_LOCAL_EVIDENCE_RETAINED'
    return
}
if ($Mode -eq 'RefreshRuntimeModules') {
    Invoke-WorkerRuntimeRefresh
    return
}
if ($Mode -eq 'Install') {
    if ($null -ne (Get-TaskOptional)) { throw 'TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE' }
    if ($IssueNumber -le 1) { throw 'EXACT_DISPATCH_ISSUE_NUMBER_REQUIRED' }
    if ($TrustedDispatcher -notmatch '^[a-zA-Z0-9-]{1,39}$') { throw 'INVALID_DISPATCH_AUTHOR' }
    if (-not $Workspace) { throw 'EXACT_WORKSPACE_REQUIRED' }
    $full = [IO.Path]::GetFullPath($Workspace)
    $root = [IO.Path]::GetFullPath($env:USERPROFILE + [IO.Path]::DirectorySeparatorChar)
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'WORKSPACE_MUST_BE_UNDER_USER_HOME' }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'WORKSPACE_NOT_FOUND' }
    $null = Require-Command 'gh.exe'
    # The first queued job is native ping and does NOT launch OpenCode. CLI qualification
    # uses the pinned wrapper Node and shared Authenticode/V2 resolver; it grants no model authorization.
    if (-not (Test-GhAuthenticated 'gh.exe')) { throw 'GH_AUTH_NOT_READY_HUMAN_OAUTH_GATE' }
    foreach ($runtimeFile in $runtimeFiles) {
        $sourcePath = Join-Path $PSScriptRoot $runtimeFile
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw ('SOURCE_RUNTIME_MODULE_NOT_FOUND:' + $runtimeFile)
        }
    }
    if (-not (Test-Path -LiteralPath $hiddenWorker -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $hiddenWorker).Hash -ne $hiddenWorkerSha256) {
        throw 'HIDDEN_WORKER_WRAPPER_MISSING_OR_UNVERIFIED'
    }
    $wrapperText = [IO.File]::ReadAllText($hiddenWorker)
    $nodeMatch = [regex]::Match($wrapperText, '(?m)^\s*commandLine\s*=\s*"""([^"\r\n]+)"{2}')
    if (-not $nodeMatch.Success) { throw 'HIDDEN_WORKER_NODE_COMMAND_UNREADABLE' }
    $node = $nodeMatch.Groups[1].Value
    if (-not [IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
        throw 'HIDDEN_WORKER_NODE_EXECUTABLE_MISSING'
    }
    $openCode = Get-QualifiedOpenCodeV2 $node
    if ($openCode.ready) {
        Write-Output ('OPENCODE_V2_CLI_QUALIFIED=' + $openCode.bin + ';VERSION=' + $openCode.version + ';SIGNATURE=VALID')
        Write-Output 'OPENCODE_PLAN_NOT_YET_LIVE_VERIFIED'
    } elseif ($openCode.status -eq 'NOT_FOUND') {
        Write-Output 'OPENCODE_V2_CLI_NOT_FOUND_PING_ONLY'
    } else {
        Write-Output ('OPENCODE_V2_CLI_NOT_QUALIFIED_PING_ONLY=' + $openCode.status + ';CANDIDATES_CHECKED=' + $openCode.candidates_checked)
    }
    if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) { throw 'WINDOWS_SCRIPT_HOST_NOT_FOUND' }
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
    $workerHash = $null
    foreach ($runtimeFile in $runtimeFiles) {
        $sourcePath = Join-Path $PSScriptRoot $runtimeFile
        $targetPath = Join-Path $homeDir $runtimeFile
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -ErrorAction Stop
        $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash
        $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetPath).Hash
        if ($targetHash -ne $sourceHash) { throw ('RUNTIME_MODULE_COPY_HASH_MISMATCH:' + $runtimeFile) }
        & $node --check $targetPath
        if ($LASTEXITCODE -ne 0) { throw ('NODE_SYNTAX_INVALID:' + $runtimeFile) }
        if ($runtimeFile -eq 'worker.mjs') { $workerHash = $sourceHash }
    }
    $baseConfig = [ordered]@{
        project_id = $project; repo = $repo; host = $expectedHost; issue = $IssueNumber
        workspace = $full; state_dir = $homeDir; dispatchers = @($TrustedDispatcher)
    }
    $configWriteLock = $null
    try {
        $configWriteLock = [IO.File]::Open($configWriteLockPath, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        throw 'WORKER_CONFIG_WRITE_LOCK_BUSY_DO_NOT_OVERWRITE'
    }
    try {
        $existingConfig = $null
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            try {
                $existingConfig = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json -ErrorAction Stop
                if ($null -eq $existingConfig -or
                    $existingConfig -isnot [System.Management.Automation.PSCustomObject]) {
                    throw 'WORKER_CONFIG_TOP_LEVEL_OBJECT_REQUIRED'
                }
            } catch {
                throw 'WORKER_CONFIG_READ_OR_PARSE_FAILED_DO_NOT_OVERWRITE'
            }
        }
        $c = Merge-WorkerConfig $existingConfig $baseConfig
        Write-WorkerConfigAtomically -Path $configPath -Text ($c | ConvertTo-Json -Depth 20)
    } finally {
        if ($null -ne $configWriteLock) { $configWriteLock.Dispose() }
    }
    $argsLine = '//B //NoLogo "' + $hiddenWorker + '"'
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $argsLine -WorkingDirectory $homeDir
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
        -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $username = $env:USERDOMAIN + '\' + $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -ErrorAction Stop | Out-Null
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $wscript -or
        $task.Actions[0].Arguments -ne $argsLine -or $task.Actions[0].WorkingDirectory -ne $homeDir) {
        throw 'TASK_INSTALL_READBACK_MISMATCH'
    }
    Write-Output 'NATIVE_BRIDGE_INSTALLED_SOURCE_ONLY_NOT_FIRST_POLL'
    Write-Output ('LOCAL_WORKER_SHA256=' + $workerHash)
    Write-Output 'LOGON_TYPE=Interactive; RUNLEVEL=Limited; BOOT_BEFORE_LOGON=NOT_GUARANTEED'
    Write-Output 'NEXT: Run -Mode RunOnce for exact GitHub STARTED/FINISHED receipt readback'
    return
}
