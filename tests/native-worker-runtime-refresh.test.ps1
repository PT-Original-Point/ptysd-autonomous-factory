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
    'Get-TaskOptional','Get-WorkerRuntimeTaskReadback','Assert-WorkerRuntimeTrustedRuns')) {
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
    $global:MockWorkerTaskXml = @'
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled><ExecutionTimeLimit>PT15M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings><Triggers><TimeTrigger><StartBoundary>2026-10-27T00:00:00</StartBoundary><Repetition><Interval>PT5M</Interval><Duration>P3650D</Duration></Repetition></TimeTrigger></Triggers></Task>
'@
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

    $global:MockWorkerTask = [pscustomobject]@{
        TaskName=$taskName; TaskPath='\'; State='Disabled'
        Principal=[pscustomobject]@{ UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name;
            LogonType='Interactive'; RunLevel='Limited' }
        Settings=[pscustomobject]@{ Enabled=$false; MultipleInstances='IgnoreNew';
            ExecutionTimeLimit='PT15M'; StartWhenAvailable=$true }
        Actions=@([pscustomobject]@{ Execute=$wscript; Arguments='//B //NoLogo "' + $hiddenWorker + '"'; WorkingDirectory=$homeDir })
    }

    $enabledHash = Get-WorkerRuntimeTaskDefinitionSha256
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>')
    $disabledHash = Get-WorkerRuntimeTaskDefinitionSha256
    Assert-Equal $disabledHash $enabledHash 'task definition fingerprint excludes only temporary enabled state'
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('PT5M', 'PT10M')
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
        -ExpectedDefinitionSha256 $enabledHash } 'WORKER_RUNTIME_TASK_SCHEDULE_IDENTITY_MISMATCH' `
        'task cadence drift is blocked while refresh is disabled'
    $global:MockWorkerTaskXml = $global:MockWorkerTaskXml.Replace('PT10M', 'PT5M')

    $readback = Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' `
        -ExpectedDefinitionSha256 $enabledHash
    Assert-Equal $readback.DefinitionSha256 $enabledHash 'exact task identity reads back with disabled state'
    $global:MockWorkerTask.Principal.UserId = 'S-1-5-18'
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_MISMATCH' 'a task registered to a different Windows identity blocks refresh'
    $global:MockWorkerTask.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $global:MockWorkerTask.Actions[0].Arguments = 'unexpected action'
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_IDENTITY_MISMATCH' 'refresh refuses a changed scheduled action'

    $head = 'a' * 40
    $repo = 'PT-Original-Point/ptysd-autonomous-factory'
    $trustedRows = @(
        "csg-trusted-verifier-hosted`tV5.3-R4 CSG trusted verifier (GitHub-hosted)`t.github/workflows/csg-trusted-verifier-hosted.yml`tpull_request_target`tcompleted`tsuccess`t$head`t$repo`t381764260`t1`t100",
        "check-native-only`tV5.3 main source retirement integrity`t.github/workflows/v53-r4-main-source-retirement.yml`tpull_request`tcompleted`tsuccess`t$head`t$repo`t381351204`t1`t101",
        "v2-native-windows`tV53R4 OpenCode V2 CLI zero-token qualification`t.github/workflows/v53r4-v2-cli-qualification.yml`tpull_request`tcompleted`tsuccess`t$head`t$repo`t382735923`t1`t102"
    ) -join "`n"
    Assert-WorkerRuntimeTrustedRuns $trustedRows $head
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedRows.Replace($head, ('b' * 40))) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'successful workflows on a different head cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedRows.Replace("`tpull_request`tcompleted`t", "`tpull_request`tqueued`t")) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a queued workflow cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedRows.Replace($repo, 'untrusted/fork')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a same-named workflow from a different repository cannot authorize refresh'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedRows.Replace('381764260', '123')) $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'a different workflow identity cannot authorize refresh'
    $failedRetryRows = $trustedRows + "`n" +
        "v2-native-windows`tV53R4 OpenCode V2 CLI zero-token qualification`t.github/workflows/v53r4-v2-cli-qualification.yml`tpull_request`tcompleted`tfailure`t$head`t$repo`t382735923`t2`t103"
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns $failedRetryRows $head } `
        'WORKER_RUNTIME_CI_WORKFLOW_NOT_TRUSTED_SUCCESS' 'the latest failed workflow retry supersedes an older passing run'
    Assert-Throws { Assert-WorkerRuntimeTrustedRuns ($trustedRows -replace "`n.*$", '') $head } `
        'WORKER_RUNTIME_CI_CHECK_MISSING:v2-native-windows' 'missing Windows qualification blocks refresh'

    Write-Output 'NATIVE_WORKER_RUNTIME_REFRESH_HELPERS_PASS'
} finally {
    Remove-Item Function:\global:Export-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item Function:\global:Get-ScheduledTask -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $testRoot).Path)
        if (-not $resolvedTestRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'TEST_CLEANUP_PATH_OUTSIDE_TEMP'
        }
        [IO.Directory]::Delete($resolvedTestRoot, $true)
    }
    Remove-Variable MockWorkerTaskXml -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable MockWorkerTask -Scope Global -ErrorAction SilentlyContinue
}
