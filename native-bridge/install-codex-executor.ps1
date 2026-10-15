# Source-only installer for the on-demand, separately identified Codex Executor.
# It never changes PTYSD-Native-OpenCode or HiddenWorker.vbs. Do not execute this
# installer before the R14 source and the Human identity/cost gates are accepted.
[CmdletBinding()]
param(
    [ValidateSet('Audit','Install','Uninstall')][string]$Mode = 'Audit',
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
$publisherSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$workerConfigPath = Join-Path $env:LOCALAPPDATA 'PTYSDNativeBridge\config.json'
$sharedBase = Join-Path $env:PUBLIC 'Documents\PTYSDNativeBridge'
$spoolDir = Join-Path $sharedBase 'CodexSpool'
$runtimeDir = Join-Path $sharedBase 'CodexRuntime'
$executorConfigPath = Join-Path $runtimeDir 'executor-config.json'
$executorScriptPath = Join-Path $runtimeDir 'codex-executor.mjs'
$continuationScriptPath = Join-Path $runtimeDir 'codex-continuation.mjs'
$launcherPath = Join-Path $runtimeDir 'HiddenCodexExecutor.vbs'
$backupPath = $null
$registeredHere = $false

function Get-TaskOptional([string]$Name) {
    $items = @(Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction SilentlyContinue)
    if ($items.Count -gt 1) { throw ('TASK_NAME_NOT_UNIQUE: ' + $Name) }
    if ($items.Count -eq 0) { return $null }
    return $items[0]
}

function Resolve-Sid([string]$Name) {
    try { return ([Security.Principal.NTAccount]$Name).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'EXECUTOR_ACCOUNT_SID_UNRESOLVED' }
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
}

if ($env:COMPUTERNAME.ToUpperInvariant() -ne $expectedHost) { throw 'WRONG_HOST_STOP' }
if ($Mode -eq 'Audit') {
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
    if ($null -ne (Get-TaskOptional $executorTaskName)) { throw 'EXECUTOR_TASK_REMOVE_READBACK_FAILED' }
    Write-Output 'CODEX_EXECUTOR_TASK_REMOVED;REQUESTS_AND_EVIDENCE_PRESERVED'
    return
}

if ($null -eq $ExecutorCredential) { throw 'SEPARATE_EXECUTOR_CREDENTIAL_REQUIRED' }
if (-not (Test-Path -LiteralPath $workerConfigPath -PathType Leaf)) { throw 'EXISTING_WORKER_CONFIG_REQUIRED' }
if ($null -ne (Get-TaskOptional $executorTaskName)) { throw 'EXECUTOR_TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE' }
if ((Test-Path -LiteralPath $spoolDir) -or (Test-Path -LiteralPath $runtimeDir)) {
    throw 'CODEX_EXECUTOR_PATH_ALREADY_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE'
}
$dispatcher = Get-TaskOptional $dispatcherTaskName
if ($null -eq $dispatcher -or @($dispatcher.Actions).Count -ne 1 -or
    $dispatcher.Actions[0].Arguments -notlike '*HiddenWorker.vbs*') {
    throw 'EXISTING_DISPATCHER_IDENTITY_MISMATCH'
}

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

foreach ($candidate in @($NodeExecutable, $CodexExecutable)) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'MACHINE_ACCESSIBLE_NODE_AND_CODEX_PATHS_REQUIRED'
    }
    $fullCandidate = [IO.Path]::GetFullPath($candidate)
    $programFilesRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    if (-not ($programFilesRoots | Where-Object {
        $fullCandidate.StartsWith([IO.Path]::GetFullPath($_) + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase) })) {
        throw 'EXECUTABLE_MUST_BE_MACHINE_ACCESSIBLE_NOT_PUBLISHER_APPDATA'
    }
}
$signature = Get-AuthenticodeSignature -FilePath $CodexExecutable
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI OpCo, LLC') {
    throw 'CODEX_EXECUTABLE_SIGNATURE_NOT_QUALIFIED'
}
$nodePath = [IO.Path]::GetFullPath($NodeExecutable)
$codexPath = [IO.Path]::GetFullPath($CodexExecutable)
$codexHash = (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash.ToLowerInvariant()

$spoolDirectories = @(
    $spoolDir,
    (Join-Path $spoolDir 'requests'),
    (Join-Path $spoolDir 'bundles'),
    (Join-Path $spoolDir 'claims'),
    (Join-Path $spoolDir 'results'),
    (Join-Path $spoolDir 'evidence'),
    (Join-Path $spoolDir 'workspaces'),
    (Join-Path $spoolDir 'locks')
)
New-Item -ItemType Directory -Force -Path $spoolDirectories, $runtimeDir | Out-Null
$readOnly = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$modify = [System.Security.AccessControl.FileSystemRights]::Modify
Set-RoleAcl $spoolDir $executorSid $readOnly
foreach ($name in @('requests','bundles')) {
    Set-RoleAcl (Join-Path $spoolDir $name) $executorSid $readOnly
}
foreach ($name in @('claims','results','evidence','workspaces','locks')) {
    Set-RoleAcl (Join-Path $spoolDir $name) $executorSid $modify
}
Set-RoleAcl $runtimeDir $executorSid $readOnly

foreach ($name in @('codex-executor.mjs','codex-continuation.mjs','HiddenCodexExecutor.vbs')) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('SOURCE_FILE_MISSING: ' + $name) }
    Copy-Item -LiteralPath $source -Destination (Join-Path $runtimeDir $name) -ErrorAction Stop
}

$executorConfig = [ordered]@{
    project_id=$project; repo=$repo; spool_dir=$spoolDir
    workspace_root=(Join-Path $spoolDir 'workspaces')
    codex_executable=$codexPath; codex_executable_sha256=$codexHash
    publisher_identity_sid=$publisherSid; executor_identity_sid=$executorSid
    codex_executor_task=$executorTaskName; codex_executor_task_verified=$true
    codex_executor_is_standard_user=$true
    github_transport_verified=$false; codex_cli_qualified=$false; codex_login_verified=$false
    enable_codex_model_runs=$false; codex_usage_authorized=$false
    codex_sandbox_boundary='UNKNOWN'; allowed_codex_models=@{}
}
$executorConfig | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $executorConfigPath -Encoding UTF8

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$actionArgs = ('//B //NoLogo "' + $launcherPath + '" "' + $nodePath + '" "' +
    $executorScriptPath + '" "' + $executorConfigPath + '"')
$action = New-ScheduledTaskAction -Execute $wscript -Argument $actionArgs -WorkingDirectory $spoolDir
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $executorName -LogonType Password -RunLevel Limited
$workerConfig = Get-Content -LiteralPath $workerConfigPath -Raw | ConvertFrom-Json
$backupPath = Join-Path (Split-Path -Parent $workerConfigPath) ('config.codex-before-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.json')
Copy-Item -LiteralPath $workerConfigPath -Destination $backupPath

try {
    Register-ScheduledTask -TaskName $executorTaskName -TaskPath '\' -Action $action -Settings $settings `
        -Principal $principal -User $executorName -Password $ExecutorCredential.GetNetworkCredential().Password `
        -ErrorAction Stop | Out-Null
    $registeredHere = $true
    $readback = Get-ScheduledTask -TaskName $executorTaskName -TaskPath '\' -ErrorAction Stop
    $timeLimit = [string]$readback.Settings.ExecutionTimeLimit
    $zeroLimit = ($readback.Settings.ExecutionTimeLimit -eq [TimeSpan]::Zero) -or
        ($timeLimit -eq 'PT0S') -or ($timeLimit -eq '00:00:00')
    if ($readback.Principal.UserId -ne $executorName -or $readback.Principal.LogonType -ne 'Password' -or
        $readback.Principal.RunLevel -ne 'Limited' -or $readback.Settings.MultipleInstances -ne 'IgnoreNew' -or
        -not $zeroLimit -or $readback.Settings.Hidden -ne $true -or
        @($readback.Triggers).Count -ne 0 -or @($readback.Actions).Count -ne 1 -or
        $readback.Actions[0].Execute -ne $wscript -or
        $readback.Actions[0].Arguments -ne $actionArgs -or
        $readback.Actions[0].WorkingDirectory -ne $spoolDir) {
        throw 'EXECUTOR_TASK_READBACK_MISMATCH'
    }
    foreach ($property in @{
        codex_spool=$spoolDir; publisher_identity_sid=$publisherSid; executor_identity_sid=$executorSid
        codex_executor_task=$executorTaskName; codex_executor_task_verified=$true
        codex_executor_is_standard_user=$true; github_transport_verified=$false
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
        $readWorkerConfig.enable_codex_model_runs -ne $false -or
        $readWorkerConfig.codex_usage_authorized -ne $false) { throw 'WORKER_CONFIG_READBACK_MISMATCH' }
    Write-Output 'CODEX_EXECUTOR_REGISTERED_ON_DEMAND_ONLY'
    Write-Output ('EXECUTOR_TASK=' + $executorTaskName + ';Logon=Password;RunLevel=Limited;Instances=IgnoreNew;ExecutionTimeLimit=PT0S')
    Write-Output ('EXISTING_DISPATCHER=' + $dispatcherTaskName + ';ACTION_UNCHANGED')
    Write-Output ('WORKER_CONFIG_BACKUP=' + $backupPath)
    Write-Output 'MODEL_EXECUTION=DISABLED;COST_AUTHORIZATION=FALSE;SANDBOX_BOUNDARY=UNKNOWN'
    Write-Output 'NEXT=Authenticate Codex only within the dedicated standard-user account; audit sandbox boundary before enabling any model run'
} catch {
    if ($registeredHere) {
        Unregister-ScheduledTask -TaskName $executorTaskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
    }
    Copy-Item -LiteralPath $backupPath -Destination $workerConfigPath -Force -ErrorAction SilentlyContinue
    throw
}
