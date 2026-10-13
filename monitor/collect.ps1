[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$result = [ordered]@{
    collected_at = [DateTime]::UtcNow.ToString("o")
    section_collected_at = [ordered]@{
        processes = $null
        scheduled_tasks = $null
        services = $null
        vms = $null
    }
    section_errors = [ordered]@{
        processes = $null
        scheduled_tasks = $null
        services = $null
        vms = $null
    }
    processes = @()
    scheduled_tasks = @()
    services = @()
    vms = @()
    errors = @()
}

# 1. Processes: node, agy, opencode, opencode-cli, codex, runner, Runner.Listener, RunnerService, cloudflared, ssh
try {
    $procRegex = '(?i)^(node|agy|opencode|opencode-cli|codex|runner|Runner\.Listener|RunnerService|cloudflared|ssh)(\.exe)?$'
    $rawProcs = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match $procRegex }
    $procs = @()
    foreach ($p in $rawProcs) {
        $cDate = $null
        if ($p.CreationDate) {
            try { $cDate = ([datetime]$p.CreationDate).ToUniversalTime().ToString("o") } catch {}
        }
        $procs += [ordered]@{
            pid = [int]$p.ProcessId
            name = [string]$p.Name
            path = if ($p.ExecutablePath) { [string]$p.ExecutablePath } else { "" }
            created_at = $cDate
        }
    }
    $result.processes = @($procs)
    $result.section_collected_at.processes = [DateTime]::UtcNow.ToString("o")
} catch {
    $errMsg = "processes: " + $_.Exception.Message
    $result.errors += $errMsg
    $result.section_errors.processes = $errMsg
    $result.section_collected_at.processes = $null
}

# 2. Scheduled Tasks: filtered PTYSD|Factory|Supervisor|Codex|HostGuard
try {
    $taskRegex = '(?i)(PTYSD|Factory|Supervisor|Codex|HostGuard)'
    $rawTasks = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -match $taskRegex -or $_.TaskPath -match $taskRegex }
    $tasks = @()
    foreach ($t in $rawTasks) {
        $itemError = $null
        $info = $null
        try {
            $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop
        } catch {
            $itemError = $_.Exception.Message
        }

        $actionExe = ""
        try {
            if ($t.Actions) {
                $firstAct = @($t.Actions)[0]
                if ($firstAct.Execute) {
                    $actionExe = [System.IO.Path]::GetFileName($firstAct.Execute)
                }
            }
        } catch {}

        $tasks += [ordered]@{
            name = [string]$t.TaskName
            path = [string]$t.TaskPath
            state = if ($t.State) { [string]$t.State } else { "UNKNOWN" }
            next_run = if ($info -and $info.NextRunTime -and $info.NextRunTime.Year -gt 1970) { $info.NextRunTime.ToUniversalTime().ToString("o") } else { $null }
            last_run = if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1970) { $info.LastRunTime.ToUniversalTime().ToString("o") } else { $null }
            last_result = if ($info) { try { [Int64]$info.LastTaskResult } catch { [string]$info.LastTaskResult } } else { $null }
            action = $actionExe
            error = $itemError
        }
    }
    $result.scheduled_tasks = @($tasks)
    $result.section_collected_at.scheduled_tasks = [DateTime]::UtcNow.ToString("o")
} catch {
    $errMsg = "scheduled_tasks: " + $_.Exception.Message
    $result.errors += $errMsg
    $result.section_errors.scheduled_tasks = $errMsg
    $result.section_collected_at.scheduled_tasks = $null
}

# 3. Services: ptysd, codex, ssh, cloudflared, runner, Factory, HostGuard
try {
    $svcRegex = '(?i)(ptysd|codex|ssh|cloudflared|runner|Runner\.Listener|RunnerService|Factory|HostGuard)'
    $rawSvcs = Get-Service -ErrorAction Stop | Where-Object { $_.Name -match $svcRegex -or $_.DisplayName -match $svcRegex }
    $services = @()
    foreach ($s in $rawSvcs) {
        $services += [ordered]@{
            name = [string]$s.Name
            status = [string]$s.Status
            start_type = [string]$s.StartType
            display_name = [string]$s.DisplayName
        }
    }
    $result.services = @($services)
    $result.section_collected_at.services = [DateTime]::UtcNow.ToString("o")
} catch {
    $errMsg = "services: " + $_.Exception.Message
    $result.errors += $errMsg
    $result.section_errors.services = $errMsg
    $result.section_collected_at.services = $null
}

# 4. Hyper-V VMs
try {
    $rawVms = Get-VM -ErrorAction Stop
    $vms = @()
    foreach ($v in $rawVms) {
        $vms += [ordered]@{
            name = [string]$v.Name
            state = [string]$v.State
            status = [string]$v.Status
        }
    }
    $result.vms = @($vms)
    $result.section_collected_at.vms = [DateTime]::UtcNow.ToString("o")
} catch {
    $errMsg = "vms: " + $_.Exception.Message
    $result.vms = @([ordered]@{
        status = "UNKNOWN"
        error = "LOCAL_OS_PRIVILEGE_REQUIRED"
    })
    $result.errors += $errMsg
    $result.section_errors.vms = $errMsg
    $result.section_collected_at.vms = $null
}

$json = $result | ConvertTo-Json -Compress -Depth 5
[Console]::Out.WriteLine($json)
