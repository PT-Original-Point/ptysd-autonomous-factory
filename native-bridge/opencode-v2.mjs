// OpenCode V2-only native CLI qualification and minimal read-only run contract.
// No package installation, authentication, model invocation, or OS mutation here.
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { delimiter, join, isAbsolute, normalize, resolve, relative } from 'node:path';
import { homedir, platform } from 'node:os';

const SEMVER_V2 = /^(?:opencode(?:2)?\s+)?v?(2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i;
const MODEL_ID = /^[a-z][a-z0-9_-]{1,39}\/[A-Za-z0-9_./:-]{1,150}$/;
const VARIANT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const NEVER = ['edit', 'shell', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'grep',
  'external_directory', 'execute'];
// Conventional OpenSSH private-key basenames. Read globs are anchored at the end
// of the resource, so the public companion (for example id_ed25519.pub) is not
// matched while the private file is. This is deliberately not a broad *key* rule.
const PRIVATE_KEY_BASENAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'id_ecdsa_sk', 'id_ed25519_sk'];
const PRIVATE_KEY_EXTENSIONS = ['key', 'ppk', 'pem', 'p12', 'pfx'];
const PRIVATE_READ_RESOURCES = ['*.env', '*.env.*', '*.npmrc', '*.netrc', '*.pypirc',
  '*.git-credentials', '*.git/config', '*auth.json', '*credentials.json',
  ...PRIVATE_KEY_EXTENSIONS.map(extension => `*.${extension}`),
  ...PRIVATE_KEY_BASENAMES.flatMap(name => [name, `*${name}`])];
// Case-insensitive so a Windows case variant cannot smuggle a private key past
// the exact edit allowlist. `.pub` is intentionally absent from both forms.
const PRIVATE_KEY_BASENAME = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i;
const PRIVATE_KEY_SUFFIX = new RegExp(`\\.(?:${PRIVATE_KEY_EXTENSIONS.join('|')})$`, 'i');
function workspaceReadProtection() {
  return [
    ...PRIVATE_READ_RESOURCES.map(resource => ({ action: 'read', resource, effect: 'deny' })),
    // Match OpenCode V2's documented example exception after the private env deny.
    { action: 'read', resource: '*.env.example', effect: 'allow' },
  ];
}

export function validateV2Model(model, variant) {
  return typeof model === 'string' && MODEL_ID.test(model) && !model.includes('..') &&
    (variant === null || typeof variant === 'string' && VARIANT_ID.test(variant));
}
export function parseOpenCodeV2Version(output) {
  if (typeof output !== 'string') return null;
  const m = SEMVER_V2.exec(output.trim());
  return m ? m[1] : null;
}
function verifyOpenCodeV2Signature(bin, runSignature = execFileSync) {
  if (typeof bin !== 'string' || !isAbsolute(bin)) return false;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModule -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath $env:PTYSD_OPENCODE_SIGNATURE_PATH
if ($signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Subject -notmatch 'Anomaly Innovations, Inc') { exit 17 }
[Console]::Out.Write('VALID')`;
  try {
    const output = runSignature(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true,
        shell: false,
        env: { ...process.env, PTYSD_OPENCODE_SIGNATURE_PATH: bin },
      });
    return typeof output === 'string' && output.trim() === 'VALID';
  } catch { return false; }
}
function regularFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
const CLI_VERSION_DIR = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const CLI_PACKAGING_LABELS = new Set(['x64', 'x86', 'ia32', 'amd64', 'arm64', 'arm',
  'armv7l', 'aarch64', 'win32', 'win64', 'universal']);
function withoutPackagingLabel(suffix) {
  let current = suffix;
  for (;;) {
    if (CLI_PACKAGING_LABELS.has(current.toLowerCase())) return '';
    const separator = current.lastIndexOf('-');
    if (separator === -1) return current;
    const label = current.slice(separator + 1);
    if (!CLI_PACKAGING_LABELS.has(label.toLowerCase())) return current;
    current = current.slice(0, separator);
  }
}
function parseCliVersionDir(name) {
  const match = CLI_VERSION_DIR.exec(name);
  if (!match) return null;
  const prerelease = match[4] ? withoutPackagingLabel(match[4]) : '';
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: prerelease || null };
}
function comparePrereleaseIdentifiers(left, right) {
  const a = left.split('.'), b = right.split('.');
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i], y = b[i];
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
function compareCliVersionDirs(left, right) {
  const a = parseCliVersionDir(left), b = parseCliVersionDir(right);
  if (a && b) {
    for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
    if ((a.prerelease === null) !== (b.prerelease === null)) return a.prerelease === null ? -1 : 1;
    if (a.prerelease !== null) {
      const difference = comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
      if (difference !== 0) return -difference;
    }
  } else if (a || b) return a ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
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
  if (win && typeof env.LOCALAPPDATA === 'string' && isAbsolute(env.LOCALAPPDATA)) {
    const bundled = normalize(join(env.LOCALAPPDATA, 'Programs', '@opencodedesktop',
      'resources', 'opencode-cli.exe'));
    const key = bundled.toLowerCase();
    if (!seen.has(key) && regularFile(bundled)) { seen.add(key); found.push(bundled); }
  }
  if (win && typeof env.LOCALAPPDATA === 'string' && isAbsolute(env.LOCALAPPDATA)) {
    // The managed PTYSD OpenCode install uses a versioned local directory and
    // the official @opencode/cli package layout. Discover only valid version
    // names; qualifyOpenCodeV2 still verifies Authenticode before running one.
    const localAppData = normalize(env.LOCALAPPDATA);
    let installs = [];
    try {
      installs = readdirSync(localAppData, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ({ name: entry.name,
          version: /^PTYSDOpenCodeCLI-v(.+)$/.exec(entry.name)?.[1] }))
        .filter(entry => entry.version && parseCliVersionDir(entry.version))
        .sort((left, right) => compareCliVersionDirs(left.version, right.version));
    } catch { installs = []; }
    for (const install of installs) {
      const candidate = normalize(join(localAppData, install.name, 'node_modules',
        '@opencode', 'cli', 'bin', 'opencode.exe'));
      const key = candidate.toLowerCase();
      if (!seen.has(key) && regularFile(candidate)) {
        seen.add(key); found.push(candidate);
      }
    }
  }
  if (win && typeof env.APPDATA === 'string' && isAbsolute(env.APPDATA)) {
    // The per-user Desktop CLI stores versioned builds under roaming APPDATA.
    // Sort deterministically newest-first, but keep Authenticode qualification
    // as the gate before any candidate is executed.
    const cliRoot = normalize(join(env.APPDATA, 'ai.opencode.desktop', 'cli'));
    let versions = [];
    try {
      versions = readdirSync(cliRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => entry.name)
        .sort(compareCliVersionDirs);
    } catch { versions = []; }
    for (const version of versions) {
      const candidate = normalize(join(cliRoot, version, 'opencode-cli.exe'));
      const key = candidate.toLowerCase();
      if (!seen.has(key) && regularFile(candidate)) { seen.add(key); found.push(candidate); }
    }
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
export function qualifyOpenCodeV2(env = process.env, win = platform() === 'win32',
  runVersion = execFileSync, verifySignature = verifyOpenCodeV2Signature) {
  const candidates = discoverV2Executables(env, win);
  for (const bin of candidates) {
    let signatureVerified = !win;
    if (win) {
      try { signatureVerified = verifySignature(bin) === true; }
      catch { signatureVerified = false; }
      if (!signatureVerified) continue;
    }
    try {
      const raw = runVersion(bin, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true });
      const version = parseOpenCodeV2Version(raw);
      if (version) return { ready: true, bin, version, candidates_checked: candidates.length,
        signature_status: signatureVerified ? 'VALID' : 'NOT_APPLICABLE' };
    } catch { /* An unavailable or untrusted executable is not an accepted V2 CLI. */ }
  }
  return { ready: false, bin: null, version: null, candidates_checked: candidates.length };
}
export function buildV2ReadOnlyConfig() {
  // Last-match rules; the only allowed operations are discovery within the workspace.
  // The leading catch-all deny makes every unlisted tool/action fail closed (browser,
  // computer, mcp_*, and any future action); read/glob are then the only allows before
  // workspace protection, and the explicit NEVER denials keep their prior ordering.
  // A custom PRIMARY agent prevents the built-in plan agent's plan-file edit exception.
  const permissions = [
    { action: '*', resource: '*', effect: 'deny' },
    ...NEVER.map(action => ({ action, resource: '*', effect: 'deny' })),
    ...['read', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' })),
    ...workspaceReadProtection(),
  ];
  return {
    autoupdate: false, share: 'disabled', snapshots: false, plugins: [],
    default_agent: 'ptysd-readonly',
    permissions,
    agents: { 'ptysd-readonly': {
      mode: 'primary',
      description: 'Read repository only; never run shell, write files, or delegate',
      system: 'Only inspect non-secret files in the assigned repository. Do not edit, run commands, browse the web, use plugins, access external directories, or delegate. Explain any limitation without requesting permission.',
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        ...NEVER.map(action => ({ action, resource: '*', effect: 'deny' })),
        ...['read', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' })),
        ...workspaceReadProtection(),
      ],
    } },
  };
}
export function buildV2ReadOnlyArgs(job, workspace, spec) {
  if (!validateV2Model(job?.model, job?.variant)) throw new Error('INVALID_V2_MODEL_OR_VARIANT');
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('WORKSPACE_NOT_ABSOLUTE');
  if (typeof spec !== 'string') throw new Error('INVALID_TASK_SPEC');
  const modelReference = job.variant === null ? job.model : `${job.model}#${job.variant}`;
  return ['run', '--standalone', '--agent', 'ptysd-readonly', '--model', modelReference,
    '--format', 'json', '--title', job.request_id,
    `${spec}\n\nDo not mutate any resource. Report a blocked result if the model, requested variant, or permissions are unavailable.`];
}

/**
 * Source-only V2 edit contract for a future OS-isolated coding worker.
 * This DOES NOT authorize execution under the GitHub publisher's OS identity:
 * agent permissions are not a filesystem or credential sandbox.
 */
export function buildV2ScopedEditConfig(workspace, editableFiles) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace))
    throw new Error('SCOPED_EDIT_WORKSPACE_MUST_BE_ABSOLUTE');
  if (!Array.isArray(editableFiles) || editableFiles.length < 1)
    throw new Error('SCOPED_EDIT_FILE_ALLOWLIST_INVALID');
  const root = resolve(workspace);
  if (platform() === 'win32' && /^\\\\[^\\]+\\[^\\]+/.test(root))
    throw new Error('SCOPED_EDIT_WORKSPACE_UNC_PATH');
  const samePath = (left, right) => platform() === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
  let physicalRoot;
  try { physicalRoot = realpathSync(root); }
  catch { throw new Error('SCOPED_EDIT_WORKSPACE_UNVERIFIABLE'); }
  if (!samePath(physicalRoot, root))
    throw new Error('SCOPED_EDIT_WORKSPACE_REPARSE_POINT');
  const allowedResources = new Set();
  const uniqueFiles = new Set();
  for (const file of editableFiles) {
    // Repository-relative paths use forward slashes only. Segment characters may
    // include spaces, Unicode, and literal punctuation, but never control or
    // format characters, backslashes, or active path-glob syntax: an edit resource
    // is matched as a glob, so a wildcard would widen the exact grant. Brackets
    // and braces are rejected, as are extglob openers such as !(...), @(...) and
    // +(...); literal +, @, !, and parentheses remain valid outside those forms.
    // The path must be nonempty and relative, and a top-level dotfile such as
    // .gitmodules stays denied even though interior dots remain allowed.
    if (typeof file !== 'string' || file.length === 0 ||
        file.startsWith('/') || file.startsWith('.') ||
        !/^[^\p{Cc}\p{Cf}\\*?[\]{}:<>"|]+$/u.test(file) ||
        /[!@+]\(/.test(file))
      throw new Error('SCOPED_EDIT_FILE_PATH_INVALID');
    const parts = file.split('/');
    if (parts.some(p => !p || p === '.' || p === '..'))
      throw new Error('SCOPED_EDIT_FILE_TRAVERSAL');
    // Win32 aliases trailing-dot/space components and reserves DOS device names,
    // including names with an extension. Reject those spellings before building
    // an exact grant so a distinct requested path cannot resolve to another file.
    if (platform() === 'win32' && parts.some(p => p.endsWith('.') || p.endsWith(' ') ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(p)))
      throw new Error('SCOPED_EDIT_FILE_PATH_INVALID');
    // The model is not allowed to edit control-plane, Git identity, or auth inputs.
    if (parts.some(p => /^\.(?:git|github|opencode)$/i.test(p)) ||
        ['governance', 'runs'].includes(parts[0].toLowerCase()) ||
        parts.some(p => /^\.env(?:\.|$)/i.test(p) ||
          /^opencode\.jsonc?$/i.test(p) ||
          /(?:secret|credential|token|password|auth\.json)/i.test(p)))
      throw new Error('SCOPED_EDIT_CONTROL_OR_SECRET_PATH');
    // Private keys are never editable inputs, at any depth. Public companions
    // such as id_ed25519.pub do not match either form and remain eligible.
    if (parts.some(p => PRIVATE_KEY_BASENAME.test(p) || PRIVATE_KEY_SUFFIX.test(p)))
      throw new Error('SCOPED_EDIT_CONTROL_OR_SECRET_PATH');
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
      // Hard links are regular files without a reparse point, but their content
      // is shared with every directory entry for the same inode. Reject them so
      // an in-workspace alias cannot widen the exact edit allowlist beyond this
      // workspace. Directories are excluded because their link count includes
      // subdirectories.
      if (index === parts.length - 1 && entry.isFile() && entry.nlink > 1)
        throw new Error('SCOPED_EDIT_HARD_LINK');
      let physical;
      try { physical = realpathSync(current); }
      catch { throw new Error('SCOPED_EDIT_PATH_UNVERIFIABLE'); }
      if (!samePath(physical, current)) throw new Error('SCOPED_EDIT_REPARSE_POINT');
    }
    const absoluteResource = absolute.replaceAll('\\', '/');
    const uniqueFile = platform() === 'win32' ? normalize(absolute).toLowerCase() : normalize(absolute);
    if (uniqueFiles.has(uniqueFile)) throw new Error('SCOPED_EDIT_DUPLICATE_PATH');
    uniqueFiles.add(uniqueFile);
    // OpenCode tools may report workspace files as relative paths, while some
    // callers provide an absolute path. Grant only the exact same file in each
    // representation; do not rely on the permission evaluator canonicalizing
    // Windows separators or resolving paths against the session directory.
    allowedResources.add(file);
    allowedResources.add(absoluteResource);
    if (platform() === 'win32') {
      allowedResources.add(file.replaceAll('/', '\\'));
      allowedResources.add(absolute);
    }
  }
  if (uniqueFiles.size !== editableFiles.length) throw new Error('SCOPED_EDIT_DUPLICATE_PATH');
  return {
    autoupdate: false, share: 'disabled', snapshots: false, plugins: [],
    default_agent: 'ptysd-scoped-write',
    // A late-loading agent cannot turn the shipped built-in agent into a writer.
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      ...['read', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' })),
      ...workspaceReadProtection(),
    ],
    agents: {
      'ptysd-scoped-write': {
        mode: 'primary',
        description: 'Modify only exact operator-approved source files; no shell or network tools',
        system: 'Edit only exact allowlisted source files for the reviewed task. Do not run commands, access secrets, call subagents or tools outside the project. Explain blocked actions instead of bypassing policy.',
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          ...['read', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' })),
          ...workspaceReadProtection(),
          ...[...allowedResources].map(resource => ({ action: 'edit', resource, effect: 'allow' })),
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
  const modelReference = job.variant === null ? job.model : `${job.model}#${job.variant}`;
  return ['run', '--standalone', '--agent', 'ptysd-scoped-write', '--model', modelReference,
    '--format', 'json', '--title', job.request_id,
    `${spec}\n\nOnly the separately enforced exact file allowlist is mutable. Do not execute shell or request wider permissions.`];
}

function emptyRunEvidence(valid, reason = null) {
  return { valid, reason, session_id: null, session_started: valid ? false : null,
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
 * Extract only non-content execution evidence from OpenCode V2 JSONL output.
 * Raw model text is parsed transiently and never returned. When a capture hash
 * is supplied, the bytes parsed must match the hash recorded by the process
 * capturer; unavailable, malformed, mixed-session, or changed bytes fail closed.
 */
export async function readOpenCodeV2RunEvidence(stdoutPath, expectedSha256 = null) {
  if (typeof expectedSha256 === 'string' && !/^[a-f0-9]{64}$/i.test(expectedSha256))
    return emptyRunEvidence(false, 'OPEN_CODE_CAPTURE_HASH_INVALID');
  const sessions = new Set();
  const tools = new Map();
  const totals = { input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, reasoning_output_tokens: 0 };
  const tokenComplete = { input_tokens: true, output_tokens: true,
    cached_input_tokens: true, reasoning_output_tokens: true };
  let usageObserved = false;
  let usagePositive = false;
  let modelTextObserved = false;
  let providerErrorReason = null;
  let eventCount = 0;
  let lineNumber = 0;
  let malformed = false;
  let overflow = false;
  let streamError = false;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const stream = createReadStream(stdoutPath);
    stream.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
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
      if (event.type === 'error') {
        // Keep only stable allowlisted reason codes. Provider messages can contain
        // account or request details and must not enter durable execution evidence.
        const providerMessage = typeof event.error?.message === 'string'
          ? event.error.message.toLowerCase().replace(/[^a-z0-9]+/g, ' ') : '';
        if (providerMessage.includes('opencode free model gateway detect abuse traffic'))
          providerErrorReason = 'OPEN_CODE_FREE_GATEWAY_ABUSE_BLOCKED';
        else if (event.error?.type === 'FreeTierError')
          providerErrorReason ??= 'OPEN_CODE_FREE_TIER_REJECTED';
        else providerErrorReason ??= 'OPEN_CODE_PROVIDER_ERROR';
      }
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
  if (expectedSha256 && hash.digest('hex').toLowerCase() !== expectedSha256.toLowerCase())
    return emptyRunEvidence(false, 'OPEN_CODE_CAPTURE_HASH_MISMATCH');
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
  return { valid: true, reason: providerErrorReason, session_id: sessions.values().next().value ?? null,
    session_started: sessions.size === 1 ? true : null,
    provider_usage_evidence: providerUsage ? 'CONFIRMED' : 'UNKNOWN',
    model_activity_evidence: modelActivity ? 'CONFIRMED' : 'UNKNOWN',
    tool_execution_evidence: tools.size ? 'OBSERVED' : 'UNKNOWN', tool_execution_count: tools.size,
    file_change_tool_evidence: fileEvidence,
    file_change_tool_completed_count: changedCounts.completed,
    file_change_tool_failed_count: changedCounts.failed,
    file_change_tool_incomplete_count: changedCounts.incomplete,
    token_usage: usageObserved && usagePositive ? Object.fromEntries(Object.keys(totals).map(key =>
      [key, tokenComplete[key] ? totals[key] : null])) : null,
    model_invoked: providerUsage || modelActivity ? true : null,
    event_count: eventCount, stdout_bytes: bytes };
}
