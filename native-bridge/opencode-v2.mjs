// OpenCode V2-only native CLI qualification and minimal read-only run contract.
// No package installation, authentication, model invocation, or OS mutation here.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join, isAbsolute, normalize } from 'node:path';
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
      mode: 'primary', steps: 8,
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
