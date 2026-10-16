$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$repoRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $repoRoot 'native-bridge\install-codex-executor.ps1'
$modulePath = Join-Path $repoRoot 'native-bridge\codex-executor-install-state.psm1'

$parseTokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw ('POWERSHELL_PARSE_FAILED: ' + $installerPath + ': ' + $parseErrors[0].Message) }
if (Test-Path -LiteralPath $modulePath) { throw 'REDUNDANT_PRIVATE_INSTALL_STATE_MODULE_STILL_PRESENT' }

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase ('pty-codex-install-recovery-' + [guid]::NewGuid().ToString('N'))
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'TEST_PATH_OUTSIDE_TEMP' }
$local = Join-Path $testRoot 'local'
$public = Join-Path $testRoot 'public'
$programFiles = Join-Path $testRoot 'programfiles'
$global:MockRoot = $testRoot
$global:MockSpool = Join-Path $public 'Documents\PTYSDNativeBridge\CodexSpool'
$global:MockRuntime = Join-Path $public 'Documents\PTYSDNativeBridge\CodexRuntime'
$global:MockTaskRegistered = $false
$global:MockRegistration = $null
$global:MockFailurePoint = ''
$global:MockAclCalls = 0
$global:MockRuntimeCopyCalls = 0
$global:MockRegisterCalls = 0
$global:MockFailureInjected = $false

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw ('ASSERT_EQUAL_FAILED: ' + $Message + ';actual=' + $Actual + ';expected=' + $Expected) }
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
        return [pscustomobject]@{
            TaskName = $TaskName; State = 'Ready'
            Principal = [pscustomobject]@{ UserId = $reg.Principal.UserId; LogonType = $reg.Principal.LogonType; RunLevel = $reg.Principal.RunLevel }
            Settings = [pscustomobject]@{ MultipleInstances = $reg.Settings.MultipleInstances; ExecutionTimeLimit = $reg.Settings.ExecutionTimeLimit; Hidden = $hidden; AllowHardTerminate = $allowHardTerminate }
            Actions = @([pscustomobject]@{ Execute = $reg.Action.Execute; Arguments = $reg.Action.Arguments; WorkingDirectory = $reg.Action.WorkingDirectory })
            Triggers = @()
        }
    }
    return @()
}

function global:Get-LocalGroupMember {
    [CmdletBinding()]
    param([string]$Group)
    return @([pscustomobject]@{ SID = [pscustomobject]@{ Value = 'S-1-5-21-SYNTHETIC-NONADMIN' } })
}

function global:Get-AuthenticodeSignature {
    [CmdletBinding()]
    param([string]$FilePath)
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
    $global:MockRegistration = [pscustomobject]@{ Action = $Action; Settings = $Settings; Principal = $Principal }
    $global:MockTaskRegistered = $true
    if ($global:MockFailurePoint -eq 'AfterRegister') { throw 'INJECTED_REGISTER_AMBIGUOUS' }
}

function global:Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$TaskName, [string]$TaskPath)
    if ($TaskName -eq 'PTYSD-Codex-Executor') { $global:MockTaskRegistered = $false }
}

function Invoke-InstallAttempt([string]$ExpectedError = '') {
    $password = New-Object Security.SecureString
    foreach ($character in 'synthetic-only'.ToCharArray()) { $password.AppendChar($character) }
    $password.MakeReadOnly()
    $credential = [Management.Automation.PSCredential]::new('NT AUTHORITY\LOCAL SERVICE', $password)
    $failure = $null
    try {
        & $installerPath -Mode Install -ExecutorCredential $credential -NodeExecutable (Join-Path $programFiles 'Node\node.exe') `
            -CodexExecutable (Join-Path $programFiles 'Codex\codex.exe') 2>$null | Out-Null
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

try {
    New-Item -ItemType Directory -Path $local, $public, $programFiles -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $local 'PTYSDNativeBridge') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $programFiles 'Node'), (Join-Path $programFiles 'Codex') -Force | Out-Null
    $env:COMPUTERNAME = 'DESKTOP-1B6PD2P'
    $env:LOCALAPPDATA = $local
    $env:PUBLIC = $public
    $env:ProgramFiles = $programFiles
    $nodePath = Join-Path $programFiles 'Node\node.exe'
    $codexPath = Join-Path $programFiles 'Codex\codex.exe'
    [IO.File]::WriteAllText($nodePath, 'synthetic node executable')
    [IO.File]::WriteAllText($codexPath, 'synthetic signed Codex executable')
    $workerConfigPath = Join-Path $local 'PTYSDNativeBridge\config.json'
    $originalConfig = '{"existing":"preserve"}'
    [IO.File]::WriteAllText($workerConfigPath, $originalConfig)
    $env:LOCALAPPDATA = Join-Path $local 'PTYSDNativeBridge\..'
    $env:LOCALAPPDATA = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    $env:PUBLIC = $public
    $installerPath = Join-Path $repoRoot 'native-bridge\install-codex-executor.ps1'
    $global:MockFailurePoint = 'AfterAcl'
    $global:MockAclCalls = 0
    $null = Invoke-InstallAttempt 'INJECTED_AFTER_ACL'
    Assert-Equal $global:MockTaskRegistered $false 'task remains absent after ACL failure'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config unchanged after ACL failure'
    $statePath = Join-Path $local 'PTYSDNativeBridge\codex-executor-install-state.json'
    Assert-Equal (Test-Path -LiteralPath $statePath) $false 'no private install manifest is written after ACL failure'

    $global:MockFailurePoint = 'AfterCopy'
    $global:MockRuntimeCopyCalls = 0
    $global:MockFailureInjected = $false
    $null = Invoke-InstallAttempt 'INJECTED_AFTER_COPY'
    Assert-Equal $global:MockTaskRegistered $false 'task remains absent after copy failure'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config unchanged after copy failure'

    $global:MockFailurePoint = 'ReadbackMismatch'
    $global:MockFailureInjected = $false
    $null = Invoke-InstallAttempt 'EXECUTOR_TASK_READBACK_MISMATCH'
    Assert-Equal $global:MockTaskRegistered $false 'registered mock task rolled back after readback mismatch'
    Assert-Equal (Get-Content -LiteralPath $workerConfigPath -Raw) $originalConfig 'worker config restored after readback mismatch'
    Assert-Equal (Test-Path -LiteralPath $statePath) $false 'no private install manifest is written after readback rollback'

    $global:MockFailurePoint = ''
    $global:MockFailureInjected = $false
    Start-Sleep -Milliseconds 1100
    $null = Invoke-InstallAttempt
    Assert-Equal $global:MockTaskRegistered $true 'mock task registered after safe recovery'
    Assert-Equal (Test-Path -LiteralPath $statePath) $false 'successful install relies on exact file and task readback'
    $installedConfig = Get-Content -LiteralPath $workerConfigPath -Raw | ConvertFrom-Json
    Assert-Equal $installedConfig.enable_codex_model_runs $false 'model execution remains disabled'
    Assert-Equal $installedConfig.codex_usage_authorized $false 'usage authorization remains disabled'

    $successfulConfigBytes = Get-Content -LiteralPath $workerConfigPath -Raw
    & $installerPath -Mode Uninstall 2>$null | Out-Null
    Assert-Equal $global:MockTaskRegistered $false 'mock task removed while runtime artifacts remain hash-verifiable'
    Assert-Equal (Test-Path -LiteralPath $statePath) $false 'uninstall has no private install manifest dependency'
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
    Write-Output 'INSTALL_RECOVERY_SYNTHETIC_TESTS=PASS;RECOVERY=FILE_HASH_AND_TASK_XML_READBACK;TASK_SCHEDULER=MOCKED;MODEL_EXECUTION=NOT_RUN'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'REFUSE_TEMP_CLEANUP_OUTSIDE_TEMP' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
