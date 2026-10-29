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
    'Get-TaskOptional','Get-WorkerRuntimeTaskReadback','Invoke-WorkerRuntimeCommandText',
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
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled><ExecutionTimeLimit>PT15M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable></Settings><Triggers><TimeTrigger><StartBoundary>2026-10-27T00:00:00</StartBoundary><Repetition><Interval>PT5M</Interval><Duration>P3650D</Duration></Repetition></TimeTrigger></Triggers></Task>
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
            ExecutionTimeLimit='PT15M'; StartWhenAvailable=$true;
            DisallowStartIfOnBatteries=$false; StopIfGoingOnBatteries=$false }
        Actions=@([pscustomobject]@{ Execute=$wscript; Arguments='//B //NoLogo "' + $hiddenWorker + '"'; WorkingDirectory=$homeDir })
    }

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
    $global:MockWorkerTask.Principal.UserId = 'S-1-5-18'
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_PRINCIPAL_IDENTITY_MISMATCH' 'a task registered to a different Windows identity blocks refresh'
    $global:MockWorkerTask.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $global:MockWorkerTask.Actions[0].Arguments = 'unexpected action'
    Assert-Throws { Get-WorkerRuntimeTaskReadback -ExpectedEnabled $false -ExpectedState 'Disabled' } `
        'WORKER_RUNTIME_TASK_IDENTITY_MISMATCH' 'refresh refuses a changed scheduled action'

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
}
