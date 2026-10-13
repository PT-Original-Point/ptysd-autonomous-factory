#!/usr/bin/env node
// PTYSD native issue bridge. No listener, MCP, model router, or privileged daemon.
// Public GitHub issue comments are only pointers to immutable, reviewed source.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyOpenCodeV2, validateV2Model, buildV2ReadOnlyConfig, buildV2ReadOnlyArgs } from './opencode-v2.mjs';
import { runV2Readiness } from './v2-readiness.mjs';

export const PROJECT = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
export const REPO = 'PT-Original-Point/ptysd-autonomous-factory';
export const JOB_MARKER = 'PTYSD_NATIVE_JOB_V1\n';
export const RECEIPT_MARKER = 'PTYSD_NATIVE_RECEIPT_V1\n';
export const ISSUE_TITLE = '[PTYSD-NATIVE] OpenCode dispatch and receipts';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const V1_KEYS = ['schema', 'project_id', 'host', 'request_id', 'kind', 'source_sha', 'spec_path', 'spec_sha256'];
const V2_KEYS = [...V1_KEYS, 'model', 'variant'];
const RECEIPT_STATES = new Set(['STARTED', 'FINISHED', 'BLOCKED']);
const terminalStates = new Set(['FINISHED', 'BLOCKED']);
const commandTimeout = 60000;
function digest(data) { return createHash('sha256').update(data).digest('hex'); }
export function parseJob(body) {
  if (typeof body !== 'string' || body.length > 5000 || !body.startsWith(JOB_MARKER)) return null;
  let obj; try { obj = JSON.parse(body.slice(JOB_MARKER.length)); } catch { return null; }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') return null;
  const keys = obj.schema === 1 ? V1_KEYS : obj.schema === 2 ? V2_KEYS : null;
  if (!keys || JSON.stringify(Object.keys(obj).sort()) !== JSON.stringify(keys.slice().sort())) return null;
  if (obj.project_id !== PROJECT || !REQUEST.test(obj.request_id)) return null;
  if (typeof obj.host !== 'string' || !/^[A-Z0-9-]{3,64}$/.test(obj.host) || !SHA.test(obj.source_sha)) return null;
  if (obj.schema === 1 && (obj.kind === 'ping' || obj.kind === 'native_preflight' || obj.kind === 'native_v2_qualify')) {
    if (obj.spec_path !== null || obj.spec_sha256 !== null) return null;
    return obj;
  }
  // Never allow a model operation without an exact reviewed model + reasoning variant.
  // V1 opencode_plan without these fields is deliberately retired (no live V1 plan job).
  if (obj.schema !== 2 || obj.kind !== 'opencode_plan') return null;
  if (typeof obj.spec_path !== 'string' || !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(obj.spec_path)) return null;
  if (typeof obj.spec_sha256 !== 'string' || !HASH.test(obj.spec_sha256)) return null;
  if (!validateV2Model(obj.model, obj.variant)) return null;
  return obj;
}
export function parseReceipt(body) {
  if (typeof body !== 'string' || body.length > 5000 || !body.startsWith(RECEIPT_MARKER)) return null;
  try {
    const o = JSON.parse(body.slice(RECEIPT_MARKER.length));
    if (typeof o?.request_id !== 'string' || !REQUEST.test(o.request_id) ||
        !RECEIPT_STATES.has(o.state) || typeof o.attempt_id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(o.attempt_id)) return null;
    return o;
  } catch { return null; }
}
export function selectNext(comments, dispatchers, workerLogin, host, liveMainSha = null) {
  const jobs = new Map();
  const receipts = new Map();
  for (const c of comments) {
    const login = c.user?.login;
    const j = parseJob(c.body);
    if (j && dispatchers.includes(login) && j.host.toUpperCase() === host.toUpperCase()) {
      if (!jobs.has(j.request_id)) jobs.set(j.request_id, { job: j, content: c.body, id: c.id, duplicate: false });
      else if (jobs.get(j.request_id).content !== c.body) jobs.get(j.request_id).duplicate = true;
    }
    const r = parseReceipt(c.body);
    if (r && login === workerLogin) {
      if (!receipts.has(r.request_id)) receipts.set(r.request_id, []);
      receipts.get(r.request_id).push(r);
    }
  }
  for (const [, v] of jobs) {
    const r = receipts.get(v.job.request_id) || [];
    if (v.duplicate || r.some(x => terminalStates.has(x.state)) || r.some(x => x.state === 'STARTED')) continue;
    // A stale unsigned/unclaimed job must not starve a newer exact-main task.
    if (liveMainSha !== null && v.job.source_sha !== liveMainSha) continue;
    return { job: v.job, id: v.id, originalBody: v.content };
  }
  return null;
}
function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: commandTimeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}
function api(uri, extras = []) { return JSON.parse(gh(['api', uri, ...extras])); }
function issueComments(config) {
  const raw = JSON.parse(gh(['api', `repos/${REPO}/issues/${config.issue}/comments?per_page=100`, '--paginate', '--slurp']));
  return raw.flat().filter(c => typeof c?.id === 'number').sort((a, b) => a.id - b.id);
}
function writeReceipt(config, data, workerLogin) {
  const body = RECEIPT_MARKER + JSON.stringify(data);
  const temp = join(config.state_dir, `comment-${randomUUID()}.txt`);
  writeFileSync(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { gh(['issue', 'comment', String(config.issue), '-R', REPO, '--body-file', temp]); }
  finally { rmSync(temp, { force: true }); }
  const matched = issueComments(config).some(c => c.user?.login === workerLogin && c.body === body);
  if (!matched) throw new Error('RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION');
}
function atomicJSON(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function guardConfig(c) {
  if (c.repo !== REPO || c.project_id !== PROJECT || c.host.toUpperCase() !== hostname().toUpperCase())
    throw new Error('WRONG_PROJECT_OR_HOST');
  if (!Number.isSafeInteger(c.issue) || c.issue < 1) throw new Error('INVALID_ISSUE');
  if (!Array.isArray(c.dispatchers) || !c.dispatchers.length || !c.dispatchers.every(x => /^[a-zA-Z0-9-]{1,39}$/.test(x)))
    throw new Error('INVALID_TRUSTED_AUTHOR_SET');
  for (const p of ['workspace', 'state_dir']) {
    if (typeof c[p] !== 'string') throw new Error(`INVALID_${p.toUpperCase()}_TYPE`);
    const rel = relative(resolve(homedir()), resolve(c[p]));
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw new Error(`INVALID_${p.toUpperCase()}_NOT_UNDER_HOME`);
  }
  if (!existsSync(c.workspace) || !statSync(c.workspace).isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
  if (c.allowed_models !== undefined) {
    if (!c.allowed_models || typeof c.allowed_models !== 'object' || Array.isArray(c.allowed_models))
      throw new Error('MODEL_ALLOWLIST_INVALID');
    for (const [model, variants] of Object.entries(c.allowed_models)) {
      if (!Array.isArray(variants) || !variants.length ||
          !variants.every(v => validateV2Model(model, v))) throw new Error('MODEL_ALLOWLIST_INVALID');
    }
  }
  if (c.enable_v2_model_runs !== undefined && typeof c.enable_v2_model_runs !== 'boolean')
    throw new Error('V2_MODEL_ENABLE_FLAG_INVALID');
  mkdirSync(c.state_dir, { recursive: true });
  return c;
}
// Never put public paths, environment variables or provider credentials in a receipt.
// OpenCode's official Windows installation may expose a .cmd shim instead of .exe;
// resolve only a native binary for child_process shell=false to avoid CMD injection.
// Compatibility export for existing source tests. The file name alone never
// establishes trust: version 2.x is mandatory, rejecting V1 even if named opencode.
export function findNativeCLI(env = process.env, win = platform() === 'win32') {
  const check = qualifyOpenCodeV2(env, win);
  return { bin: check.bin, hasWrapper: false, v2_version: check.version };
}
function localEvidence(config, requestId, value) {
  const file = join(config.state_dir, `native-evidence-${requestId}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  const bytes = readFileSync(file);
  return { evidence_sha256: digest(bytes), evidence_bytes: bytes.length };
}
export function checkModelAuthorization(job, config) {
  if (job.schema !== 2 || job.kind !== 'opencode_plan') return false;
  const variants = config.allowed_models?.[job.model];
  return Array.isArray(variants) && variants.includes(job.variant);
}
function nativePreflight(config, job) {
  const cli = qualifyOpenCodeV2();
  const facts = {
    schema: 1, project_id: PROJECT, host: config.host, request_id: job.request_id,
    kind: 'native_preflight', source_sha: job.source_sha,
    node_version: process.version, platform: platform(), architecture: process.arch,
    opencode_v2_verified: cli.ready,
    native_executables_checked: cli.candidates_checked,
    model_allowlist_entries: Object.keys(config.allowed_models || {}).length,
    v2_model_execution_enabled: config.enable_v2_model_runs === true,
    cli_version: cli.version ?? 'NOT_FOUND_OR_WRONG_MAJOR', model_auth: 'NOT_TESTED',
    elevated: 'NOT_CHECKED', old_windows_services: 'NOT_CHECKED',
  };
  return { outcome: cli.ready ? 'OPENCODE_V2_VERSION_CONFIRMED_NO_MODEL_AUTH' : 'OPENCODE_V2_CLI_NOT_QUALIFIED',
    exit_code: 0, ...localEvidence(config, job.request_id, facts) };
}
function nativeV2Qualify(config, job) {
  const cli = qualifyOpenCodeV2();
  if (!cli.ready) return { outcome: 'OPENCODE_V2_CLI_NOT_QUALIFIED',
    exit_code: 43, evidence_sha256: null, evidence_bytes: 0 };
  const summary = runV2Readiness(cli.bin, config.state_dir);
  const facts = { schema: 1, project_id: PROJECT, host: config.host, kind: job.kind,
    request_id: job.request_id, source_sha: job.source_sha, v2_cli_version: cli.version,
    auth_metadata: summary.auth, model_catalog: summary.models, issues: summary.issues,
    inference_executed: false, credential_values_collected: false,
    model_execution_enabled: config.enable_v2_model_runs === true };
  const evidence = localEvidence(config, job.request_id, facts);
  const bad = summary.issues.length ||
    !summary.auth?.status?.startsWith('SAVED_ACCOUNT_') &&
    summary.auth?.status !== 'NO_SAVED_ACCOUNT_RECORDS' ||
    summary.models?.status !== 'PUBLIC_CATALOG_IDS_PARSED_NOT_USABLE_PROOF';
  return { outcome: bad ? 'V2_METADATA_INCOMPLETE_NOT_MODEL_ACCEPTANCE' :
    'V2_ZERO_TOKEN_METADATA_ONLY_NOT_MODEL_ACCEPTANCE',
    exit_code: bad ? 47 : 0, ...evidence };
}
async function runPlan(spec, config, job) {
  if (config.enable_v2_model_runs !== true) {
    return { outcome: 'V2_MODEL_EXECUTION_NOT_YET_APPROVED', exit_code: 44,
      evidence_sha256: null, evidence_bytes: 0 };
  }
  if (!checkModelAuthorization(job, config)) {
    return { outcome: 'MODEL_NOT_EXPLICITLY_ALLOWED', exit_code: 42,
      evidence_sha256: null, evidence_bytes: 0 };
  }
  const cli = qualifyOpenCodeV2();
  if (!cli.ready) return { outcome: 'OPENCODE_V2_CLI_NOT_QUALIFIED', exit_code: 43,
    evidence_sha256: null, evidence_bytes: 0 };
  // V2, not V1: ordered permissions, shell/subagent, provider/model#variant.
  // Config is private, never echoed to the GitHub Issue; no shell expansion of prompts.
  const safePolicy = JSON.stringify(buildV2ReadOnlyConfig());
  // V2 beta builds have ignored OPENCODE_CONFIG[_CONTENT] in some execution paths.
  // The documented project-local opencode.json is the authoritative V2 policy input.
  // Never overwrite unrelated project configuration or allow higher-priority .opencode.
  const configFile = join(config.workspace, 'opencode.json');
  if (existsSync(join(config.workspace, 'opencode.jsonc')) ||
      existsSync(join(config.workspace, '.opencode')))
    return { outcome: 'V2_WORKSPACE_CONFIG_CONFLICT', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  if (existsSync(configFile)) {
    if (readFileSync(configFile, 'utf8') !== safePolicy)
      return { outcome: 'V2_WORKSPACE_CONFIG_UNKNOWN', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  } else writeFileSync(configFile, safePolicy, { flag: 'wx', mode: 0o600 });
  if (readFileSync(configFile, 'utf8') !== safePolicy)
    return { outcome: 'V2_WORKSPACE_CONFIG_READBACK_FAILED', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  const args = buildV2ReadOnlyArgs(job, config.workspace, spec);
  const outFile = join(config.state_dir, `output-${job.request_id}-${randomUUID()}.jsonl`);
  // Forbid inherited config injections from silently weakening our project file.
  // Model credentials remain inherited from the same non-privileged OS user.
  const childEnv = { ...process.env };
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE'])
    delete childEnv[key];
  childEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  return await new Promise((res) => {
    const chunks = []; const errors = []; let size = 0; let killed = false;
    const cmd = spawn(cli.bin, args, { cwd: config.workspace, windowsHide: true, shell: false,
      env: childEnv });
    const cap = (arr) => (chunk) => { size += chunk.length; if (size <= 2 * 1024 * 1024) arr.push(Buffer.from(chunk));
      else { killed = true; killTree(cmd); } };
    cmd.stdout.on('data', cap(chunks)); cmd.stderr.on('data', cap(errors));
    const timer = setTimeout(() => { killed = true; killTree(cmd); }, 600000);
    cmd.on('error', (err) => { errors.push(Buffer.from(err.code || 'SPAWN_ERROR')); });
    cmd.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks); const stderr = Buffer.concat(errors);
      writeFileSync(outFile, Buffer.concat([stdout, Buffer.from('\n--- STDERR ---\n'), stderr]), { mode: 0o600 });
      res({ exit_code: code ?? -1, outcome: killed ? 'TIMEOUT_OR_TOO_LARGE' : code === 0 ? 'OPENCODE_V2_EXIT_0_UNTRUSTED' : 'OPENCODE_V2_FAILED',
        evidence_sha256: digest(readFileSync(outFile)), evidence_bytes: statSync(outFile).size });
    });
  });
}
function killTree(child) {
  if (!child.pid) return;
  try {
    if (platform() === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, windowsHide: true });
    else child.kill('SIGKILL');
  } catch { try { child.kill(); } catch { /* already exited */ } }
}
function readSpec(job) {
  const b = api(`repos/${REPO}/contents/${job.spec_path}?ref=${job.source_sha}`);
  if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('SPEC_UNREADABLE');
  const bytes = Buffer.from(b.content.replace(/\s+/g, ''), 'base64');
  if (digest(bytes) !== job.spec_sha256) throw new Error('SPEC_HASH_MISMATCH');
  return bytes.toString('utf8');
}
export function receipt(requestId, attemptId, state, job, result = null) {
  return { schema: 1, project_id: PROJECT, host: job.host, request_id: requestId,
    attempt_id: attemptId, state, kind: job.kind, source_sha: job.source_sha,
    outcome: result?.outcome ?? (state === 'STARTED' ? 'DISPATCH_ACK_NOT_ACCEPTANCE' : 'UNKNOWN'),
    exit_code: result?.exit_code ?? null,
    evidence_sha256: result?.evidence_sha256 ?? null,
    evidence_bytes: result?.evidence_bytes ?? null,
    ...(job.schema === 2 ? { model: job.model, variant: job.variant } : {}) };
}
async function main() {
  const i = process.argv.indexOf('--config');
  if (i === -1 || !process.argv[i + 1]) throw new Error('USAGE: --config config.json');
  const config = guardConfig(JSON.parse(readFileSync(resolve(process.argv[i + 1]), 'utf8').replace(/^\uFEFF/, '')));
  const me = api('user').login;
  if (!me) throw new Error('GH_AUTH_REQUIRED');
  const issue = api(`repos/${REPO}/issues/${config.issue}`);
  if (issue.title !== ISSUE_TITLE || issue.state !== 'open' || issue.pull_request) throw new Error('ISSUE_IDENTITY_MISMATCH');
  const comments = issueComments(config);
  // Replay terminal receipt only when local exact same-attempt evidence exists; NEVER repeat the effect.
  for (const c of comments) {
    if (c.user?.login !== me) continue;
    const s = parseReceipt(c.body);
    if (!s || s.state !== 'STARTED') continue;
    const hasTerminal = comments.some(v => v.user?.login === me && (r => r?.request_id === s.request_id && r?.attempt_id === s.attempt_id && terminalStates.has(r.state))(parseReceipt(v.body)));
    if (hasTerminal) continue;
    const path = join(config.state_dir, `result-${s.request_id}-${s.attempt_id}.json`);
    if (existsSync(path)) {
      const result = JSON.parse(readFileSync(path, 'utf8'));
      if (result.request_id !== s.request_id || result.attempt_id !== s.attempt_id) throw new Error('LOCAL_RECEIPT_IDENTITY_MISMATCH');
      writeReceipt(config, result.terminal, me);
      console.log(`RECOVERED_TERMINAL_${s.request_id}`);
      return;
    }
    console.log(`AMBIGUOUS_STARTED_${s.request_id}: NO_REEXECUTION`); return;
  }
  const head = api(`repos/${REPO}/git/ref/heads/main`).object?.sha;
  if (!SHA.test(head || '')) throw new Error('MAIN_HEAD_UNREADABLE');
  const next = selectNext(comments, config.dispatchers, me, config.host, head);
  if (!next) { console.log('NO_DELTA_NO_LLM'); return; }
  const job = next.job;
  if (job.source_sha !== head) { console.log(`STALE_SHA_SKIP_${job.request_id}`); return; }
  // Check full issue comment remains immutable since selection. Edits/races abort the lane.
  const original = api(`repos/${REPO}/issues/comments/${next.id}`);
  if (original.body !== next.originalBody)
    throw new Error('DISPATCH_COMMENT_CHANGED');
  let spec = null;
  if (job.kind === 'opencode_plan') spec = readSpec(job);
  const attemptId = randomUUID();
  const start = receipt(job.request_id, attemptId, 'STARTED', job);
  writeReceipt(config, start, me);
  let result;
  if (job.kind === 'ping') result = { outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0, evidence_sha256: null, evidence_bytes: 0 };
  else if (job.kind === 'native_preflight') result = nativePreflight(config, job);
  else if (job.kind === 'native_v2_qualify') result = nativeV2Qualify(config, job);
  else { try { result = await runPlan(spec, config, job); }
    catch (err) { result = { outcome: `EXECUTION_ERROR_${String(err.code || 'UNKNOWN').slice(0, 36)}`, exit_code: -1, evidence_sha256: null, evidence_bytes: 0 }; } }
  const terminal = receipt(job.request_id, attemptId, result.exit_code === 0 ? 'FINISHED' : 'BLOCKED', job, result);
  const terminalPath = join(config.state_dir, `result-${job.request_id}-${attemptId}.json`);
  atomicJSON(terminalPath, { request_id: job.request_id, attempt_id: attemptId, terminal });
  writeReceipt(config, terminal, me);
  console.log(`${terminal.state}_${job.request_id}_${terminal.outcome}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error(`NATIVE_BRIDGE_BLOCKED: ${String(err.message || err).slice(0, 140)}`); process.exitCode = 2; });
}
