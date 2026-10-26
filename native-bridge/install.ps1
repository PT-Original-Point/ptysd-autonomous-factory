# Windows PowerShell 5.1 native, least-privilege, version-neutral OpenCode ingress.
[CmdletBinding()]
param(
    [ValidateSet('Audit','Install','RunOnce','Uninstall')][string]$Mode = 'Audit',
    [ValidateRange(1,99999999)][int]$IssueNumber = 1,
    [string]$Workspace = '',
    [string]$TrustedDispatcher = 't14210184'
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

function Require-Command([string]$Name) {
    $entry = Get-Command $Name -ErrorAction Stop | Select-Object -First 1
    if (-not $entry.Source) { throw ('COMMAND_WITHOUT_SOURCE: ' + $Name) }
    return $entry.Source
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
    foreach ($bin in @('node.exe','gh.exe','opencode.exe','opencode.cmd')) {
        try { Write-Output ($bin + '=' + (Require-Command $bin)) }
        catch { Write-Output ($bin + '=UNAVAILABLE') }
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
    # The first queued job is native ping and does NOT launch OpenCode.
    # Desktop application is not a proof of a working CLI; npm may expose opencode.cmd.
    # Leave model work disabled until a separately verified CLI is available.
    $optionalCli = $null
    foreach ($candidate in @('opencode.exe', 'opencode.cmd', 'opencode')) {
        $candidateCommand = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $candidateCommand -and $candidateCommand.Source) {
            $optionalCli = $candidateCommand.Source
            break
        }
    }
    if ($null -eq $optionalCli) {
        Write-Output 'OPENCODE_CLI_NOT_FOUND_PING_ONLY'
    } else {
        Write-Output ('OPENCODE_CLI_FOUND=' + $optionalCli)
        Write-Output 'OPENCODE_PLAN_NOT_YET_LIVE_VERIFIED'
    }
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
        [IO.File]::WriteAllText($configPath, ($c | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
    } finally {
        if ($null -ne $configWriteLock) { $configWriteLock.Dispose() }
    }
    $argsLine = '//B //NoLogo "' + $hiddenWorker + '"'
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $argsLine -WorkingDirectory $homeDir
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -StartWhenAvailable
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
