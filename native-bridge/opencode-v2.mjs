// OpenCode V2-only native CLI qualification and minimal read-only run contract.
// No package installation, authentication, model invocation, or OS mutation here.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join, isAbsolute, normalize, resolve, relative } from 'node:path';
import { homedir, platform } from 'node:os';

const SEMVER_V2 = /^(?:opencode(?:2)?\s+)?v?(2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i;
const MODEL_ID = /^[a-z][a-z0-9_-]{1,39}\/[A-Za-z0-9_./:-]{1,150}$/;
const VARIANT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const NEVER = ['edit', 'shell', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory', 'execute'];

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
  const dirs = String(env.PATH || env.Path || '').split(splitter).filter(Boolean).slice(0, 120);
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
export function buildV2ReadOnlyConfig() {
  // Last-match rules; the only allowed operations are discovery within the workspace.
  // A custom PRIMARY agent prevents the built-in plan agent's plan-file edit exception.
  const permissions = [
    ...NEVER.map(action => ({ action, resource: '*', effect: 'deny' })),
    ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'read', resource: '**/*.env', effect: 'deny' },
  ];
  return {
    autoupdate: false, share: 'disabled', snapshots: false, plugins: [],
    default_agent: 'ptysd-readonly',
    permissions,
    agents: { 'ptysd-readonly': {
      mode: 'primary',
      description: 'Read repository only; never run shell, write files, or delegate',
      system: 'Only inspect non-secret files in the assigned repository. Do not edit, run commands, browse the web, use plugins, access external directories, or delegate. Explain any limitation without requesting permission.',
      permissions: NEVER.map(action => ({ action, resource: '*', effect: 'deny' })),
    } },
  };
}
export function buildV2ReadOnlyArgs(job, workspace, spec) {
  if (!validateV2Model(job?.model, job?.variant)) throw new Error('INVALID_V2_MODEL_OR_VARIANT');
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('WORKSPACE_NOT_ABSOLUTE');
  if (typeof spec !== 'string' || spec.length > 20000) throw new Error('INVALID_TASK_SPEC');
  return ['run', '--agent', 'ptysd-readonly', '--model', `${job.model}#${job.variant}`,
    '--format', 'json', '--dir', workspace, '--title', job.request_id,
    `${spec}\n\nDo not mutate any resource. Report a blocked result if the model, reasoning variant, or permissions are unavailable.`];
}

/**
 * V2 scoped edit policy for schema-3 jobs on the existing native Executor.
 * This is not an OS sandbox: the Executor must separately read back its low-privilege
 * identity and workspace isolation before the Worker enables coding runs.
 */
export function validateV2ScopedEditPaths(editableFiles) {
  if (!Array.isArray(editableFiles) || editableFiles.length < 1 || editableFiles.length > 16)
    throw new Error('SCOPED_EDIT_FILE_ALLOWLIST_INVALID');
  const allowed = [];
  const seen = new Set();
  for (const file of editableFiles) {
    if (typeof file !== 'string' || file.length > 180 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file))
      throw new Error('SCOPED_EDIT_FILE_PATH_INVALID');
    const parts = file.split('/');
    if (parts.some(p => !p || p === '.' || p === '..'))
      throw new Error('SCOPED_EDIT_FILE_TRAVERSAL');
    if (parts.some(p => /^\.(?:git|github|opencode)$/i.test(p)) ||
        ['governance', 'runs', 'native-bridge'].includes(parts[0].toLowerCase()) ||
        parts.some(p => /^\.env(?:\.|$)/i.test(p) || /^opencode\.jsonc?$/i.test(p) ||
          /(?:secret|credential|token|password|auth\.json)/i.test(p)))
      throw new Error('SCOPED_EDIT_CONTROL_OR_SECRET_PATH');
    if (seen.has(file)) throw new Error('SCOPED_EDIT_DUPLICATE_PATH');
    seen.add(file);
    allowed.push(file);
  }
  return allowed;
}

export function buildV2ScopedEditConfig(workspace, editableFiles) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace))
    throw new Error('SCOPED_EDIT_WORKSPACE_MUST_BE_ABSOLUTE');
  const root = resolve(workspace);
  const allowed = validateV2ScopedEditPaths(editableFiles).map(file => {
    const absolute = resolve(root, ...file.split('/'));
    const inside = relative(root, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new Error('SCOPED_EDIT_PATH_OUTSIDE_WORKSPACE');
    return absolute.replaceAll('\\', '/');
  });
  return {
    autoupdate: false, share: 'disabled', snapshots: false, plugins: [],
    default_agent: 'ptysd-scoped-write',
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
          ...allowed.map(resource => ({ action: 'edit', resource, effect: 'allow' })),
        ],
      },
    },
  };
}
export function buildV2ScopedEditArgs(job, workspace, spec) {
  if (job?.kind !== 'opencode_edit') throw new Error('INVALID_V2_CODING_JOB');
  validateV2ScopedEditPaths(job.write_paths);
  if (!validateV2Model(job?.model, job?.variant)) throw new Error('INVALID_V2_MODEL_OR_VARIANT');
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('WORKSPACE_NOT_ABSOLUTE');
  if (typeof job?.request_id !== 'string' || !/^[A-Z][A-Z0-9_-]{7,79}$/.test(job.request_id))
    throw new Error('INVALID_V2_CODING_REQUEST');
  if (typeof spec !== 'string' || !spec.trim() || spec.length > 20000)
    throw new Error('INVALID_CODING_TASK_SPEC');
  return ['run', '--agent', 'ptysd-scoped-write', '--model', job.model + '#' + job.variant,
    '--format', 'json', '--dir', workspace, '--title', job.request_id,
    spec + '\n\nOnly the separately enforced exact file allowlist is mutable. Do not execute shell or request wider permissions.'];
}
