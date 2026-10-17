#!/usr/bin/env node
// On-demand Codex Executor. Run only from a separately registered, Limited
// Windows Task Scheduler identity. It has no GitHub Publisher code or token.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync,
  openSync, closeSync, ftruncateSync, readFileSync, readdirSync, renameSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { uptime } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWindowsProcessTree, runCapturedProcess, terminateProcessTree }
  from './captured-process.mjs';
import { codexExecutionGate, buildCodexExecArgs, codexSessionFromJsonl,
  codexRunOutcome, codexExecutorPrompt, executorResultPath,
  validateCodexExecutorRequest } from './codex-continuation.mjs';

function digestFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function nativeText(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseArgs(argv) {
  const i = argv.indexOf('--config');
  if (i < 0 || !argv[i + 1] || argv.filter(value => value === '--config').length !== 1)
    throw new Error('USAGE: --config executor-config.json');
  return resolve(argv[i + 1]);
}

export function validateExecutorConfig(config, currentSid, environment = process.env) {
  const policy = {
    github_transport_verified: config?.github_transport_verified,
    codex_cli_qualified: config?.codex_cli_qualified,
    codex_login_verified: config?.codex_login_verified,
    enable_codex_model_runs: config?.enable_codex_model_runs,
    codex_usage_authorized: config?.codex_usage_authorized,
    codex_sandbox_boundary: config?.codex_sandbox_boundary,
    publisher_identity_sid: config?.publisher_identity_sid,
    executor_identity_sid: config?.executor_identity_sid,
    codex_executor_task: config?.codex_executor_task,
    allowed_codex_models: config?.allowed_codex_models,
  };
  const reasons = [];
  if (!currentSid || currentSid !== config?.executor_identity_sid) reasons.push('EXECUTOR_SID_MISMATCH');
  if (currentSid === config?.publisher_identity_sid) reasons.push('PUBLISHER_CREDENTIAL_IDENTITY_SHARED');
  if (environment.GH_TOKEN || environment.GITHUB_TOKEN) reasons.push('GITHUB_TOKEN_ENV_PRESENT');
  if (typeof config?.spool_dir !== 'string' || !isAbsolute(config.spool_dir)) reasons.push('SPOOL_PATH_INVALID');
  if (typeof config?.workspace_root !== 'string' || !isAbsolute(config.workspace_root)) reasons.push('WORKSPACE_ROOT_INVALID');
  if (typeof config?.codex_executable !== 'string' || !isAbsolute(config.codex_executable)) reasons.push('CODEX_EXECUTABLE_INVALID');
  if (config?.codex_executable_sha256 && !/^[a-f0-9]{64}$/i.test(config.codex_executable_sha256))
    reasons.push('CODEX_EXECUTABLE_HASH_INVALID');
  return { ready: reasons.length === 0, reasons, policy };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

function archiveActiveLock(path) {
  const archived = join(dirname(path), `executor.stale-${Date.now()}-${randomUUID()}.json`);
  renameSync(path, archived);
  return archived;
}

function acquireActiveLock(spoolDir, deps = {}) {
  const lockDir = join(spoolDir, 'locks');
  mkdirSync(lockDir, { recursive: true });
  const path = join(lockDir, 'executor.active');
  const currentUptime = (deps.uptimeSeconds || uptime)();
  for (let retry = 0; retry < 3; retry++) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ schema: 1, pid: process.pid,
        started_at: new Date().toISOString(), boot_uptime_seconds: currentUptime,
        phase: 'DISPATCHER', request_id: null, attempt_id: null, model_pid: null }));
      fsyncSync(fd);
      closeSync(fd);
      return path;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original error */ } }
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw error; }
      if (lock?.schema !== 1 || !Number.isSafeInteger(lock.pid) ||
          !Number.isFinite(lock.boot_uptime_seconds) || typeof lock.phase !== 'string') throw error;
      if (lock.model_pid !== undefined && lock.model_pid !== null &&
          (!Number.isSafeInteger(lock.model_pid) || lock.model_pid < 1)) throw error;

      // A lower OS uptime proves a reboot terminated every prior process. The
      // durable per-attempt claim remains, so the old request is never replayed.
      const previousBoot = currentUptime < lock.boot_uptime_seconds;
      if (!previousBoot) {
        const alive = (deps.isProcessAlive || isProcessAlive)(lock.pid);
        if (alive !== false) throw error;
        if (Number.isSafeInteger(lock.model_pid)) {
          const readback = (deps.readProcessTree || readWindowsProcessTree)(lock.model_pid);
          if (readback?.root_pid !== lock.model_pid || readback?.state !== 'DEAD' ||
              !Array.isArray(readback.process_ids) || readback.process_ids.length !== 0)
            throw new Error('EXECUTOR_LOCK_MODEL_TREE_UNKNOWN');
        } else if (!['DISPATCHER', 'CLAIMED_NO_MODEL', 'MODEL_FINISHED', 'RESULT_SAVED'].includes(lock.phase)) {
          throw new Error('EXECUTOR_LOCK_STALE_MODEL_EFFECTS_UNKNOWN');
        }
      }
      try { archiveActiveLock(path); }
      catch (archiveError) { if (archiveError.code !== 'ENOENT') throw archiveError; }
    }
  }
  throw new Error('EXECUTOR_LOCK_RECOVERY_RACE');
}

function updateActiveLock(path, phase, request = null, modelPid = undefined) {
  const fd = openSync(path, 'r+');
  try {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current?.schema !== 1 || current.pid !== process.pid)
      throw new Error('EXECUTOR_LOCK_OWNERSHIP_LOST');
    const next = { ...current, phase,
      request_id: request?.request_id ?? current.request_id,
      attempt_id: request?.attempt_id ?? current.attempt_id };
    if (modelPid !== undefined)
      next.model_pid = Number.isSafeInteger(modelPid) && modelPid > 0 ? modelPid : null;
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify(next));
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function takeNextRequest(spoolDir) {
  const requests = join(spoolDir, 'requests');
  const claims = join(spoolDir, 'claims');
  mkdirSync(requests, { recursive: true });
  mkdirSync(claims, { recursive: true });
  const files = readdirSync(requests).filter(name => name.endsWith('.json')).sort();
  for (const name of files) {
    const source = join(requests, name);
    let request;
    try {
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) continue;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try { request = JSON.parse(readFileSync(source, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') continue; throw error; }
    try { validateCodexExecutorRequest(request); }
    catch { continue; }
    if (name !== `${request.request_id}-${request.attempt_id}.json`) continue;
    const resultPath = executorResultPath(spoolDir, request.request_id, request.attempt_id);
    if (existsSync(resultPath)) continue;
    const claimPath = join(claims, `${request.request_id}-${request.attempt_id}.json`);
    let fd;
    try {
      fd = openSync(claimPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ request_id: request.request_id,
        attempt_id: request.attempt_id, source_sha: request.source_sha,
        fingerprint: request.fingerprint }));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      return { path: source, request, claim_path: claimPath };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original failure */ } }
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }
  return null;
}

function getWindowsSid() {
  const output = nativeText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
  return output.trim();
}

function assertNoGitHubTokenEnvironment() {
  const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  if (names.some(name => process.env[name])) throw new Error('GITHUB_TOKEN_ENV_PRESENT');
}

async function qualifyCodex(config) {
  if (config.codex_executable_sha256) {
    if ((await digestFile(config.codex_executable)).toLowerCase() !== config.codex_executable_sha256.toLowerCase())
      throw new Error('CODEX_EXECUTABLE_HASH_MISMATCH');
  }
  try {
    execFileSync(config.codex_executable, ['login', 'status'], { encoding: 'utf8',
      windowsHide: true, shell: false, timeout: 20000, maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('CODEX_LOGIN_NOT_READY'); }
}

export function buildCodexChildEnvironment(request, evidenceDir, source = process.env) {
  const env = {};
  for (const name of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME', 'COMSPEC',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY']) delete env[name];
  const ghConfigDir = join(evidenceDir, `${request.job.request_id}-${request.attempt_id}.gh-config`);
  mkdirSync(ghConfigDir, { recursive: false, mode: 0o700 });
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GH_PROMPT_DISABLED = '1';
  return { env, ghConfigDir };
}

export async function runCodex(request, config, worktree, evidenceDir, deps = {}) {
  const job = request.job;
  const args = buildCodexExecArgs(job, worktree);
  const outPath = join(evidenceDir, `${job.request_id}-${request.attempt_id}.stdout.jsonl`);
  const errPath = join(evidenceDir, `${job.request_id}-${request.attempt_id}.stderr.txt`);
  // Do not expose a Publisher's stored gh configuration to the model process.
  const { env } = buildCodexChildEnvironment(request, evidenceDir, deps.environment || process.env);
  const validatedRequest = validateCodexExecutorRequest(request);
  const capture = await runCapturedProcess(config.codex_executable, args, {
    cwd: worktree, env, stdoutPath: outPath, stderrPath: errPath,
    stdinText: codexExecutorPrompt(validatedRequest),
    spawnProcess: deps.spawnProcess || spawn,
    terminate: deps.terminate || terminateProcessTree,
    onSpawn: deps.onProcessSpawn,
  });
  const evidence = capture.local_evidence;
  const executionEvidence = evidence.storage_error || evidence.capture_error
    ? { session_id: null, provider_usage_evidence: 'UNKNOWN', model_activity_evidence: 'UNKNOWN',
      token_usage: null, tool_execution_evidence: 'UNKNOWN', tool_execution_count: 0,
      file_change_tool_evidence: 'UNKNOWN', file_change_tool_completed_count: 0,
      file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0 }
    : await readCodexExecutionEvidence(outPath);
  const sessionId = executionEvidence.session_id;
  const terminationUnknown = ['ORPHAN_POSSIBLE', 'TERMINATION_REQUESTED', 'TERMINATION_UNCONFIRMED']
    .includes(evidence.termination_state);
  const outcome = terminationUnknown ? 'CODEX_PROCESS_TERMINATION_FAILED' :
    capture.outcome === 'EVIDENCE_STORAGE_FAILED' ? 'CODEX_EVIDENCE_STORAGE_FAILED' :
      capture.outcome === 'OUTPUT_CAPTURE_FAILED' ? 'CODEX_OUTPUT_CAPTURE_FAILED' :
        capture.outcome === 'OPENCODE_SPAWN_FAILED' ? 'CODEX_SPAWN_FAILED' :
          capture.outcome === 'OPENCODE_PROCESS_FAILED' ? 'CODEX_PROCESS_FAILED' :
            capture.outcome === 'OPENCODE_INPUT_FAILED' ? 'CODEX_INPUT_FAILED' :
              codexRunOutcome(capture.exit_code, sessionId);
  return { exit_code: capture.exit_code < 0 ? null : capture.exit_code,
    signal: evidence.exit_signal,
    session_id: sessionId, session_started: sessionId !== null,
    provider_usage_evidence: executionEvidence.provider_usage_evidence,
    model_activity_evidence: executionEvidence.model_activity_evidence,
    token_usage: executionEvidence.token_usage,
    tool_execution_evidence: executionEvidence.tool_execution_evidence,
    tool_execution_count: executionEvidence.tool_execution_count,
    file_change_tool_evidence: executionEvidence.file_change_tool_evidence,
    file_change_tool_completed_count: executionEvidence.file_change_tool_completed_count,
    file_change_tool_failed_count: executionEvidence.file_change_tool_failed_count,
    file_change_tool_incomplete_count: executionEvidence.file_change_tool_incomplete_count,
    model_invoked: executionEvidence.provider_usage_evidence === 'CONFIRMED',
    stdout_path: outPath, stderr_path: errPath,
    stdout_sha256: evidence.stdout_sha256, stderr_sha256: evidence.stderr_sha256,
    stdout_bytes: evidence.stdout_bytes, stderr_bytes: evidence.stderr_bytes,
    input_error: evidence.stdin_error, capture_error: evidence.capture_error,
    storage_error: evidence.storage_error, termination_state: evidence.termination_state,
    termination_error: evidence.termination_error,
    outcome, tests: 'NOT_RUN', pr_url: null };
}

async function readCodexExecutionEvidence(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let sessionId = null;
  const tokenUsage = { input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, reasoning_output_tokens: 0 };
  let usageObserved = false;
  const completedCommandIds = new Set();
  let completedCommandsWithoutId = 0;
  const fileChangeStates = new Map();
  let unidentifiedFileChange = false;
  try {
    for await (const line of lines) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!sessionId && event?.type === 'thread.started')
        sessionId = codexSessionFromJsonl(line);
      if (event?.type === 'turn.completed') {
        const usage = event.usage ?? event.turn?.usage;
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
          for (const key of Object.keys(tokenUsage)) {
            const count = usage[key];
            if (!Number.isSafeInteger(count) || count < 0) continue;
            tokenUsage[key] = Math.min(Number.MAX_SAFE_INTEGER, tokenUsage[key] + count);
            if (count > 0) usageObserved = true;
          }
        }
      }
      if (event?.type === 'item.completed' && event.item?.type === 'command_execution') {
        if (typeof event.item.id === 'string' && event.item.id) completedCommandIds.add(event.item.id);
        else completedCommandsWithoutId++;
      }
      if (event?.item?.type === 'file_change' &&
          ['item.started', 'item.completed'].includes(event.type)) {
        const itemId = typeof event.item.id === 'string' && event.item.id ? event.item.id : null;
        if (!itemId) {
          unidentifiedFileChange = true;
          continue;
        }
        if (event.type === 'item.started') {
          if (!fileChangeStates.has(itemId)) fileChangeStates.set(itemId, 'IN_PROGRESS');
        } else if (event.item.status === 'completed') {
          fileChangeStates.set(itemId, 'COMPLETED');
        } else if (event.item.status === 'failed') {
          fileChangeStates.set(itemId, 'FAILED');
        } else {
          fileChangeStates.set(itemId, 'UNKNOWN');
        }
      }
    }
  } finally { lines.close(); }
  const fileChangeValues = [...fileChangeStates.values()];
  const fileChangeToolCount = fileChangeStates.size + Number(unidentifiedFileChange);
  const toolExecutionCount = completedCommandIds.size + completedCommandsWithoutId + fileChangeToolCount;
  const fileChangeCompleted = fileChangeValues.filter(value => value === 'COMPLETED').length;
  const fileChangeFailed = fileChangeValues.filter(value => value === 'FAILED').length;
  const fileChangeIncomplete = fileChangeValues.filter(value =>
    value === 'IN_PROGRESS' || value === 'UNKNOWN').length + Number(unidentifiedFileChange);
  const fileChangeKinds = Number(fileChangeCompleted > 0) + Number(fileChangeFailed > 0) +
    Number(fileChangeIncomplete > 0);
  const fileChangeEvidence = fileChangeKinds > 1 ? 'MIXED'
    : fileChangeCompleted > 0 ? 'COMPLETED'
      : fileChangeFailed > 0 ? 'FAILED'
        : fileChangeIncomplete > 0 ? 'INCOMPLETE' : 'UNKNOWN';
  return { session_id: sessionId,
    provider_usage_evidence: usageObserved ? 'CONFIRMED' : 'UNKNOWN',
    model_activity_evidence: tokenUsage.output_tokens > 0 || tokenUsage.reasoning_output_tokens > 0
      ? 'CONFIRMED' : 'UNKNOWN',
    token_usage: usageObserved ? tokenUsage : null,
    tool_execution_evidence: toolExecutionCount > 0 ? 'OBSERVED' : 'UNKNOWN',
    tool_execution_count: toolExecutionCount,
    // CLI file_change events are separate from the filesystem/Git diff.
    file_change_tool_evidence: fileChangeEvidence,
    file_change_tool_completed_count: fileChangeCompleted,
    file_change_tool_failed_count: fileChangeFailed,
    file_change_tool_incomplete_count: fileChangeIncomplete };
}

export function changedPaths(worktree, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('WORKSPACE_SOURCE_SHA_INVALID');
  const diff = execFileSync('git', ['-C', worktree, 'diff', '--name-only', '-z', '--no-renames', sourceSha, '--'], {
    encoding: 'buffer', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '-z'], {
    encoding: 'buffer', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set([
    ...diff.toString('utf8').split('\0'),
    ...untracked.toString('utf8').split('\0'),
  ].filter(Boolean))].sort();
}

async function diffDigest(worktree, paths) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    if (path.split(/[\\/]/).some(part => part === '..')) throw new Error('WORKSPACE_PATH_TRAVERSAL');
    const full = resolve(worktree, path);
    const rel = relative(resolve(worktree), full);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('WORKSPACE_PATH_ESCAPE');
    hash.update(path, 'utf8'); hash.update('\0');
    try {
      const info = lstatSync(full);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('WORKSPACE_NONREGULAR_CHANGED_FILE');
      for await (const chunk of createReadStream(full)) hash.update(chunk);
    } catch (error) {
      if (error.code === 'ENOENT') hash.update('DELETED\0'); else throw error;
    }
  }
  return hash.digest('hex');
}

function writeResult(path, result) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  if (existsSync(path)) throw new Error('EXECUTOR_RESULT_ALREADY_EXISTS_NO_OVERWRITE');
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(result, null, 2)); fsyncSync(fd); }
  catch (error) { closeSync(fd); try { unlinkSync(temp); } catch {} throw error; }
  closeSync(fd);
  try { renameSync(temp, path); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

export async function runExecutorOnce(config, deps = {}) {
  const activeLock = acquireActiveLock(config.spool_dir, deps);
  let preserveActiveLock = false;
  try {
    const picked = takeNextRequest(config.spool_dir);
    if (!picked) return { state: 'IDLE', model_invoked: false };
    const currentSid = deps.currentSid ?? (deps.readCurrentSid || getWindowsSid)();
    const request = picked.request;
    updateActiveLock(activeLock, 'CLAIMED_NO_MODEL', request);
    const verified = validateCodexExecutorRequest(request);
    const configGate = validateExecutorConfig(config, currentSid, deps.environment || process.env);
    const resultPath = executorResultPath(config.spool_dir, request.job.request_id, request.attempt_id);
    const waitForEligibility = reasons => {
      let releaseReason = null;
      try { releasePreModelAttempt(config, picked, request); }
      catch (error) {
        releaseReason = String(error.code || 'PREFLIGHT_EFFECT_READBACK_UNKNOWN')
          .replace(/[^A-Z0-9_]/gi, '_').slice(0, 96).toUpperCase();
      }
      return { state: 'WAITING', reasons: releaseReason ? [...reasons, releaseReason] : reasons,
        model_invoked: false, request_id: request.job.request_id, attempt_id: request.attempt_id };
    };
    if (!configGate.ready) {
      return waitForEligibility(configGate.reasons);
    }
    const gate = codexExecutionGate(request.job, config);
    if (!gate.allowed) {
      return waitForEligibility(gate.reasons);
    }
    try {
      assertNoGitHubTokenEnvironment();
      await (deps.qualifyCodex || qualifyCodex)(config);
    }
    catch (error) {
      const reason = String(error.code || error.message || 'PREFLIGHT_FAILED').slice(0, 96);
      return waitForEligibility([reason]);
    }
    const bundleRoot = resolve(config.spool_dir, 'bundles');
    const bundlePath = resolve(request.bundle_path);
    const bundleRel = relative(bundleRoot, bundlePath);
    if (bundleRel.startsWith(`..${sep}`) || bundleRel === '..' || isAbsolute(bundleRel))
      throw new Error('EXECUTOR_BUNDLE_PATH_ESCAPE');
    const bundleInfo = lstatSync(bundlePath);
    if (!bundleInfo.isFile() || bundleInfo.isSymbolicLink()) throw new Error('EXECUTOR_BUNDLE_NOT_REGULAR_FILE');
    const bundleSha = await digestFile(bundlePath);
    if (bundleSha !== request.bundle_sha256) throw new Error('EXECUTOR_SOURCE_BUNDLE_HASH_MISMATCH');
    const root = resolve(config.workspace_root);
    const worktree = resolve(root, request.attempt_id);
    const rel = relative(root, worktree);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('WORKTREE_PATH_ESCAPE');
    mkdirSync(root, { recursive: true });
    if (existsSync(worktree)) throw new Error('WORKTREE_ALREADY_EXISTS_NO_REUSE');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', request.bundle_path, worktree], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024,
    });
    execFileSync('git', ['-C', worktree, 'checkout', '--quiet', '--detach', verified.job.source_sha], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 1024 * 1024,
    });
    const actualHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 32768,
    }).trim();
    if (actualHead !== verified.job.source_sha) throw new Error('WORKTREE_SOURCE_SHA_MISMATCH');
    const evidenceDir = join(config.spool_dir, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    updateActiveLock(activeLock, 'MODEL_RUNNING', request);
    preserveActiveLock = true;
    const execution = await (deps.runCodex || runCodex)(request, config, worktree, evidenceDir, {
      onProcessSpawn: modelPid => updateActiveLock(activeLock, 'MODEL_RUNNING', request, modelPid),
    });
    const terminationUnknown = ['ORPHAN_POSSIBLE', 'TERMINATION_REQUESTED', 'TERMINATION_UNCONFIRMED']
      .includes(execution.termination_state);
    if (terminationUnknown) {
      updateActiveLock(activeLock, 'MODEL_TERMINATION_UNCONFIRMED', request);
    } else {
      updateActiveLock(activeLock, 'MODEL_FINISHED', request);
      preserveActiveLock = false;
    }
    const changed = changedPaths(worktree, verified.job.source_sha);
    const allowed = new Set(verified.job.write_paths);
    const outOfScope = changed.filter(path => !allowed.has(path.replaceAll('\\', '/')));
    const result = {
      schema: 1, kind: 'codex_plan', request_id: request.job.request_id,
      attempt_id: request.attempt_id, source_sha: request.job.source_sha,
      fingerprint: request.fingerprint, exit_code: execution.exit_code,
      outcome: outOfScope.length ? 'WRITE_SCOPE_VIOLATION' : execution.outcome,
      session_id: execution.session_id, diff_sha256: await diffDigest(worktree, changed),
      changed_paths: changed, out_of_scope_paths: outOfScope,
      stdout_sha256: execution.stdout_sha256, stderr_sha256: execution.stderr_sha256,
      stdout_bytes: execution.stdout_bytes, stderr_bytes: execution.stderr_bytes,
      session_started: execution.session_started ?? (typeof execution.session_id === 'string'),
      provider_usage_evidence: execution.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: execution.model_activity_evidence ?? 'UNKNOWN',
      token_usage: execution.token_usage ?? null,
      tool_execution_evidence: execution.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: execution.tool_execution_count ?? 0,
      file_change_tool_evidence: execution.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: execution.file_change_tool_completed_count ?? 0,
      file_change_tool_failed_count: execution.file_change_tool_failed_count ?? 0,
      file_change_tool_incomplete_count: execution.file_change_tool_incomplete_count ?? 0,
      input_error: execution.input_error, capture_error: execution.capture_error,
      storage_error: execution.storage_error, termination_state: execution.termination_state,
      termination_error: execution.termination_error,
      tests: 'NOT_RUN', pr_url: null, observed_at: new Date().toISOString(),
    };
    result.model_invoked = result.provider_usage_evidence === 'CONFIRMED';
    writeResult(resultPath, result);
    if (!terminationUnknown) updateActiveLock(activeLock, 'RESULT_SAVED', request);
    return { state: 'RESULT_SAVED', model_invoked: result.model_invoked, request_id: result.request_id,
      attempt_id: result.attempt_id, outcome: result.outcome, result_path: resultPath };
  } finally {
    // If the process is terminated externally, this finally block cannot run;
    // or its descendants cannot be confirmed dead, the lock remains a conflict
    // stop signal until an explicit OS readback can establish safe recovery.
    if (!preserveActiveLock) {
      try { (deps.removeFile || unlinkSync)(activeLock); }
      catch { /* keep any uncertain lock for explicit operator readback */ }
    }
  }
}

// Release only an attempt that is proven to be before model execution. This
// allows a later native poll to reevaluate the same immutable request after a
// recoverable login miss. Any ambiguous artifact retains the claim as a
// no-replay barrier.
function releasePreModelAttempt(config, picked, request) {
  const requestId = request?.job?.request_id;
  const attemptId = request?.attempt_id;
  const expectedClaimPath = join(config.spool_dir, 'claims', `${requestId}-${attemptId}.json`);
  if (!/^[A-Z][A-Z0-9_-]{7,79}$/.test(requestId || '') || !/^[a-f0-9-]{36}$/.test(attemptId || '') ||
      picked?.claim_path !== expectedClaimPath ||
      picked?.path !== join(config.spool_dir, 'requests', `${requestId}-${attemptId}.json`))
    throw new Error('PREFLIGHT_CLAIM_IDENTITY_UNKNOWN');

  const activePath = join(config.spool_dir, 'locks', 'executor.active');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  if (active?.schema !== 1 || active.pid !== process.pid || active.phase !== 'CLAIMED_NO_MODEL' ||
      active.request_id !== requestId || active.attempt_id !== attemptId || active.model_pid !== null)
    throw new Error('PREFLIGHT_EXECUTOR_OWNERSHIP_UNKNOWN');

  if (existsSync(executorResultPath(config.spool_dir, requestId, attemptId)))
    throw new Error('PREFLIGHT_RESULT_ALREADY_EXISTS');
  const workspaceRoot = resolve(config.workspace_root);
  const worktree = resolve(workspaceRoot, attemptId);
  const worktreeRel = relative(workspaceRoot, worktree);
  if (worktreeRel.startsWith(`..${sep}`) || worktreeRel === '..' || isAbsolute(worktreeRel) || existsSync(worktree))
    throw new Error('PREFLIGHT_WORKTREE_EFFECT_UNKNOWN');

  const currentRequest = JSON.parse(readFileSync(picked.path, 'utf8'));
  validateCodexExecutorRequest(currentRequest);
  if (JSON.stringify(currentRequest) !== JSON.stringify(request))
    throw new Error('PREFLIGHT_REQUEST_CHANGED');

  const expectedClaim = JSON.stringify({ request_id: requestId, attempt_id: attemptId,
    source_sha: request.source_sha, fingerprint: request.fingerprint });
  if (readFileSync(expectedClaimPath, 'utf8') !== expectedClaim)
    throw new Error('PREFLIGHT_CLAIM_CHANGED');

  const retryPath = join(config.spool_dir, 'locks', `retrigger-${requestId}-${attemptId}.json`);
  let retryBytes = null;
  try { retryBytes = readFileSync(retryPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (retryBytes !== null) {
    let retry;
    try { retry = JSON.parse(retryBytes); } catch { throw new Error('PREFLIGHT_RETRY_MARKER_INVALID'); }
    if (retry?.schema !== 1 || retry.request_id !== requestId || retry.attempt_id !== attemptId ||
        retry.fingerprint !== request.fingerprint)
      throw new Error('PREFLIGHT_RETRY_MARKER_IDENTITY_MISMATCH');
    unlinkSync(retryPath);
  }
  unlinkSync(expectedClaimPath);
}

async function main() {
  const path = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const result = await runExecutorOnce(config);
  console.log(`CODEX_EXECUTOR_${result.state}${result.reasons ? ':' + result.reasons.join(',') : ''}`);
  if (result.state === 'BLOCKED') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(`CODEX_EXECUTOR_BLOCKED:${String(error.code || error.message || error).slice(0, 160)}`); process.exitCode = 2; });
