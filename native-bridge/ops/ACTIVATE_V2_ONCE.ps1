# Single bounded OpenCode V2-only activation of the existing LIMITED Windows Task.
# NO installation of a new task, NO elevation, NO MCP, NO provider model calls.
[CmdletBinding()]
param([ValidateSet('Apply','SelfTest','Audit')][string]$Mode = 'Apply')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = 'PT-Original-Point/ptysd-autonomous-factory'
$expectedHead = '13dcf293b0717cf41ef9d35acfa0b7b464417b9a'
$expectedBlob = 'f36a16bc0e35ab58777f2a34f9616889898b8ff3'
$oldHash = '5b8b7e1194599bfe447753cfcafe22c7d45589c50e388d38e2af3c055bb30815'
$newHash = '936ba5e657984aa85ec308a75dbe66cc84d445f8918e77199ef3123ae0e9373c'
$taskName = 'PTYSD-Native-OpenCode'
$hostName = 'DESKTOP-1B6PD2P'
$stateDir = Join-Path $env:LOCALAPPDATA 'PTYSDNativeBridge'
$worker = Join-Path $stateDir 'worker.mjs'
$configPath = Join-Path $stateDir 'config.json'
$tmp = Join-Path $stateDir 'worker.pending.v2.mjs'
$backup = Join-Path $stateDir 'worker.mjs.previous-sha-5b8b7e11'

$modulePath = Join-Path $stateDir 'opencode-v2.mjs'
$modulePending = Join-Path $stateDir 'opencode-v2.pending.mjs'
$expectedModuleBlob = '23f37454072548e2bae14a3bc382b280b37d355c'
$moduleHash = '98c31ed400c3d5da75d67e0be2849cd9b620c53fd7853ffe99c6058dff314f68'
$cliVersion = '2.0.27'
$cliPrefix = Join-Path $stateDir 'official-cli-v2'
$cliName = '@opencode/cli'
$cliTarget = Join-Path $env:USERPROFILE '.opencode\bin\opencode2.exe'
$smokeId = 'PTYSD_NATIVE_V2_SMOKE_20261013'

function FileHash([string]$p) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw ('MISSING_FILE: ' + $p) }
    return (Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function NativeText([string[]]$cliArgs) {
    # PowerShell's ErrorActionPreference=Stop can turn expected native stderr into
    # terminating NativeCommandError. Capture stdout/stderr separately without hiding failure.
    $pref = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdout = & gh.exe @cliArgs 2>$null
        $ec = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $pref
    }
    if ($ec -ne 0) { throw ('GITHUB_API_EXIT_' + $ec) }
    return [string]::Join("`n", @($stdout))
}
function Resolve-TaskPrincipalSid([string]$UserId) {
    if ([string]::IsNullOrWhiteSpace($UserId)) { throw 'TASK_OWNER_ID_EMPTY_NO_UPDATE' }
    $raw = $UserId.Trim()
    # SecurityIdentifier validates actual SID syntax; a textual match alone is not enough.
    if ($raw -match '^S-\d+(?:-\d+){2,}$') {
        try { return ([System.Security.Principal.SecurityIdentifier]::new($raw)).Value }
        catch { throw 'TASK_OWNER_SID_INVALID_NO_UPDATE' }
    }
    if ($raw -match '^S-') { throw 'TASK_OWNER_SID_MALFORMED_NO_UPDATE' }
    if ($raw -notmatch '[\\@]') {
        # A bare name is only admissible for the current explicitly bound local user.
        if (-not [string]::Equals($raw, $env:USERNAME, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'TASK_OWNER_BARE_NAME_NOT_CURRENT_USER_NO_UPDATE'
        }
        $raw = $env:COMPUTERNAME + '\' + $raw
    }
    try {
        $account = [System.Security.Principal.NTAccount]::new($raw)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch { throw 'TASK_OWNER_ACCOUNT_UNRESOLVABLE_NO_UPDATE' }
}

function TryOpenCodeV2Version([string]$candidate) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    $p = $null
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $candidate
        $psi.Arguments = '--version'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [Diagnostics.Process]::Start($psi)
        if ($null -eq $p) { return $null }
        if (-not $p.WaitForExit(6000)) {
            try { $p.Kill(); $p.WaitForExit() } catch {}
            return $null
        }
        if ($p.ExitCode -ne 0) { return $null }
        $output = $p.StandardOutput.ReadToEnd().Trim()
        if ($output -match '^(?:opencode(?:2)?\s+)?v?(2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$') {
            return [string]$Matches[1]
        }
    } catch { return $null }
    finally { if ($null -ne $p) { $p.Dispose() } }
    return $null
}
function FindAlreadyInstalledV2 {
    $candidates = @($cliTarget, (Join-Path $env:USERPROFILE '.opencode\bin\opencode.exe'))
    foreach ($name in @('opencode2.exe','opencode.exe')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source)) {
            $candidates += [string]$cmd.Source
        }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        $version = TryOpenCodeV2Version $candidate
        if ($null -ne $version -and $version -eq $cliVersion) {
            Write-Host ('V2_EXISTING_EXECUTABLE_VERIFIED_VERSION=' + $version)
            # Our worker discovers ~/.opencode/bin without modifying Task Scheduler.
            if ([string]::Equals($candidate, $cliTarget, [StringComparison]::OrdinalIgnoreCase) -or
                [string]::Equals($candidate, (Join-Path $env:USERPROFILE '.opencode\bin\opencode.exe'), [StringComparison]::OrdinalIgnoreCase)) {
                return $candidate
            }
            $destDir = Split-Path -Parent $cliTarget
            if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
                New-Item -Path $destDir -ItemType Directory -Force -ErrorAction Stop | Out-Null
            }
            if (Test-Path -LiteralPath $cliTarget -PathType Leaf) { throw 'V2_TARGET_EXISTS_UNKNOWN_NO_COPY' }
            Copy-Item -LiteralPath $candidate -Destination $cliTarget -ErrorAction Stop
            if ((FileHash $candidate) -ne (FileHash $cliTarget)) { throw 'V2_COPY_HASH_MISMATCH' }
            if (-not (TryOpenCodeV2Version $cliTarget)) { throw 'V2_COPIED_BIN_NOT_RUNNABLE' }
            return $cliTarget
        }
    }
    return $null
}
function InstallOfficialV2IfMissing {
    $known = FindAlreadyInstalledV2
    if ($known) { return $known }
    if (Test-Path -LiteralPath $cliTarget -PathType Leaf) {
        throw 'EXISTING_V2_EXE_NOT_2X_DO_NOT_OVERWRITE'
    }
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    if (-not $npm) { throw 'OFFICIAL_NPM_COMMAND_NOT_FOUND' }
    Write-Host ('INSTALL_OFFICIAL_V2_USER_SCOPE_VERSION=' + $cliVersion)
    # Official V2 npm package. No V1 opencode-ai, no global installation or UAC.
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $npm install --prefix $cliPrefix --no-audit --no-fund --save-exact ($cliName + '@' + $cliVersion)
        $installExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($installExit -ne 0) { throw ('OFFICIAL_V2_NPM_INSTALL_EXIT_' + $installExit) }
    $manifest = Join-Path $cliPrefix 'node_modules\@opencode\cli\package.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'OFFICIAL_V2_PACKAGE_MANIFEST_MISSING' }
    $pkg = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -ErrorAction Stop
    if ([string]$pkg.name -ne $cliName -or [string]$pkg.version -ne $cliVersion) {
        throw 'OFFICIAL_V2_PACKAGE_VERSION_MISMATCH'
    }
    # Official V2 postinstall selects the Windows-native binary into this exact path.
    # The optional platform package may retain a second original binary; a recursive
    # scan therefore produces false duplicate failures. Never select an arbitrary exe.
    $source = Join-Path $cliPrefix 'node_modules\@opencode\cli\bin\opencode.exe'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'OFFICIAL_V2_POSTINSTALL_BIN_NOT_FOUND' }
    if ((TryOpenCodeV2Version $source) -ne $cliVersion) { throw 'OFFICIAL_V2_BIN_NOT_PINNED_VERSION' }
    $destDir = Split-Path -Parent $cliTarget
    New-Item -Path $destDir -ItemType Directory -Force -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $source -Destination $cliTarget -ErrorAction Stop
    if ((FileHash $source) -ne (FileHash $cliTarget)) { throw 'OFFICIAL_V2_BIN_HASH_CHANGED_ON_COPY' }
    if ((TryOpenCodeV2Version $cliTarget) -ne $cliVersion) { throw 'OFFICIAL_V2_BIN_VERSION_READBACK_FAILED' }
    Write-Host ('OFFICIAL_V2_NATIVE_INSTALLED=' + $cliVersion)
    return $cliTarget
}
function ReadPinnedGithubFile([string]$path,[string]$expectedBlob,[string]$expectedDigest,[int]$min,[int]$max,[string]$destination) {
    $raw = NativeText @('api', ("repos/$repo/contents/" + $path + '?ref=' + $expectedHead))
    $o = $raw | ConvertFrom-Json -ErrorAction Stop
    if ([string]$o.sha -ne $expectedBlob -or [string]$o.encoding -ne 'base64') {
        throw ('SOURCE_GIT_BLOB_MISMATCH_' + $path)
    }
    $bytes = [Convert]::FromBase64String(([regex]::Replace([string]$o.content, '\s', '')))
    if ($bytes.Length -lt $min -or $bytes.Length -gt $max) { throw ('SOURCE_SIZE_MISMATCH_' + $path) }
    $shaTool = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($shaTool.ComputeHash($bytes)) -replace '-','').ToLowerInvariant() }
    finally { $shaTool.Dispose() }
    if ($digest -ne $expectedDigest) { throw ('SOURCE_SHA256_MISMATCH_' + $path) }
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        [IO.File]::WriteAllBytes($destination, $bytes)
    }
    if ((FileHash $destination) -ne $expectedDigest) { throw 'EXISTING_PINNED_STAGE_DRIFT' }
    return $destination
}
function PostExactlyOnceV2Canary {
    $comments = NativeText @('api', "repos/$repo/issues/407/comments?per_page=100") | ConvertFrom-Json -ErrorAction Stop
    foreach ($comment in @($comments)) {
        if (([string]$comment.body).Contains('"request_id":"' + $smokeId + '"')) {
            Write-Output 'V2_PREFLIGHT_JOB_ALREADY_EXISTS_NO_DUPLICATE'
            return
        }
    }
    $job = [ordered]@{schema=1;project_id='CHATGPT_GLOBAL_SKILL_GOVERNANCE';host=$hostName
                      request_id=$smokeId;kind='native_preflight';source_sha=$expectedHead
                      spec_path=$null;spec_sha256=$null}
    $body = "PTYSD_NATIVE_JOB_V1`n" + ($job | ConvertTo-Json -Depth 3 -Compress)
    $file = Join-Path $stateDir ('v2-canary-' + [guid]::NewGuid().ToString('N') + '.txt')
    [IO.File]::WriteAllText($file,$body,(New-Object System.Text.UTF8Encoding($false)))
    try { $null = NativeText @('issue','comment','407','-R',$repo,'--body-file',$file) }
    finally { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
    $after = NativeText @('api', "repos/$repo/issues/407/comments?per_page=100") | ConvertFrom-Json -ErrorAction Stop
    $found = @($after | Where-Object { [string]$_.body -ceq $body })
    if ($found.Count -ne 1) { throw 'POST_CANARY_EFFECT_AMBIGUOUS_DO_NOT_RESEND' }
    Write-Output 'OFFICIAL_V2_PREFLIGHT_JOB_QUEUED_EXACT_READBACK'
}

function ReadExactTask {
    $t = @(Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
    if ($t.Count -ne 1) { throw ('TASK_EXACT_IDENTITY_COUNT=' + $t.Count) }
    $o = $t[0]
    if (@($o.Actions).Count -ne 1) { throw 'TASK_UNEXPECTED_ACTION_COUNT' }
    $a = $o.Actions[0]
    if ($null -eq $a.PSObject.Properties['Execute'] -or $null -eq $a.PSObject.Properties['Arguments']) {
        throw 'TASK_ACTION_TYPE_NOT_EXEC'
    }
    $argsText = [string]$a.Arguments
    if ($argsText.IndexOf($worker, [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $argsText.IndexOf($configPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'TASK_ACTION_NOT_BOUND_TO_APPROVED_WORKER'
    }
    # A Windows Scheduled Task Principal.UserId can be an SID, DOMAIN\user,
    # or a bare local account name. Compare the underlying SID, never a suffix.
    $taskSid = Resolve-TaskPrincipalSid -UserId ([string]$o.Principal.UserId)
    $currentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    if (-not [string]::Equals($taskSid, $currentSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'TASK_OWNER_SID_MISMATCH_NO_UPDATE'
    }
    if ([string]$o.Principal.LogonType -ne 'Interactive') { throw 'TASK_LOGON_TYPE_CHANGED' }
    if ([string]$o.Principal.RunLevel -notin @('Limited','LeastPrivilege')) { throw 'TASK_RUNLEVEL_UNEXPECTED' }
    return $o
}
function TestProtected {
    $t = ReadExactTask
    $conf = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($conf.project_id -ne 'CHATGPT_GLOBAL_SKILL_GOVERNANCE' -or
        $conf.repo -ne $repo -or $conf.host -ne $hostName -or [int]$conf.issue -ne 407) {
        throw 'CONFIG_IDENTITY_MISMATCH'
    }
    return $t
}
function ReadExactTaskInstances {
    # An exact same-user LIMITED scheduled task is visible to its owner via COM.
    # No whole-host node.exe process scan; unrelated users' Node processes are irrelevant.
    $service = New-Object -ComObject 'Schedule.Service' -ErrorAction Stop
    $service.Connect()
    $registered = $service.GetFolder('\').GetTask($taskName)
    if ([string]$registered.Name -ne $taskName -or
        [string]$registered.Path -ne ('\' + $taskName)) { throw 'COM_TASK_IDENTITY_CHANGED' }
    $active = $registered.GetInstances(0)
    if ($null -eq $active -or $null -eq $active.Count -or
        [string]$active.Count -notmatch '^\d+$') { throw 'EXACT_TASK_INSTANCES_UNREADABLE' }
    return [int]$active.Count
}
function WaitExactTaskIdle {
    $until = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if ((ReadExactTaskInstances) -eq 0) {
            Start-Sleep -Milliseconds 600
            if ((ReadExactTaskInstances) -eq 0) { return }
        }
        Start-Sleep -Milliseconds 900
    } while ([DateTime]::UtcNow -lt $until)
    throw 'EXACT_TASK_ACTIVE_NO_UPDATE'
}
function SelfTest {
    # All tests are local. No GitHub access or scheduled-task mutation.
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('ptysd-update-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -Path $scratch -ItemType Directory -ErrorAction Stop | Out-Null
    try {
        $a = Join-Path $scratch 'old.txt'
        $b = Join-Path $scratch 'next.txt'
        $c = Join-Path $scratch 'backup.txt'
        [IO.File]::WriteAllText($a,'old')
        [IO.File]::WriteAllText($b,'new')
        [IO.File]::Replace($b,$a,$c,$false)
        if ([IO.File]::ReadAllText($a) -ne 'new' -or
            [IO.File]::ReadAllText($c) -ne 'old') { throw 'SELFTEST_ATOMIC_SWAP_FAILED' }
        Copy-Item -LiteralPath $c -Destination $a -Force -ErrorAction Stop
        if ([IO.File]::ReadAllText($a) -ne 'old') { throw 'SELFTEST_ROLLBACK_FAILED' }
    } finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Stop }
    Write-Output 'SELFTEST_ATOMIC_SWAP_AND_ROLLBACK_PASS'
}
if ($Mode -eq 'SelfTest') { SelfTest; return }
if ($env:COMPUTERNAME.ToUpperInvariant() -ne $hostName) { throw 'WRONG_HOST' }
if ($env:USERNAME -ne 'x') { throw 'WRONG_WINDOWS_USER' }
$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_RUN_NOT_NEEDED_USE_LIMITED_USER' }
if ((Get-Command gh.exe -ErrorAction Stop).Source -eq $null) { throw 'GH_MISSING' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $node) { throw 'NODE_MISSING' }
if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) { throw 'BRIDGE_NOT_INSTALLED' }
if (Test-Path -LiteralPath $tmp) {
    # The previous abort happened AFTER staging but BEFORE replacement.
    # Reuse only the exact already-reviewed target bytes.
    if ((FileHash $tmp) -ne $newHash) { throw 'UNKNOWN_STAGED_WORKER_HASH_NO_UPDATE' }
    Write-Output 'RECOVER_KNOWN_EXACT_STAGED_WORKER'
}
$currentHash = FileHash $worker
if ($Mode -eq 'Audit') {
    $null = TestProtected
    Write-Output ('WORKER_SHA256=' + $currentHash)
    Write-Output ('V2_MODULE_PRESENT=' + (Test-Path -LiteralPath $modulePath -PathType Leaf))
    Write-Output ('OFFICIAL_V2_PINNED_VERSION=' + $cliVersion)
    Write-Output ('EXACT_TASK_RUNNING_INSTANCES=' + (ReadExactTaskInstances))
    Write-Output 'AUDIT_READ_ONLY'
    return
}
if ($currentHash -eq $newHash) {
    if ((FileHash $modulePath) -ne $moduleHash) { throw 'ALREADY_UPDATED_BUT_V2_MODULE_MISSING' }
    Write-Output 'ALREADY_UPDATED_WORKER_SHA_MATCH'
    $t = TestProtected
    if ([string]$t.State -eq 'Disabled') {
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            throw 'TARGET_PRESENT_DISABLED_NO_RESTORE_EVIDENCE'
        }
        if ((FileHash $backup) -ne $oldHash) { throw 'RECOVERY_BACKUP_HASH_MISMATCH' }
        WaitExactTaskIdle
        Enable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
    }
    $t = TestProtected
    if ([string]$t.State -eq 'Disabled') { throw 'TARGET_TASK_STILL_DISABLED' }
    Write-Output 'ALREADY_UPDATED_WORKER_SHA_MATCH_TASK_READY'
    if ((TryOpenCodeV2Version $cliTarget) -ne $cliVersion -and
        (TryOpenCodeV2Version (Join-Path $env:USERPROFILE '.opencode\bin\opencode.exe')) -ne $cliVersion) {
        throw 'ALREADY_UPDATED_BUT_OFFICIAL_V2_BINARY_UNQUALIFIED'
    }
    PostExactlyOnceV2Canary
    try { Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop }
    catch { Write-Warning 'TRIGGER_FAILED_TIMER_STILL_ENABLED' }
    return
}
if ($currentHash -ne $oldHash) { throw ('UNKNOWN_EXISTING_WORKER_SHA_' + $currentHash) }
$task = TestProtected
if ([string]$task.State -eq 'Running') {
    WaitExactTaskIdle
    $task = TestProtected
    if ([string]$task.State -eq 'Running') { throw 'TASK_RUNNING_AFTER_WAIT' }
}
if ([string]$task.State -eq 'Disabled') { throw 'TASK_WAS_DISABLED_REVIEW_PRESTATE' }

$headObj = NativeText @('api', "repos/$repo/git/ref/heads/main") | ConvertFrom-Json -ErrorAction Stop
if ([string]$headObj.object.sha -ne $expectedHead) { throw 'MAIN_SHA_CHANGED_NO_INSTALL' }
$null = ReadPinnedGithubFile 'native-bridge/opencode-v2.mjs' $expectedModuleBlob $moduleHash 3000 9000 $modulePending
$null = ReadPinnedGithubFile 'native-bridge/worker.mjs' $expectedBlob $newHash 12000 65536 $tmp
& $node --check $modulePending
if ($LASTEXITCODE -ne 0) { throw 'V2_MODULE_SYNTAX_INVALID_NO_MUTATION' }
& $node --check $tmp
if ($LASTEXITCODE -ne 0) { throw 'WORKER_SYNTAX_INVALID_NO_MUTATION' }
$null = InstallOfficialV2IfMissing
if (Test-Path -LiteralPath $modulePath -PathType Leaf) {
    if ((FileHash $modulePath) -ne $moduleHash) { throw 'EXISTING_V2_MODULE_HASH_UNREVIEWED' }
}

$disabled = $false
$verifiedNew = $false
$canEnable = $false
try {
    Disable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
    $disabled = $true
    $read = ReadExactTask
    if ([string]$read.State -ne 'Disabled') { throw 'TASK_DISABLE_READBACK_FAILED' }
    # Check the exact registered task's running instances; no all-node scans.
    WaitExactTaskIdle
    if (Test-Path -LiteralPath $backup) { throw 'EXISTING_BACKUP_REQUIRES_REVIEW' }
    # Install V2 helper first while old worker still uses no helper; exact readback.
    if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) {
        Copy-Item -LiteralPath $modulePending -Destination $modulePath -ErrorAction Stop
    }
    if ((FileHash $modulePath) -ne $moduleHash) { throw 'INSTALLED_V2_MODULE_HASH_MISMATCH' }
    # NTFS atomic same-directory replacement produces an exact old-worker backup.
    [IO.File]::Replace($tmp,$worker,$backup,$false)
    if ((FileHash $backup) -ne $oldHash) { throw 'BACKUP_HASH_MISMATCH' }
    if ((FileHash $worker) -ne $newHash) { throw 'UPDATED_WORKER_HASH_MISMATCH' }
    & $node --check $worker
    if ($LASTEXITCODE -ne 0) { throw 'UPDATED_WORKER_SYNTAX_INVALID' }
    if ((FileHash $modulePath) -ne $moduleHash) { throw 'V2_MODULE_READBACK_DRIFT' }
    $verifiedNew = $true
    $canEnable = $true
} catch {
    $errorText = $_.Exception.Message
    # Recover safely from any failed move/copy, including an interrupted replacement.
    if (-not $verifiedNew) {
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            if ((FileHash $backup) -eq $oldHash) {
                # Restore the exact backup even if the destination went missing.
                Copy-Item -LiteralPath $backup -Destination $worker -Force -ErrorAction Stop
            }
        }
        if (Test-Path -LiteralPath $worker -PathType Leaf) {
            $canEnable = ((FileHash $worker) -eq $oldHash)
        }
    }
    throw ('BRIDGE_UPDATE_ABORTED_' + $errorText)
} finally {
    if ($disabled -and $canEnable) {
        Enable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
    } elseif ($disabled) {
        Write-Warning 'TASK_LEFT_DISABLED_AMBIGUOUS_WORKER_REQUIRES_READBACK'
    }
}
$taskAfter = TestProtected
if ([string]$taskAfter.State -eq 'Disabled') { throw 'TASK_REENABLE_FAILED' }
if ((FileHash $worker) -ne $newHash) { throw 'FINAL_WORKER_SHA_CHANGED' }
# Trigger through the existing single-instance Task Scheduler rather than running
# a separate Node process concurrently with that task.
Write-Output ('WORKER_UPDATED_SHA256=' + (FileHash $worker))
Write-Output 'TASK_REENABLED_EXACT_SOURCE_VERIFIED'
Write-Output ('OPENCODE_V2_MODULE_SHA256=' + (FileHash $modulePath))
PostExactlyOnceV2Canary
try {
    Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    Write-Output 'STAGE=EXISTING_LIMITED_NATIVE_TASK_TRIGGERED'
} catch {
    Write-Warning 'EXACT_TASK_TRIGGER_UNAVAILABLE_TIMER_STILL_ENABLED'
}
Write-Output 'LIVE_RECEIPTS_PENDING_CHECK_GITHUB_ISSUE_407'
