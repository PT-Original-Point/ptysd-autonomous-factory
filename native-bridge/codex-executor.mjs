#!/usr/bin/env node
// On-demand Codex Executor. Run only from a separately registered, Limited
// Windows Task Scheduler identity. It has no GitHub Publisher code or token.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync,
  openSync, closeSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { codexExecutionGate, buildCodexExecArgs, codexSessionFromJsonl,
  codexRunOutcome, executorResultPath, validateCodexExecutorRequest } from './codex-continuation.mjs';

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
    codex_executor_task_verified: config?.codex_executor_task_verified,
    codex_executor_is_standard_user: config?.codex_executor_is_standard_user,
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

function acquireActiveLock(spoolDir) {
  const lockDir = join(spoolDir, 'locks');
  mkdirSync(lockDir, { recursive: true });
  const path = join(lockDir, 'executor.active');
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); fsyncSync(fd); }
  finally { closeSync(fd); }
  return path;
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

function killTree(child) {
  if (!child.pid) return;
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true, shell: false, timeout: 15000, stdio: 'ignore' }); }
  catch { try { child.kill(); } catch { /* process already closed */ } }
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

async function runCodex(request, config, worktree, evidenceDir) {
  const job = request.job;
  const args = buildCodexExecArgs(job, worktree);
  const outPath = join(evidenceDir, `${job.request_id}-${request.attempt_id}.stdout.jsonl`);
  const errPath = join(evidenceDir, `${job.request_id}-${request.attempt_id}.stderr.txt`);
  const stdout = createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
  const stderr = createWriteStream(errPath, { flags: 'wx', mode: 0o600 });
  // Do not expose a Publisher's stored gh configuration to the model process.
  const { env } = buildCodexChildEnvironment(request, evidenceDir);
  let writeError = null;
  const child = spawn(config.codex_executable, args, {
    cwd: worktree, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const monitor = stream => stream.on('error', error => { writeError ||= error; killTree(child); });
  monitor(stdout); monitor(stderr);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') writeError ||= error; });
  const stdoutDone = pipeline(child.stdout, stdout).catch(error => { writeError ||= error; killTree(child); });
  const stderrDone = pipeline(child.stderr, stderr).catch(error => { writeError ||= error; killTree(child); });
  let spawnError = null;
  child.on('error', error => { spawnError = error; });
  child.stdin.end(validateCodexExecutorRequest(request).spec);
  const exit = await new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })));
  await Promise.all([stdoutDone, stderrDone]);
  if (spawnError) throw spawnError;
  if (writeError) throw new Error('CODEX_EVIDENCE_WRITE_FAILED_PROCESS_TERMINATED');
  const sessionId = await findSession(outPath);
  return { exit_code: Number.isInteger(exit.code) ? exit.code : null, signal: exit.signal || null,
    session_id: sessionId, stdout_path: outPath, stderr_path: errPath,
    stdout_sha256: await digestFile(outPath), stderr_sha256: await digestFile(errPath),
    stdout_bytes: statSync(outPath).size, stderr_bytes: statSync(errPath).size,
    outcome: codexRunOutcome(exit.code, sessionId), tests: 'NOT_RUN', pr_url: null };
}

async function findSession(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const found = codexSessionFromJsonl(line);
      if (found) return found;
    }
    return null;
  } finally { lines.close(); }
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
  const currentSid = deps.currentSid || getWindowsSid();
  const activeLock = acquireActiveLock(config.spool_dir);
  try {
    const picked = takeNextRequest(config.spool_dir);
    if (!picked) return { state: 'IDLE', model_invoked: false };
    const request = picked.request;
    const verified = validateCodexExecutorRequest(request);
    const configGate = validateExecutorConfig(config, currentSid, deps.environment || process.env);
    const resultPath = executorResultPath(config.spool_dir, request.job.request_id, request.attempt_id);
    const blocked = (code, reasons = []) => ({
      schema: 1, kind: 'codex_plan', request_id: request.job.request_id,
      attempt_id: request.attempt_id, source_sha: request.job.source_sha,
      fingerprint: request.fingerprint, exit_code: 45, outcome: code,
      session_id: null, diff_sha256: null, changed_paths: [], out_of_scope_paths: [],
      stdout_sha256: createHash('sha256').update('').digest('hex'),
      stderr_sha256: createHash('sha256').update(reasons.join(',')).digest('hex'),
      stdout_bytes: 0, stderr_bytes: Buffer.byteLength(reasons.join(',')),
      tests: 'NOT_RUN', pr_url: null, model_invoked: false, observed_at: new Date().toISOString(),
    });
    if (!configGate.ready) {
      writeResult(resultPath, blocked('CODEX_EXECUTOR_PREFLIGHT_BLOCKED', configGate.reasons));
      return { state: 'BLOCKED', reasons: configGate.reasons, model_invoked: false, result_path: resultPath };
    }
    const gate = codexExecutionGate(request.job, config);
    if (!gate.allowed) {
      writeResult(resultPath, blocked('CODEX_EXECUTION_GATE_BLOCKED', gate.reasons));
      return { state: 'BLOCKED', reasons: gate.reasons, model_invoked: false, result_path: resultPath };
    }
    try { assertNoGitHubTokenEnvironment(); await qualifyCodex(config); }
    catch (error) {
      const reason = String(error.code || error.message || 'PREFLIGHT_FAILED').slice(0, 96);
      writeResult(resultPath, blocked(`CODEX_EXECUTOR_PREFLIGHT_${reason}`, [reason]));
      return { state: 'BLOCKED', reasons: [reason], model_invoked: false, result_path: resultPath };
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
    const execution = await runCodex(request, config, worktree, evidenceDir);
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
      tests: 'NOT_RUN', pr_url: null, observed_at: new Date().toISOString(),
    };
    result.model_invoked = true;
    writeResult(resultPath, result);
    return { state: 'RESULT_SAVED', model_invoked: true, request_id: result.request_id,
      attempt_id: result.attempt_id, outcome: result.outcome, result_path: resultPath };
  } finally {
    // If the process is terminated externally, this finally block cannot run;
    // the stale lock is deliberately a stop signal, not permission to replay.
    try { (deps.removeFile || unlinkSync)(activeLock); }
    catch { /* keep any uncertain lock for explicit operator readback */ }
  }
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
