// A bounded, de-identified observation written into one existing Issue #407 comment.
// This module never creates work, calls a model, or starts a background process.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPERATOR_MARKER = 'PTYSD_OPERATOR_OBSERVATION_V1\n';
export const OPERATOR_REPO = 'PT-Original-Point/ptysd-autonomous-factory';
export const OPERATOR_PROJECT = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
export const OPERATOR_ISSUE = 407;
export const OPERATOR_COMMENT_ID = 6144415195;
const MAX_OPERATOR_COMMENT_BODY_LENGTH = 65_536;
const FORBIDDEN_KEYS = /^(?:pid|process_id|command|commandline|command_line|argv|path|absolute_path|stdout|stderr|prompt|token|authorization|credential|diff|environment|username|user_name|user_id|email|computer_name|host_name)$/i;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const SNAPSHOT_ID = /^[a-f0-9-]{36}$/i;
const SENSITIVE_VALUE = /(?:\b[A-Z]:\\|\\\\[^\\\s]+\\|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bBearer\s+[A-Za-z0-9._~-]{16,})/i;
const DEPLOYED_RUNTIME_FILES = [
  'worker.mjs', 'opencode-v2.mjs', 'v2-readiness.mjs', 'codex-continuation.mjs',
  'operator-observation.mjs', 'captured-process.mjs', 'safe-error-code.mjs', 'windows-executor.mjs',
];
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_KEYS.test(key) || containsForbiddenKey(child));
}

function validRuntimeDeployment(value) {
  if (!object(value) || !['MANIFEST_MATCHED', 'UNKNOWN'].includes(value.status) ||
      !validTime(value.observed_at) || !SHA256.test(value.bundle_sha256 || '') ||
      !object(value.component_sha256)) return false;
  const entries = Object.entries(value.component_sha256);
  if (entries.length !== DEPLOYED_RUNTIME_FILES.length ||
      DEPLOYED_RUNTIME_FILES.some(name => !Object.hasOwn(value.component_sha256, name)))
    return false;
  if (value.status === 'MANIFEST_MATCHED')
    return entries.every(([, sha]) => SHA256.test(sha || '')) &&
      SHA1.test(value.source_main_sha || '') && Number.isSafeInteger(value.deployment_pr) &&
      value.deployment_pr > 0 && SHA1.test(value.deployment_pr_head || '');
  if (entries.some(([, sha]) => sha !== null && !SHA256.test(sha || ''))) return false;
  if (value.status === 'UNKNOWN')
    return typeof value.reason_code === 'string' &&
      ['DEPLOYMENT_MANIFEST_NOT_MATCHED', 'DEPLOYMENT_MANIFEST_AMBIGUOUS',
        'RUNTIME_FILES_UNAVAILABLE'].includes(value.reason_code) &&
      value.source_main_sha === undefined && value.deployment_pr === undefined &&
      value.deployment_pr_head === undefined;
  return false;
}

export function parseOperatorObservation(body) {
  if (typeof body !== 'string' || body.length > MAX_OPERATOR_COMMENT_BODY_LENGTH ||
      !body.startsWith(OPERATOR_MARKER))
    return null;
  let value;
  try { value = JSON.parse(body.slice(OPERATOR_MARKER.length)); }
  catch { return null; }
  if (!object(value) || value.schema !== 1 ||
      value.project_id !== OPERATOR_PROJECT || value.repo !== OPERATOR_REPO ||
      value.issue !== OPERATOR_ISSUE || value.host_alias !== 'win11-primary' ||
      !SNAPSHOT_ID.test(value.snapshot_id || '') ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !validTime(value.observed_at) ||
      (value.published_at !== undefined && !validTime(value.published_at)) ||
      (value.publisher_login !== undefined && !GITHUB_LOGIN.test(value.publisher_login || '')) ||
      (value.comment_author_login !== undefined && !GITHUB_LOGIN.test(value.comment_author_login || '')) ||
      (value.source?.comment_id !== undefined &&
        (!Number.isSafeInteger(value.source.comment_id) || value.source.comment_id < 1)) ||
      (value.runtime_deployment !== undefined && !validRuntimeDeployment(value.runtime_deployment)) ||
      !validTime(value.expires_at) || containsForbiddenKey(value)) return null;
  const observed = Date.parse(value.observed_at);
  const expires = Date.parse(value.expires_at);
  const legacyPublished = value.published_at === undefined ? null : Date.parse(value.published_at);
  if ((legacyPublished !== null && (legacyPublished < observed || legacyPublished >= expires)) ||
      expires <= observed || expires - observed > 15 * 60 * 1000) return null;
  return value;
}

export function encodeOperatorObservation(value) {
  const body = OPERATOR_MARKER + JSON.stringify(value);
  if (!parseOperatorObservation(body)) throw new Error('INVALID_OPERATOR_OBSERVATION');
  return body;
}

export function findOperatorComment(comments, expectedLogin, expectedCommentId = null) {
  if (!Array.isArray(comments) || typeof expectedLogin !== 'string' || !expectedLogin)
    return { status: 'UNKNOWN', error: 'INVALID_OPERATOR_COMMENT_INPUT' };
  const matches = comments.filter(comment =>
    typeof comment?.body === 'string' && comment.body.startsWith(OPERATOR_MARKER));
  if (!matches.length) return { status: 'NOT_SEEDED', error: null };
  if (matches.length !== 1) return { status: 'UNKNOWN', error: 'DUPLICATE_OPERATOR_COMMENTS' };
  const comment = matches[0];
  if (expectedCommentId !== null && comment.id !== expectedCommentId)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_ID_MISMATCH' };
  if (comment.user?.login !== expectedLogin)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_AUTHOR_MISMATCH' };
  const observation = parseOperatorObservation(comment.body);
  if (!observation) return { status: 'UNKNOWN', error: 'INVALID_OPERATOR_OBSERVATION' };
  if (observation.source?.comment_id !== undefined && observation.source.comment_id !== comment.id)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_ID_MISMATCH' };
  return { status: 'OK', comment, observation, error: null };
}

export async function updateExistingOperatorComment({
  comments, expectedLogin, expectedCommentId = null, body, readComment, patchComment, readComments,
  now = Date.now,
}) {
  const existing = findOperatorComment(comments, expectedLogin, expectedCommentId);
  if (existing.status === 'NOT_SEEDED') return { status: 'NOT_SEEDED' };
  if (existing.status !== 'OK') return existing;
  const candidate = parseOperatorObservation(body);
  if (!candidate || typeof readComment !== 'function' ||
      typeof patchComment !== 'function' || typeof readComments !== 'function')
    return { status: 'UNKNOWN', error: 'INVALID_OPERATOR_UPDATE_INPUT' };
  const current = await readComment(existing.comment.id);
  if (current?.id !== existing.comment.id ||
      current?.user?.login !== expectedLogin ||
      current?.body !== existing.comment.body)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_CHANGED_BEFORE_UPDATE' };
  const currentUpdatedAt = Date.parse(current.updated_at || '');
  if (!Number.isFinite(currentUpdatedAt))
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_UPDATED_AT_UNKNOWN' };
  if (candidate.sequence !== existing.observation.sequence + 1)
    return { status: 'UNKNOWN', error: 'OPERATOR_SEQUENCE_NOT_MONOTONIC' };
  if (Date.parse(candidate.observed_at) <= Date.parse(existing.observation.observed_at))
    return { status: 'UNKNOWN', error: 'OPERATOR_OBSERVED_AT_NOT_MONOTONIC' };
  await patchComment(existing.comment.id, body);
  let commentsAfterWrite;
  try { commentsAfterWrite = await readComments(); }
  catch { return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_UPDATE_READBACK_UNKNOWN' }; }
  const fresh = findOperatorComment(commentsAfterWrite, expectedLogin, expectedCommentId);
  if (fresh.status !== 'OK' || fresh.comment.id !== existing.comment.id ||
      fresh.comment.body !== body)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_UPDATE_READBACK_UNKNOWN' };
  const githubUpdatedAt = Date.parse(fresh.comment.updated_at || '');
  const observedAt = Date.parse(fresh.observation.observed_at);
  const expiresAt = Date.parse(fresh.observation.expires_at);
  const currentTime = Number(now());
  if (!Number.isFinite(githubUpdatedAt))
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_UPDATED_AT_UNKNOWN' };
  if (githubUpdatedAt <= currentUpdatedAt)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_UPDATE_TIME_NOT_MONOTONIC' };
  if (githubUpdatedAt < observedAt - 5 * 60 * 1000 ||
      githubUpdatedAt >= expiresAt || !Number.isFinite(currentTime) ||
      githubUpdatedAt > currentTime + 5 * 60 * 1000)
    return { status: 'UNKNOWN', error: 'OPERATOR_COMMENT_UPDATE_TIME_INVALID' };
  return { status: 'UPDATED', comment_id: existing.comment.id,
    github_updated_at: fresh.comment.updated_at, observation: fresh.observation };
}

export function observationFreshness(observation, now = Date.now()) {
  if (!observation || !validTime(observation.observed_at) || !validTime(observation.expires_at))
    return 'UNKNOWN';
  if (Date.parse(observation.observed_at) > now + 5 * 60 * 1000) return 'UNKNOWN';
  return Date.parse(observation.expires_at) <= now ? 'STALE' : 'FRESH';
}

export function collectRuntimeDeployment({
  runtimeDir = dirname(fileURLToPath(import.meta.url)),
  now = () => new Date().toISOString(),
} = {}) {
  const observedAt = now();
  const componentSha256 = Object.fromEntries(DEPLOYED_RUNTIME_FILES.map(file => [file, null]));
  try {
    for (const file of DEPLOYED_RUNTIME_FILES) {
      const target = join(runtimeDir, file);
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('RUNTIME_FILE_NOT_REGULAR');
      componentSha256[file] = createHash('sha256').update(readFileSync(target)).digest('hex');
    }
  } catch {
    return { status: 'UNKNOWN', observed_at: observedAt,
      reason_code: 'RUNTIME_FILES_UNAVAILABLE',
      bundle_sha256: createHash('sha256').update(JSON.stringify(componentSha256)).digest('hex'),
      component_sha256: componentSha256 };
  }
  const orderedFiles = DEPLOYED_RUNTIME_FILES.map(file => [file, componentSha256[file]]);
  const bundleSha256 = createHash('sha256').update(JSON.stringify(orderedFiles)).digest('hex');
  let backupEntries = [];
  try {
    backupEntries = readdirSync(join(runtimeDir, 'backups'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^worker-deploy-accepted-[A-Za-z0-9-]+$/.test(entry.name));
  } catch {}
  const matching = [];
  for (const entry of backupEntries) {
    try {
      const manifest = JSON.parse(readFileSync(join(runtimeDir, 'backups', entry.name, 'manifest.json'), 'utf8'));
      if (!object(manifest) || manifest.schema !== 1 || !SHA1.test(manifest.source_main_sha || '') ||
          !Number.isSafeInteger(manifest.accepted_pr) || manifest.accepted_pr < 1 ||
          !SHA1.test(manifest.accepted_pr_head || '') || !Array.isArray(manifest.files)) continue;
      const stagedFilesMatch = DEPLOYED_RUNTIME_FILES.every(file => {
        const staged = manifest.files.filter(item => object(item) && item.file === file &&
          SHA256.test(item.stage_sha256 || ''));
        return staged.length === 1 && staged[0].stage_sha256.toLowerCase() === componentSha256[file];
      });
      if (stagedFilesMatch)
        matching.push({ source_main_sha: manifest.source_main_sha.toLowerCase(),
          deployment_pr: manifest.accepted_pr,
          deployment_pr_head: manifest.accepted_pr_head.toLowerCase() });
    } catch {}
  }
  const identities = new Map(matching.map(item =>
    [`${item.source_main_sha}:${item.deployment_pr}:${item.deployment_pr_head}`, item]));
  if (identities.size !== 1) {
    return { status: 'UNKNOWN', observed_at: observedAt,
      reason_code: identities.size ? 'DEPLOYMENT_MANIFEST_AMBIGUOUS' : 'DEPLOYMENT_MANIFEST_NOT_MATCHED',
      bundle_sha256: bundleSha256, component_sha256: componentSha256 };
  }
  const accepted = [...identities.values()][0];
  return { status: 'MANIFEST_MATCHED', observed_at: observedAt, ...accepted,
    bundle_sha256: bundleSha256, component_sha256: componentSha256 };
}

const POWERSHELL_READBACK = String.raw`
$ErrorActionPreference = 'Stop'
function Get-ExactTask([string]$name) {
  try { return @(Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop) }
  catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound,*') { return @() }
    throw
  }
}
$nativeTaskMatches = @(Get-ExactTask 'PTYSD-Native-OpenCode')
$task = if ($nativeTaskMatches.Count -eq 1) { $nativeTaskMatches[0] } else { $null }
$legacy = @(Get-ExactTask 'PTYSD-Factory-Monitor')
$listener = $null
try { $listener = (@(Get-NetTCPConnection -State Listen -LocalPort 2667 -ErrorAction Stop).Count -gt 0) } catch {
  try {
    $rows = @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null)
    $listener = (@($rows | Where-Object { $_ -match '^\s*TCP\s+\S+:2667\s+\S+\s+LISTENING\s+' }).Count -gt 0)
  } catch {}
}
$opencodeCount = $null
try {
  $opencodeCount = @(Get-CimInstance Win32_Process -Filter "Name='opencode2.exe' OR Name='opencode-cli.exe' OR Name='opencode.exe'" -ErrorAction Stop).Count
} catch {}
$runnerServiceCount = $null
$runnerServiceRunning = $null
try {
  $runnerServices = @(Get-Service -Name 'actions.runner.*' -ErrorAction Stop)
  $runnerServiceCount = $runnerServices.Count
  $runnerServiceRunning = @($runnerServices | Where-Object { $_.Status -eq 'Running' }).Count
} catch {}
$native = $null
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
  $actionKind = 'OTHER'
  if (@($task.Actions).Count -eq 1) {
    $leaf = [IO.Path]::GetFileName([string]$task.Actions[0].Execute)
    $arguments = [string]$task.Actions[0].Arguments
    if ($leaf -ieq 'node.exe') { $actionKind = 'NODE_DIRECT' }
    elseif ($leaf -ieq 'HiddenNodeLauncher.exe') { $actionKind = 'WINDOWLESS_LAUNCHER' }
    elseif ($leaf -ieq 'wscript.exe' -and $arguments -match 'HiddenWorker\.vbs') {
      $actionKind = 'WINDOWLESS_LAUNCHER'
    }
  }
  $identityClass = 'UNKNOWN'
  if ([string]$task.Principal.LogonType -match 'Interactive') {
    $identityClass = 'INTERACTIVE_' + ([string]$task.Principal.RunLevel).ToUpperInvariant()
  }
  $interval = $null
  $repeat = @($task.Triggers | Where-Object { $_.Repetition.Interval } | Select-Object -First 1)
  if ($repeat.Count -eq 1 -and [string]$repeat[0].Repetition.Interval -match '^PT(\d+)M$') {
    $interval = [int]$Matches[1]
  }
  $lastRun = $null
  if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $lastRun = $info.LastRunTime.ToString('o') }
  $native = [pscustomobject]@{
    registered = $true
    enabled = [bool]$task.Settings.Enabled
    state = [string]$task.State
    last_run = $lastRun
    last_result = ('0x{0:X8}' -f [uint32]$info.LastTaskResult)
    action_kind = $actionKind
    identity_class = $identityClass
    multiple_instances = [string]$task.Settings.MultipleInstances
    trigger_interval_minutes = $interval
  }
} else {
  $native = [pscustomobject]@{ registered = ($nativeTaskMatches.Count -gt 1); enabled = $null; state = 'UNKNOWN'; last_run = $null; last_result = $null; action_kind = 'UNKNOWN'; identity_class = 'UNKNOWN'; multiple_instances = 'UNKNOWN'; trigger_interval_minutes = $null }
}
[pscustomobject]@{
  observed_at = [DateTime]::UtcNow.ToString('o')
  legacy_monitor_registered = ($legacy.Count -gt 0)
  listener_2667 = $listener
  native_task = $native
  opencode_process_count = $opencodeCount
  runner_service_count = $runnerServiceCount
  runner_service_running = $runnerServiceRunning
} | ConvertTo-Json -Compress -Depth 5
`;

export function collectWindowsObservation({
  platformName = platform(),
  execute = execFileSync,
  now = () => new Date().toISOString(),
} = {}) {
  if (platformName !== 'win32') {
    return { status: 'UNKNOWN', observed_at: null, error: 'WINDOWS_ONLY' };
  }
  try {
    const text = execute('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_READBACK],
      { encoding: 'utf8', timeout: 7000, windowsHide: true, maxBuffer: 128 * 1024 });
    const raw = JSON.parse(String(text).trim());
    if (!object(raw) || !validTime(raw.observed_at) ||
        typeof raw.legacy_monitor_registered !== 'boolean' ||
        !(raw.listener_2667 === null || typeof raw.listener_2667 === 'boolean') ||
        !(raw.opencode_process_count === null ||
          (Number.isSafeInteger(raw.opencode_process_count) && raw.opencode_process_count >= 0)) ||
        !(raw.runner_service_count === null ||
          (Number.isSafeInteger(raw.runner_service_count) && raw.runner_service_count >= 0)) ||
        !(raw.runner_service_running === null ||
          (Number.isSafeInteger(raw.runner_service_running) && raw.runner_service_running >= 0)) ||
        !object(raw.native_task)) throw new Error('WINDOWS_READBACK_INVALID');
    const t = raw.native_task;
    const task = {
      registered: t.registered === true ? true : t.registered === false ? false : null,
      enabled: t.enabled === true ? true : t.enabled === false ? false : null,
      state: ['READY', 'RUNNING', 'DISABLED', 'QUEUED', 'UNKNOWN'].includes(String(t.state).toUpperCase())
        ? String(t.state).toUpperCase() : 'UNKNOWN',
      last_run: validTime(t.last_run) ? t.last_run : null,
      last_result: /^0x[0-9a-f]{8}$/i.test(t.last_result || '') ? t.last_result.toUpperCase() : null,
      action_kind: ['NODE_DIRECT', 'WINDOWLESS_LAUNCHER', 'OTHER', 'UNKNOWN'].includes(t.action_kind)
        ? t.action_kind : 'UNKNOWN',
      identity_class: ['INTERACTIVE_LIMITED', 'INTERACTIVE_HIGHEST', 'UNKNOWN'].includes(t.identity_class)
        ? t.identity_class : 'UNKNOWN',
      multiple_instances: ['IGNORENEW', 'QUEUE', 'PARALLEL', 'STOPEXISTING', 'UNKNOWN']
        .includes(String(t.multiple_instances).replace(/[^A-Za-z]/g, '').toUpperCase())
        ? String(t.multiple_instances).replace(/[^A-Za-z]/g, '').toUpperCase() : 'UNKNOWN',
      trigger_interval_minutes: Number.isSafeInteger(t.trigger_interval_minutes) &&
        t.trigger_interval_minutes > 0 && t.trigger_interval_minutes <= 1440
        ? t.trigger_interval_minutes : null,
    };
    return {
      status: 'FRESH',
      observed_at: raw.observed_at,
      legacy_monitor_registered: raw.legacy_monitor_registered,
      listener_2667: raw.listener_2667,
      native_task: task,
      opencode_process_count: raw.opencode_process_count,
      runner_service_count: raw.runner_service_count,
      runner_service_running: raw.runner_service_running,
    };
  } catch {
    return { status: 'UNKNOWN', observed_at: now(), error: 'WINDOWS_READBACK_FAILED' };
  }
}
