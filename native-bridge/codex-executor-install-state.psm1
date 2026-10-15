Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SpoolDirectories = @('', 'requests', 'bundles', 'claims', 'results', 'evidence', 'workspaces', 'locks')
$script:RuntimeFiles = @('HiddenCodexExecutor.vbs', 'codex-continuation.mjs', 'codex-executor.mjs', 'executor-config.json')

function Get-CodexInstallPropertyNames($Value) {
    if ($Value -is [System.Collections.IDictionary]) {
        return @($Value.Keys | ForEach-Object { [string]$_ })
    }
    return @($Value.PSObject.Properties | ForEach-Object { $_.Name })
}

function New-CodexExecutorInstallManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$HostName,
        [Parameter(Mandatory)][string]$PublisherSid,
        [Parameter(Mandatory)][string]$ExecutorSid,
        [Parameter(Mandatory)][string]$SpoolDir,
        [Parameter(Mandatory)][string]$RuntimeDir,
        [Parameter(Mandatory)][System.Collections.IDictionary]$RuntimeFileHashes
    )
    $names = @($RuntimeFileHashes.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    $expected = @($script:RuntimeFiles | Sort-Object -CaseSensitive)
    if (($names -join '|') -cne ($expected -join '|')) { throw 'INSTALL_STATE_RUNTIME_FILE_SET_INVALID' }
    $files = [ordered]@{}
    foreach ($name in $script:RuntimeFiles) {
        $hash = [string]$RuntimeFileHashes[$name]
        if ($hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'INSTALL_STATE_RUNTIME_HASH_INVALID' }
        $files[$name] = $hash.ToLowerInvariant()
    }
    if (-not $HostName -or -not $PublisherSid -or -not $ExecutorSid -or $PublisherSid -eq $ExecutorSid) {
        throw 'INSTALL_STATE_IDENTITY_INVALID'
    }
    return [ordered]@{
        schema = 1
        host = $HostName.ToUpperInvariant()
        publisher_sid = $PublisherSid
        executor_sid = $ExecutorSid
        spool_dir = [IO.Path]::GetFullPath($SpoolDir)
        runtime_dir = [IO.Path]::GetFullPath($RuntimeDir)
        spool_directories = @($script:SpoolDirectories)
        runtime_files = $files
    }
}

function ConvertTo-CodexExecutorInstallManifestJson($Manifest) {
    $required = @('schema','host','publisher_sid','executor_sid','spool_dir','runtime_dir','spool_directories','runtime_files')
    $actual = @(Get-CodexInstallPropertyNames $Manifest | Sort-Object -CaseSensitive)
    if (($actual -join '|') -cne (@($required | Sort-Object -CaseSensitive) -join '|')) {
        throw 'INSTALL_STATE_SCHEMA_INVALID'
    }
    $fileNames = @(Get-CodexInstallPropertyNames $Manifest.runtime_files | Sort-Object -CaseSensitive)
    $expectedFiles = @($script:RuntimeFiles | Sort-Object -CaseSensitive)
    if (($fileNames -join '|') -cne ($expectedFiles -join '|')) { throw 'INSTALL_STATE_RUNTIME_FILE_SET_INVALID' }
    $files = [ordered]@{}
    foreach ($name in $script:RuntimeFiles) {
        $hash = [string]$Manifest.runtime_files.$name
        if ($hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'INSTALL_STATE_RUNTIME_HASH_INVALID' }
        $files[$name] = $hash.ToLowerInvariant()
    }
    $dirs = @($Manifest.spool_directories | ForEach-Object { [string]$_ })
    if (($dirs -join '|') -cne ($script:SpoolDirectories -join '|')) { throw 'INSTALL_STATE_DIRECTORY_PLAN_INVALID' }
    if ([int]$Manifest.schema -ne 1 -or -not $Manifest.host -or -not $Manifest.publisher_sid -or
        -not $Manifest.executor_sid -or $Manifest.publisher_sid -eq $Manifest.executor_sid) {
        throw 'INSTALL_STATE_IDENTITY_INVALID'
    }
    return ConvertTo-Json -InputObject ([ordered]@{
        schema = 1
        host = ([string]$Manifest.host).ToUpperInvariant()
        publisher_sid = [string]$Manifest.publisher_sid
        executor_sid = [string]$Manifest.executor_sid
        spool_dir = [IO.Path]::GetFullPath([string]$Manifest.spool_dir)
        runtime_dir = [IO.Path]::GetFullPath([string]$Manifest.runtime_dir)
        spool_directories = @($script:SpoolDirectories)
        runtime_files = $files
    }) -Depth 6 -Compress
}

function Get-CodexExecutorInstallDirectoryPlan($Manifest) {
    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($relative in $Manifest.spool_directories) {
        $path = if ($relative) { Join-Path $Manifest.spool_dir $relative } else { $Manifest.spool_dir }
        $kind = if (-not $relative) { 'spool-root' } elseif ($relative -in @('requests','bundles')) { 'spool-readonly' } else { 'spool-modify' }
        $entries.Add([pscustomobject]@{ Path = $path; Kind = $kind })
    }
    $entries.Add([pscustomobject]@{ Path = $Manifest.runtime_dir; Kind = 'runtime-readonly' })
    return $entries.ToArray()
}

function Assert-CodexExecutorInstallPathChain([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'INSTALL_STATE_REPARSE_POINT_REVIEW_REQUIRED'
            }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-CodexExecutorTreeSnapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) {
        return [pscustomobject]@{ Exists = $false; Directories = @(); Files = @() }
    }
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (-not $rootItem.PSIsContainer) { throw 'INSTALL_STATE_TARGET_NOT_DIRECTORY' }
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'INSTALL_STATE_REPARSE_POINT_REVIEW_REQUIRED' }
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
                throw 'INSTALL_STATE_REPARSE_POINT_REVIEW_REQUIRED'
            }
            $relative = $item.FullName.Substring($fullRoot.Length)
            if ($relative.StartsWith([IO.Path]::DirectorySeparatorChar)) { $relative = $relative.Substring(1) }
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
    param([Parameter(Mandatory)]$Manifest, [switch]$RequireComplete)
    $spool = Get-CodexExecutorTreeSnapshot $Manifest.spool_dir
    $runtime = Get-CodexExecutorTreeSnapshot $Manifest.runtime_dir
    $allowedSpool = @($Manifest.spool_directories | Where-Object { $_ })
    foreach ($relative in $spool.Directories) {
        if (-not (@($allowedSpool | Where-Object { $_ -ieq $relative }).Count)) {
            throw 'INSTALL_STATE_UNEXPECTED_SPOOL_DIRECTORY_REVIEW_REQUIRED'
        }
    }
    if ($spool.Files.Count -gt 0) { throw 'INSTALL_STATE_SPOOL_DATA_REVIEW_REQUIRED' }
    if ($runtime.Directories.Count -gt 0) { throw 'INSTALL_STATE_UNEXPECTED_RUNTIME_DIRECTORY_REVIEW_REQUIRED' }
    foreach ($relative in $runtime.Files) {
        $name = @($script:RuntimeFiles | Where-Object { $_ -ieq $relative }) | Select-Object -First 1
        if (-not $name) { throw 'INSTALL_STATE_UNEXPECTED_RUNTIME_FILE_REVIEW_REQUIRED' }
        $actualHash = (Get-FileHash -LiteralPath (Join-Path $Manifest.runtime_dir $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne [string]$Manifest.runtime_files.$name) { throw 'INSTALL_STATE_RUNTIME_HASH_MISMATCH_REVIEW_REQUIRED' }
    }
    if ($RequireComplete) {
        foreach ($relative in $Manifest.spool_directories) {
            $path = if ($relative) { Join-Path $Manifest.spool_dir $relative } else { $Manifest.spool_dir }
            if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'INSTALL_STATE_REQUIRED_DIRECTORY_MISSING' }
        }
        if (-not $runtime.Exists -or $runtime.Files.Count -ne $script:RuntimeFiles.Count) {
            throw 'INSTALL_STATE_RUNTIME_FILES_INCOMPLETE'
        }
        foreach ($name in $script:RuntimeFiles) {
            if (-not (@($runtime.Files | Where-Object { $_ -ieq $name }).Count)) { throw 'INSTALL_STATE_RUNTIME_FILES_INCOMPLETE' }
        }
    }
}

function Initialize-CodexExecutorInstallState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ManifestPath, [Parameter(Mandatory)]$Manifest)
    $expectedJson = ConvertTo-CodexExecutorInstallManifestJson $Manifest
    Assert-CodexExecutorInstallPathChain $ManifestPath
    Assert-CodexExecutorInstallPathChain $Manifest.spool_dir
    Assert-CodexExecutorInstallPathChain $Manifest.runtime_dir
    if (Test-Path -LiteralPath $ManifestPath) {
        $item = Get-Item -LiteralPath $ManifestPath -Force
        if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'INSTALL_STATE_MARKER_REVIEW_REQUIRED'
        }
        try {
            $actual = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $actualJson = ConvertTo-CodexExecutorInstallManifestJson $actual
        } catch { throw 'INSTALL_STATE_MARKER_INVALID_REVIEW_REQUIRED' }
        if ($actualJson -cne $expectedJson) { throw 'INSTALL_STATE_IDENTITY_OR_SOURCE_MISMATCH_REVIEW_REQUIRED' }
        Assert-CodexExecutorInstallArtifacts -Manifest $Manifest
        return 'RESUME_SAFE'
    }
    if ((Test-Path -LiteralPath $Manifest.spool_dir) -or (Test-Path -LiteralPath $Manifest.runtime_dir)) {
        throw 'CODEX_EXECUTOR_PATH_ALREADY_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE'
    }
    $parent = Split-Path -Parent $ManifestPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'INSTALL_STATE_PARENT_MISSING' }
    $json = $expectedJson
    $bytes = ([System.Text.UTF8Encoding]::new($false)).GetBytes($json)
    $stream = $null
    try {
        $stream = [IO.File]::Open($ManifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } catch { throw 'INSTALL_STATE_CREATE_FAILED_REVIEW_REQUIRED' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    return 'CREATED'
}

function Ensure-CodexExecutorInstallDirectories {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Manifest)
    Assert-CodexExecutorInstallArtifacts -Manifest $Manifest
    foreach ($entry in @(Get-CodexExecutorInstallDirectoryPlan $Manifest)) {
        if (Test-Path -LiteralPath $entry.Path) {
            $item = Get-Item -LiteralPath $entry.Path -Force
            if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                throw 'INSTALL_STATE_DIRECTORY_COLLISION_REVIEW_REQUIRED'
            }
        } else {
            $null = New-Item -ItemType Directory -Path $entry.Path -ErrorAction Stop
        }
    }
    Assert-CodexExecutorInstallArtifacts -Manifest $Manifest
}

function Copy-CodexExecutorInstallFile {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourcePath, [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$ExpectedSha256)
    $sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($sourceHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_STATE_SOURCE_HASH_CHANGED' }
    if (Test-Path -LiteralPath $DestinationPath) {
        if ((Get-Item -LiteralPath $DestinationPath -Force).PSIsContainer) { throw 'INSTALL_STATE_RUNTIME_FILE_COLLISION_REVIEW_REQUIRED' }
        $existingHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_STATE_RUNTIME_HASH_MISMATCH_REVIEW_REQUIRED' }
        return 'EXISTING_MATCH'
    }
    Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -ErrorAction Stop
    $copiedHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copiedHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_STATE_RUNTIME_COPY_READBACK_MISMATCH' }
    return 'COPIED'
}

function Write-CodexExecutorInstallBytes {
    [CmdletBinding()]
    param([Parameter(Mandatory)][byte[]]$Bytes, [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$ExpectedSha256)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualBytesHash = [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($actualBytesHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_STATE_CONFIG_BYTES_HASH_MISMATCH' }
    if (Test-Path -LiteralPath $DestinationPath) {
        $existingHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALL_STATE_RUNTIME_HASH_MISMATCH_REVIEW_REQUIRED' }
        return 'EXISTING_MATCH'
    }
    $stream = $null
    try {
        $stream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } catch { throw 'INSTALL_STATE_CONFIG_WRITE_FAILED_REVIEW_REQUIRED' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    if ((Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256.ToLowerInvariant()) {
        throw 'INSTALL_STATE_CONFIG_READBACK_MISMATCH'
    }
    return 'WRITTEN'
}

function Complete-CodexExecutorInstallState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ManifestPath, [Parameter(Mandatory)]$Manifest)
    $null = Initialize-CodexExecutorInstallState -ManifestPath $ManifestPath -Manifest $Manifest
    Assert-CodexExecutorInstallArtifacts -Manifest $Manifest -RequireComplete
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'INSTALL_STATE_READBACK_MISSING' }
}

Export-ModuleMember -Function New-CodexExecutorInstallManifest,Initialize-CodexExecutorInstallState,
    Get-CodexExecutorInstallDirectoryPlan,Ensure-CodexExecutorInstallDirectories,Copy-CodexExecutorInstallFile,
    Write-CodexExecutorInstallBytes,Complete-CodexExecutorInstallState
