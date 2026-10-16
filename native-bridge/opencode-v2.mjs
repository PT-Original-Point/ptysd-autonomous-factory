// OpenCode V2 CLI qualification and explicitly scoped coding contract.
// No package installation, authentication, model invocation, or OS mutation here.
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, isAbsolute, normalize, resolve, relative } from 'node:path';
import { homedir, platform } from 'node:os';
import { createInterface } from 'node:readline';
import { isProtectedNativeBridgePath, isSensitiveWorkspacePathSegment, parseWorkspaceWritePath,
  workspacePathIdentity } from './windows-executor.mjs';

const SEMVER_V2 = /^(?:opencode(?:2)?\s+)?v?(2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i;
const MODEL_ID = /^[a-z][a-z0-9_-]{1,39}\/[A-Za-z0-9_./:-]{1,150}$/;
const VARIANT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
export function validateV2Model(model, variant) {
  return typeof model === 'string' && MODEL_ID.test(model) && !model.includes('..') &&
    typeof variant === 'string' && VARIANT_ID.test(variant);
}
export function parseOpenCodeV2Version(output) {
  if (typeof output !== 'string') return null;
  const m = SEMVER_V2.exec(output.trim());
  return m ? m[1] : null;
}
function regularFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
export function discoverV2Executables(env = process.env, win = platform() === 'win32') {
  const splitter = win ? ';' : delimiter;
  const dirs = String(env.PATH || env.Path || '').split(splitter).filter(Boolean);
  const userHome = env.USERPROFILE || env.HOME || homedir();
  if (userHome) dirs.unshift(join(userHome, '.opencode', 'bin'));
  // Explicit local configuration is trusted only when absolute; no GitHub job can set it.
  const named = win ? ['opencode2.exe', 'opencode.exe'] : ['opencode2', 'opencode'];
  const found = []; const seen = new Set();
  if (typeof env.PTYSD_OPENCODE_V2_EXE === 'string' && isAbsolute(env.PTYSD_OPENCODE_V2_EXE)) {
    const p = normalize(env.PTYSD_OPENCODE_V2_EXE);
    if (regularFile(p)) { seen.add(p.toLowerCase()); found.push(p); }
  }
  for (const dir of dirs) {
    for (const name of named) {
      const path = join(dir, name), key = path.toLowerCase();
      if (seen.has(key)) continue;
      if (regularFile(path)) { seen.add(key); found.push(path); }
    }
  }
  return found;
}
export function qualifyOpenCodeV2(env = process.env, win = platform() === 'win32', runVersion = execFileSync) {
  const candidates = discoverV2Executables(env, win);
  for (const bin of candidates) {
    try {
      const raw = runVersion(bin, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true });
      const version = parseOpenCodeV2Version(raw);
      if (version) return { ready: true, bin, version, candidates_checked: candidates.length };
    } catch { /* An unavailable or untrusted executable is not an accepted V2 CLI. */ }
  }
  return { ready: false, bin: null, version: null, candidates_checked: candidates.length };
}
/**
 * V2 edit policy for the separately scheduled coding executor. The caller must
 * independently verify that executor's Windows identity and source worktree;
 * agent permissions are not an OS filesystem or credential sandbox.
 */
export function validateV2ScopedEditPaths(editableFiles) {
  if (!Array.isArray(editableFiles) || editableFiles.length < 1)
    throw new Error('SCOPED_EDIT_FILE_ALLOWLIST_INVALID');
  const allowed = new Set();
  const entries = [];
  for (const file of editableFiles) {
    const parsedPath = parseWorkspaceWritePath(file);
    if (parsedPath.error === 'INVALID')
      throw new Error('SCOPED_EDIT_FILE_PATH_INVALID');
    if (parsedPath.error === 'TRAVERSAL')
      throw new Error('SCOPED_EDIT_FILE_TRAVERSAL');
    const parts = parsedPath.parts;
    if (parts.some(p => /[\[\]{}]/.test(p)))
      throw new Error('SCOPED_EDIT_FILE_PATH_INVALID');
    // The model is not allowed to edit control-plane, Git identity, or auth inputs.
    if (parts.some(p => /^\.(?:git|github|opencode)$/i.test(p)) ||
        ['governance', 'runs'].includes(parts[0].toLowerCase()) ||
        isProtectedNativeBridgePath(parts.join('/')) ||
        parts.some(isSensitiveWorkspacePathSegment))
      throw new Error('SCOPED_EDIT_CONTROL_OR_SECRET_PATH');
    // Candidate jobs execute on Windows even when the contract is parsed in
    // Linux CI. Windows aliases case-different names to the same file.
    const key = workspacePathIdentity(file, true);
    if (allowed.has(key)) throw new Error('SCOPED_EDIT_DUPLICATE_PATH');
    allowed.add(key);
    entries.push({ file, parts });
  }
  return entries;
}

export function buildV2ScopedEditConfig(workspace, editableFiles) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace))
    throw new Error('SCOPED_EDIT_WORKSPACE_MUST_BE_ABSOLUTE');
  const entries = validateV2ScopedEditPaths(editableFiles);
  const root = resolve(workspace);
  const samePath = (left, right) => platform() === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
  let physicalRoot;
  try { physicalRoot = realpathSync(root); }
  catch { throw new Error('SCOPED_EDIT_WORKSPACE_UNVERIFIABLE'); }
  if (!samePath(physicalRoot, root))
    throw new Error('SCOPED_EDIT_WORKSPACE_REPARSE_POINT');
  const allowed = new Set();
  for (const { file, parts } of entries) {
    const absolute = resolve(root, ...parts);
    const inside = relative(root, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new Error('SCOPED_EDIT_PATH_OUTSIDE_WORKSPACE');
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      let entry;
      try { entry = lstatSync(current); }
      catch (error) {
        if (error.code === 'ENOENT' && index === parts.length - 1) break;
        if (error.code === 'ENOENT') throw new Error('SCOPED_EDIT_PARENT_PATH_MISSING');
        throw new Error('SCOPED_EDIT_PATH_UNVERIFIABLE');
      }
      if (entry.isSymbolicLink()) throw new Error('SCOPED_EDIT_REPARSE_POINT');
      if (index < parts.length - 1 && !entry.isDirectory())
        throw new Error('SCOPED_EDIT_PARENT_NOT_DIRECTORY');
      if (index === parts.length - 1 && !entry.isFile())
        throw new Error('SCOPED_EDIT_TARGET_NOT_FILE');
      let physical;
      try { physical = realpathSync(current); }
      catch { throw new Error('SCOPED_EDIT_PATH_UNVERIFIABLE'); }
      if (!samePath(physical, current)) throw new Error('SCOPED_EDIT_REPARSE_POINT');
    }
    allowed.add(absolute.replaceAll('\\', '/'));
  }
  return {
    autoupdate: false, share: 'disabled', snapshots: false, plugins: [],
    default_agent: 'ptysd-scoped-write',
    // A late-loading agent cannot turn the shipped built-in agent into a writer.
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
      { action: 'read', resource: '*.env', effect: 'deny' },
      { action: 'read', resource: '**/*.env', effect: 'deny' },
    ],
    agents: {
      'ptysd-scoped-write': {
        mode: 'primary',
        description: 'Modify only exact operator-approved source files; no shell or network tools',
        system: 'Edit only exact allowlisted source files for the reviewed task. Do not run commands, access secrets, call subagents or tools outside the project. Explain blocked actions instead of bypassing policy.',
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
          { action: 'read', resource: '*.env', effect: 'deny' },
          { action: 'read', resource: '**/*.env', effect: 'deny' },
          ...[...allowed].map(resource => ({ action: 'edit', resource, effect: 'allow' })),
        ],
      },
    },
  };
}
export function buildV2ScopedEditArgs(job, workspace, spec) {
  if (!validateV2Model(job?.model, job?.variant)) throw new Error('INVALID_V2_MODEL_OR_VARIANT');
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('WORKSPACE_NOT_ABSOLUTE');
  if (typeof job?.request_id !== 'string' || !/^[A-Z][A-Z0-9_-]{7,79}$/.test(job.request_id))
    throw new Error('INVALID_V2_CODING_REQUEST');
  if (typeof spec !== 'string' || !spec.trim())
    throw new Error('INVALID_CODING_TASK_SPEC');
  // OpenCode V2 selects the project directory from the process cwd; `run`
  // does not accept a `--dir` flag. The caller pins cwd to this isolated workspace.
  return ['run', '--agent', 'ptysd-scoped-write', '--model', `${job.model}#${job.variant}`,
    '--format', 'json', '--title', job.request_id,
    `${spec}\n\nOnly the separately enforced exact file allowlist is mutable. Do not execute shell or request wider permissions.`];
}

function emptyRunEvidence(valid, reason = null) {
  return { valid, reason, session_id: null, session_started: false,
    provider_usage_evidence: 'UNKNOWN', model_activity_evidence: 'UNKNOWN',
    tool_execution_evidence: 'UNKNOWN', tool_execution_count: 0,
    file_change_tool_evidence: 'UNKNOWN', file_change_tool_completed_count: 0,
    file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0,
    token_usage: null, model_invoked: null, event_count: 0 };
}

function tokenField(tokens, ...names) {
  for (const name of names) {
    if (!Object.hasOwn(tokens, name)) continue;
    const value = tokens[name];
    if (!Number.isSafeInteger(value) || value < 0) return { present: true, valid: false };
    return { present: true, valid: true, value };
  }
  return { present: false, valid: true, value: 0 };
}

function eventTokens(event) {
  const tokens = event?.part?.tokens ?? event?.tokens ?? event?.part?.metadata?.tokens;
  if (tokens === undefined) return { present: false, valid: true };
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens))
    return { present: true, valid: false };
  const cache = tokens.cache ?? {};
  if (!cache || typeof cache !== 'object' || Array.isArray(cache))
    return { present: true, valid: false };
  const input = tokenField(tokens, 'input_tokens', 'input');
  const output = tokenField(tokens, 'output_tokens', 'output');
  const reasoning = tokenField(tokens, 'reasoning_output_tokens', 'reasoning');
  let cached = tokenField(cache, 'read', 'cached_input_tokens');
  if (!cached.present) cached = tokenField(tokens, 'cached_input_tokens');
  const fields = [input, output, reasoning, cached];
  if (fields.some(field => !field.valid)) return { present: true, valid: false };
  const present = fields.some(field => field.present);
  return { present, valid: true,
    usage: { input_tokens: input.present ? input.value : null,
      output_tokens: output.present ? output.value : null,
      cached_input_tokens: cached.present ? cached.value : null,
      reasoning_output_tokens: reasoning.present ? reasoning.value : null } };
}

function toolStatus(event) {
  const state = event?.part?.state ?? event?.state;
  const status = typeof state === 'string' ? state : state?.status;
  if (typeof status !== 'string') return null;
  const value = status.toLowerCase();
  if (['completed', 'complete', 'success', 'succeeded'].includes(value)) return 'completed';
  if (['failed', 'error'].includes(value)) return 'failed';
  if (['running', 'pending', 'in_progress', 'in-progress'].includes(value)) return 'incomplete';
  return null;
}

function toolName(event) {
  const value = event?.part?.tool ?? event?.part?.name ?? event?.tool;
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * Read OpenCode V2 `run --format json` output as JSONL and retain only
 * non-content evidence. A parse or capture failure discards all partial facts.
 */
export async function readOpenCodeV2RunEvidence(stdoutPath) {
  const sessions = new Set();
  const tools = new Map();
  const totals = { input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, reasoning_output_tokens: 0 };
  const tokenComplete = { input_tokens: true, output_tokens: true,
    cached_input_tokens: true, reasoning_output_tokens: true };
  let usageObserved = false;
  let usagePositive = false;
  let modelTextObserved = false;
  let eventCount = 0;
  let lineNumber = 0;
  let malformed = false;
  let overflow = false;
  let streamError = false;
  try {
    const lines = createInterface({ input: createReadStream(stdoutPath), crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { malformed = true; break; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        malformed = true; break;
      }
      eventCount++;
      const session = event.sessionID ?? event.session_id ?? event.session?.id;
      if (session !== undefined) {
        if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(session)) {
          malformed = true; break;
        }
        sessions.add(session);
      }

      const usage = event.type === 'step_finish' || event.type === 'step-finish'
        ? eventTokens(event) : { present: false, valid: true };
      if (!usage.valid) { malformed = true; break; }
      if (usage.present) {
        usageObserved = true;
        for (const key of Object.keys(totals)) {
          const value = usage.usage[key];
          if (value === null) { tokenComplete[key] = false; continue; }
          const next = totals[key] + value;
          if (!Number.isSafeInteger(next)) { overflow = true; break; }
          totals[key] = next;
          if (value > 0) usagePositive = true;
        }
        if (overflow) break;
        if ((usage.usage.output_tokens ?? 0) > 0 || (usage.usage.reasoning_output_tokens ?? 0) > 0)
          modelTextObserved = true;
      }

      if (event.type === 'text' && event.part?.type === 'text' &&
          typeof event.part.text === 'string' && event.part.text.length > 0)
        modelTextObserved = true;

      if (event.type === 'tool_use' || event.part?.type === 'tool') {
        const status = toolStatus(event);
        if (status) {
          const id = event.part?.callID ?? event.part?.call_id ?? event.part?.id ?? event.callID ?? event.id;
          const key = typeof id === 'string' && id.length > 0
            ? `call:${id}` : `line:${lineNumber}`;
          tools.set(key, { status, name: toolName(event) });
        }
      }
    }
  } catch {
    streamError = true;
  }

  if (streamError) return emptyRunEvidence(false, 'OPEN_CODE_JSONL_UNAVAILABLE');
  if (malformed) return emptyRunEvidence(false, 'OPEN_CODE_JSONL_INVALID');
  if (overflow) return emptyRunEvidence(false, 'OPEN_CODE_JSONL_TOKEN_USAGE_OVERFLOW');
  if (eventCount === 0) return emptyRunEvidence(false, 'OPEN_CODE_JSONL_EMPTY');
  if (sessions.size > 1) return emptyRunEvidence(false, 'OPEN_CODE_JSONL_MULTIPLE_SESSIONS');

  const changedTools = [...tools.values()].filter(tool =>
    ['edit', 'write', 'patch', 'apply_patch', 'multiedit'].includes(tool.name));
  const changedCounts = { completed: 0, failed: 0, incomplete: 0 };
  for (const tool of changedTools) {
    if (Object.hasOwn(changedCounts, tool.status)) changedCounts[tool.status]++;
  }
  let fileEvidence = 'UNKNOWN';
  if (changedCounts.completed && (changedCounts.failed || changedCounts.incomplete)) fileEvidence = 'MIXED';
  else if (changedCounts.completed) fileEvidence = 'COMPLETED';
  else if (changedCounts.failed) fileEvidence = 'FAILED';
  else if (changedCounts.incomplete) fileEvidence = 'INCOMPLETE';
  const providerUsage = usageObserved && usagePositive;
  const modelActivity = modelTextObserved;
  return { valid: true, reason: null, session_id: sessions.values().next().value ?? null,
    session_started: sessions.size === 1, provider_usage_evidence: providerUsage ? 'CONFIRMED' : 'UNKNOWN',
    model_activity_evidence: modelActivity ? 'CONFIRMED' : 'UNKNOWN',
    tool_execution_evidence: tools.size ? 'OBSERVED' : 'UNKNOWN', tool_execution_count: tools.size,
    file_change_tool_evidence: fileEvidence,
    file_change_tool_completed_count: changedCounts.completed,
    file_change_tool_failed_count: changedCounts.failed,
    file_change_tool_incomplete_count: changedCounts.incomplete,
    token_usage: usageObserved && usagePositive ? Object.fromEntries(Object.keys(totals).map(key =>
      [key, tokenComplete[key] ? totals[key] : null])) : null,
    model_invoked: providerUsage || modelActivity ? true : null, event_count: eventCount };
}
