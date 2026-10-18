// Bounded, zero-inference V2 metadata qualification. Reuse the existing native
// GitHub worker; never read or publish credentials, raw auth JSON or account IDs.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { createInterface } from 'node:readline';

const MODEL_ID = /^[a-z][a-z0-9_-]{1,39}\/[A-Za-z0-9_./:-]{1,160}(?:#[a-z][a-z0-9_-]{0,39})?$/;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_MODELS_BYTES = 1024 * 1024;
const MAX_AGY_USAGE_BYTES = 32 * 1024;
const MAX_AGY_SETTINGS_BYTES = 64 * 1024;
function sha(value) { return createHash('sha256').update(value).digest('hex'); }

export function summarizeV2AuthJson(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_AUTH_BYTES)
    return { status: 'AUTH_METADATA_OVERSIZED_OR_INVALID', saved_account_count: null };
  let data;
  try { data = JSON.parse(stdout.trim()); }
  catch { return { status: 'AUTH_JSON_UNREADABLE', saved_account_count: null }; }
  let count;
  if (Array.isArray(data)) count = data.length;
  else if (data && typeof data === 'object' && Array.isArray(data.accounts)) count = data.accounts.length;
  else if (data && typeof data === 'object' && Array.isArray(data.integrations)) count = data.integrations.length;
  else return { status: 'AUTH_JSON_SCHEMA_UNKNOWN', saved_account_count: null };
  // Saved account metadata is not authorization, account validity, or a billing entitlement.
  return { status: count > 0 ? 'SAVED_ACCOUNT_RECORDS_PRESENT' : 'NO_SAVED_ACCOUNT_RECORDS',
    saved_account_count: count };
}

// Return only a coarse provider-readiness result. OpenCode auth JSON may carry
// credentials, so neither account records nor raw command output leave here.
export function summarizeV2AuthProviderJson(stdout, expectedProvider) {
  if (typeof expectedProvider !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/i.test(expectedProvider) ||
      typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_AUTH_BYTES)
    return { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' };
  let data;
  try { data = JSON.parse(stdout.trim()); }
  catch { return { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' }; }
  const records = Array.isArray(data) ? data :
    Array.isArray(data?.accounts) ? data.accounts :
      Array.isArray(data?.integrations) ? data.integrations : null;
  // OpenCode V2.0.32 emits `{}` for `auth list --format json` when no provider
  // credentials are saved. Preserve that observed empty state instead of
  // treating it as an unknown schema; non-empty unrecognized objects stay unknown.
  if (records === null && data !== null && typeof data === 'object' &&
      !Array.isArray(data) && Object.keys(data).length === 0)
    return { status: 'AUTH_PROVIDER_RECORD_ABSENT' };
  if (!records) return { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' };
  if (records.length === 0) return { status: 'AUTH_PROVIDER_RECORD_ABSENT' };
  const providers = records.map(record => record && typeof record === 'object' ?
    record.provider ?? record.providerID ?? record.provider_id : null)
    .filter(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(value));
  if (!providers.length) return { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' };
  return { status: providers.some(value => value.toLowerCase() === expectedProvider.toLowerCase()) ?
    'AUTH_PROVIDER_RECORD_PRESENT' : 'AUTH_PROVIDER_RECORD_ABSENT' };
}

export function readV2ProviderAuth(bin, provider, directory, runner = execFileSync, baseEnv = process.env) {
  if (typeof bin !== 'string' || !bin || typeof directory !== 'string' || !directory)
    return { status: 'AUTH_PROVIDER_COMMAND_UNAVAILABLE' };
  const env = { ...baseEnv, OPENCODE_DISABLE_AUTOUPDATE: 'true' };
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE']) delete env[key];
  try {
    const stdout = runner(bin, ['auth', 'list', '--format', 'json'], {
      cwd: directory, encoding: 'utf8', timeout: 12000, maxBuffer: MAX_AUTH_BYTES,
      windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return summarizeV2AuthProviderJson(stdout, provider);
  } catch {
    return { status: 'AUTH_PROVIDER_COMMAND_UNAVAILABLE' };
  }
}

export function summarizeV2Models(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_MODELS_BYTES)
    return { status: 'MODEL_LIST_OVERSIZED_OR_INVALID', catalog_count: null,
      catalog_sha256: null, candidate_free_name_count: null };
  const unique = new Set();
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const entry = line.trim();
    if (MODEL_ID.test(entry)) unique.add(entry);
  }
  const sorted = [...unique].sort();
  const freeHintCount = sorted.filter(x => /(?:^|[\/_:.\\-])free(?:$|[\/_:.\\-])/i.test(x)).length;
  return { status: sorted.length > 0 ? 'PUBLIC_CATALOG_IDS_PARSED_NOT_USABLE_PROOF' : 'CATALOG_IDS_UNRECOGNIZED',
    catalog_count: sorted.length, catalog_sha256: sha(sorted.join('\n')),
    candidate_free_name_count: freeHintCount };
}
export function runV2Readiness(bin, directory, runner = execFileSync, baseEnv = process.env) {
  const env = { ...baseEnv, OPENCODE_DISABLE_AUTOUPDATE: 'true' };
  // Reject inherited overrides of the local workspace/config audit.
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE']) delete env[key];
  const options = { cwd: directory, encoding: 'utf8', timeout: 12000,
    maxBuffer: MAX_MODELS_BYTES, windowsHide: true, env,
    stdio: ['ignore', 'pipe', 'pipe'] };
  const result = { auth: null, models: null, issues: [],
    inference_executed: false, credential_values_collected: false };
  try {
    const text = runner(bin, ['auth', 'list', '--format', 'json'], { ...options, maxBuffer: MAX_AUTH_BYTES });
    result.auth = summarizeV2AuthJson(text);
  } catch (err) {
    result.auth = { status: 'AUTH_COMMAND_UNAVAILABLE', saved_account_count: null };
    result.issues.push('AUTH_LIST_COMMAND_FAILED');
  }
  try {
    const text = runner(bin, ['models'], options);
    result.models = summarizeV2Models(text);
  } catch (err) {
    result.models = { status: 'MODELS_COMMAND_UNAVAILABLE', catalog_count: null,
      catalog_sha256: null, candidate_free_name_count: null };
    result.issues.push('MODELS_COMMAND_FAILED');
  }
  // No names, emails, tokens, account metadata, or raw output leave this function.
  return result;
}

function runAntigravityMetadata(bin, args, options) {
  const result = spawnSync(bin, args, { ...options, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('ANTIGRAVITY_METADATA_COMMAND_FAILED');
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function metadataText(output) {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
      typeof output.stdout !== 'string' || typeof output.stderr !== 'string') return null;
  return `${output.stdout}\n${output.stderr}`;
}

const METADATA_ENV_NAMES = new Set([
  'APPDATA', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
  'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'AGY_CLI_DISABLE_AUTO_UPDATE',
]);
function metadataEnvironment(baseEnv) {
  const safe = {};
  if (!baseEnv || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) return safe;
  for (const [key, value] of Object.entries(baseEnv))
    if (METADATA_ENV_NAMES.has(key.toUpperCase()) && typeof value === 'string') safe[key] = value;
  safe.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  return safe;
}

function verifyAntigravityAuthenticode(bin, baseEnv = process.env, runner = execFileSync) {
  if (process.platform !== 'win32') return false;
  const safeEnv = metadataEnvironment(baseEnv);
  const powershell = join(safeEnv.SystemRoot ?? safeEnv.SYSTEMROOT ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModule -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath $env:PTYSD_ANTIGRAVITY_SIGNATURE_PATH
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Google LLC') { exit 17 }
[Console]::Out.Write('VALID')`;
  try {
    const output = runner(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true,
        shell: false, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...safeEnv, PTYSD_ANTIGRAVITY_SIGNATURE_PATH: bin },
      });
    return typeof output === 'string' && output.trim() === 'VALID';
  } catch { return false; }
}

export const ANTIGRAVITY_V2_MODEL = 'gemini-3.8-flash-high';
const ANTIGRAVITY_MODEL_ROW = /^([a-z][a-z0-9.-]{1,79})[\t ]+\S/;
const ANTIGRAVITY_USAGE_ROW = /^Gemini Models\s+(Weekly|Five Hour) Limit Remaining\s+(\d{1,3})%\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

export function summarizeAntigravityUsage(stdout) {
  const unknown = { status: 'GEMINI_AGGREGATE_QUOTA_UNKNOWN', source: 'GEMINI_MODELS_AGGREGATE',
    weekly_remaining_percent: null, weekly_reset_at: null,
    five_hour_remaining_percent: null, five_hour_reset_at: null };
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_AGY_USAGE_BYTES)
    return unknown;
  const rows = new Map();
  for (const rawLine of stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('Gemini Models')) continue;
    const match = line.match(ANTIGRAVITY_USAGE_ROW);
    if (!match) return unknown;
    const [, period, percentText, resetAt] = match;
    const percent = Number(percentText);
    const resetMs = Date.parse(resetAt);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100 ||
        !Number.isFinite(resetMs) || new Date(resetMs).toISOString().replace('.000Z', 'Z') !== resetAt ||
        rows.has(period))
      return unknown;
    rows.set(period, { percent, resetAt });
  }
  const weekly = rows.get('Weekly');
  const fiveHour = rows.get('Five Hour');
  if (!weekly || !fiveHour) return unknown;
  return { status: 'GEMINI_AGGREGATE_QUOTA_READ', source: 'GEMINI_MODELS_AGGREGATE',
    weekly_remaining_percent: weekly.percent, weekly_reset_at: weekly.resetAt,
    five_hour_remaining_percent: fiveHour.percent, five_hour_reset_at: fiveHour.resetAt };
}

export function antigravityV2ReadinessExecutionFailure(readiness) {
  if (!readiness || readiness.status !== 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH' ||
      readiness.model !== ANTIGRAVITY_V2_MODEL || readiness.signature_verified !== true ||
      !Array.isArray(readiness.issues))
    return 'ANTIGRAVITY_CLI_NOT_QUALIFIED';
  if (readiness.authentication_evidence === 'LOGIN_REQUIRED')
    return 'ANTIGRAVITY_AUTH_NOT_LOGGED_IN';
  if (readiness.credit_fallback_setting === 'CREDIT_FALLBACK_ENABLED')
    return 'ANTIGRAVITY_CREDIT_OVERAGE_NOT_DISABLED';
  if (readiness.credit_fallback_setting !== 'CREDIT_FALLBACK_DISABLED')
    return 'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN';
  // Positive authentication and cost authorization are checked separately by
  // antigravityExecutionAuthorization. /usage alone never supplies that proof.
  if (readiness.issues.length) return 'ANTIGRAVITY_CLI_NOT_QUALIFIED';
  const quota = readiness.gemini_aggregate_quota;
  if (!quota || quota.status !== 'GEMINI_AGGREGATE_QUOTA_READ' ||
      quota.source !== 'GEMINI_MODELS_AGGREGATE' ||
      !Number.isInteger(quota.weekly_remaining_percent) || quota.weekly_remaining_percent < 0 ||
      quota.weekly_remaining_percent > 100 ||
      !Number.isInteger(quota.five_hour_remaining_percent) || quota.five_hour_remaining_percent < 0 ||
      quota.five_hour_remaining_percent > 100)
    return 'ANTIGRAVITY_AGGREGATE_QUOTA_UNKNOWN';
  if (quota.weekly_remaining_percent <= 0 || quota.five_hour_remaining_percent <= 0)
    return 'ANTIGRAVITY_QUOTA_EMPTY';
  return null;
}

export function summarizeAntigravityCreditSetting(settingsText) {
  if (typeof settingsText !== 'string' || Buffer.byteLength(settingsText) > MAX_AGY_SETTINGS_BYTES)
    return 'SETTINGS_INVALID_OR_OVERSIZED';
  let settings;
  try { settings = JSON.parse(settingsText); }
  catch { return 'SETTINGS_JSON_INVALID'; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return 'SETTINGS_SCHEMA_UNKNOWN';
  // The docs describe this setting but do not establish a safe default. Require
  // an explicit false value before any model run; plan entitlement/cost stay unknown.
  if (!Object.hasOwn(settings, 'useG1Credits')) return 'CREDIT_FALLBACK_SETTING_ABSENT';
  if (typeof settings.useG1Credits !== 'boolean') return 'SETTING_INVALID';
  return settings.useG1Credits ? 'CREDIT_FALLBACK_ENABLED' : 'CREDIT_FALLBACK_DISABLED';
}

function readAntigravityCreditSetting(baseEnv) {
  const profile = baseEnv && typeof baseEnv.USERPROFILE === 'string' ? baseEnv.USERPROFILE : '';
  if (!profile || !isAbsolute(profile)) return 'PROFILE_UNAVAILABLE';
  const settingsPath = join(profile, '.gemini', 'antigravity-cli', 'settings.json');
  try {
    const info = lstatSync(settingsPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_AGY_SETTINGS_BYTES)
      return 'SETTINGS_FILE_UNTRUSTED_OR_OVERSIZED';
    const profileReal = realpathSync(profile);
    const settingsReal = realpathSync(settingsPath);
    const relativePath = relative(profileReal, settingsReal);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
      return 'SETTINGS_PATH_OUTSIDE_PROFILE';
    return summarizeAntigravityCreditSetting(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' ? 'SETTINGS_FILE_MISSING' : 'SETTINGS_READ_ERROR';
  }
}

export function summarizeAntigravityV2Models(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_MODELS_BYTES)
    return { status: 'MODEL_LIST_OVERSIZED_OR_INVALID', catalog_count: null,
      catalog_sha256: null, pinned_model_cataloged: null };
  const ids = new Set();
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = line.trim().match(ANTIGRAVITY_MODEL_ROW);
    if (match) ids.add(match[1]);
  }
  const sorted = [...ids].sort();
  if (!sorted.length) return { status: 'MODEL_CATALOG_UNRECOGNIZED', catalog_count: 0,
    catalog_sha256: sha(''), pinned_model_cataloged: false };
  const pinned = ids.has(ANTIGRAVITY_V2_MODEL);
  return { status: pinned ? 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT' : 'PINNED_MODEL_NOT_CATALOGED',
    catalog_count: sorted.length, catalog_sha256: sha(sorted.join('\n')),
    pinned_model_cataloged: pinned };
}

// No-inference Antigravity qualification. The public model catalogue, CLI help,
// and aggregate quota report never prove model-specific entitlement, billing
// terms, write scope, or a real run.
export function runAntigravityV2Readiness(bin, directory, runner = runAntigravityMetadata,
  baseEnv = process.env, signatureVerifier = verifyAntigravityAuthenticode) {
  const result = { status: 'READINESS_UNKNOWN', executable_path_valid: false,
    version: null, model: ANTIGRAVITY_V2_MODEL, model_catalog: null,
    headless_print_supported: null, stream_json_supported: null,
    model_flag_supported: null, effort_flag_supported: null, sandbox_flag_supported: null,
    mode_flag_supported: null, accept_edits_mode_supported: null,
    signature_verified: false, authentication_checked: false,
    authentication_evidence: 'UNVERIFIED',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_UNKNOWN',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: null, weekly_reset_at: null,
      five_hour_remaining_percent: null, five_hour_reset_at: null },
    credit_fallback_setting: readAntigravityCreditSetting(baseEnv),
    entitlement: 'UNKNOWN', cost: 'UNKNOWN',
    write_scope: 'UNKNOWN', inference_executed: false,
    credential_values_collected: false, issues: [] };
  if (typeof bin !== 'string' || !(isAbsolute(bin) || win32.isAbsolute(bin)) ||
      typeof directory !== 'string' || !(isAbsolute(directory) || win32.isAbsolute(directory))) {
    result.issues.push('ABSOLUTE_EXECUTABLE_AND_CWD_REQUIRED');
    return result;
  }
  result.executable_path_valid = true;
  let physicalPath;
  try {
    const info = lstatSync(bin);
    physicalPath = realpathSync(bin);
    if (!info.isFile() || info.isSymbolicLink() ||
        win32.normalize(physicalPath).toLowerCase() !== win32.normalize(bin).toLowerCase())
      throw new Error('EXECUTABLE_PATH_UNVERIFIED');
  } catch {
    result.status = 'ANTIGRAVITY_EXECUTABLE_PATH_UNVERIFIED';
    result.issues.push('EXECUTABLE_NOT_A_VERIFIED_REGULAR_FILE');
    return result;
  }
  let signatureVerified = false;
  try { signatureVerified = signatureVerifier(bin, baseEnv) === true; } catch { /* remain unknown */ }
  if (!signatureVerified) {
    result.status = 'ANTIGRAVITY_GOOGLE_SIGNATURE_NOT_VERIFIED';
    result.issues.push('GOOGLE_AUTHENTICODE_SIGNATURE_NOT_CONFIRMED');
    return result;
  }
  result.signature_verified = true;
  const options = { cwd: directory, encoding: 'utf8', timeout: 12000,
    maxBuffer: MAX_MODELS_BYTES, windowsHide: true, shell: false,
    env: metadataEnvironment(baseEnv), stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const versionText = metadataText(runner(bin, ['--version'], options));
    const versionMatch = typeof versionText === 'string' && versionText.match(/\b(\d+\.\d+\.\d+)\b/);
    result.version = versionMatch?.[1] ?? null;
    if (!result.version) result.issues.push('VERSION_OUTPUT_UNRECOGNIZED');
  } catch { result.issues.push('VERSION_COMMAND_FAILED'); }
  try {
    const help = metadataText(runner(bin, ['--help'], options));
    if (typeof help !== 'string' || Buffer.byteLength(help) > MAX_MODELS_BYTES)
      throw new Error('HELP_OUTPUT_INVALID');
    result.headless_print_supported = help.includes('--print');
    result.stream_json_supported = help.includes('--output-format') && help.includes('stream-json');
    result.model_flag_supported = help.includes('--model');
    result.effort_flag_supported = help.includes('--effort');
    result.sandbox_flag_supported = help.includes('--sandbox');
    result.mode_flag_supported = help.includes('--mode');
    result.accept_edits_mode_supported = result.mode_flag_supported &&
      /\baccept-edits\b/i.test(help);
    if (!result.headless_print_supported || !result.stream_json_supported ||
        !result.model_flag_supported || !result.effort_flag_supported ||
        !result.sandbox_flag_supported || !result.mode_flag_supported ||
        !result.accept_edits_mode_supported)
      result.issues.push('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED');
  } catch { result.issues.push('HELP_COMMAND_FAILED'); }
  try {
    const models = metadataText(runner(bin, ['models'], options));
    result.model_catalog = summarizeAntigravityV2Models(models);
    if (!result.model_catalog.pinned_model_cataloged)
      result.issues.push('PINNED_MODEL_NOT_CONFIRMED_IN_CATALOG');
  } catch {
    result.model_catalog = { status: 'MODEL_LIST_UNAVAILABLE', catalog_count: null,
      catalog_sha256: null, pinned_model_cataloged: null };
    result.issues.push('MODELS_COMMAND_FAILED');
  }
  try {
    const usageOutput = runner(bin, ['--print', '/usage'],
      { ...options, timeout: 15000, maxBuffer: MAX_AGY_USAGE_BYTES });
    const usage = metadataText(usageOutput);
    result.gemini_aggregate_quota = summarizeAntigravityUsage(usage);
    const diagnosticText = typeof usageOutput === 'string' ? usageOutput :
      `${usageOutput?.stdout ?? ''}\n${usageOutput?.stderr ?? ''}`;
    if (/you are not logged into antigravity|authentication required/i.test(diagnosticText)) {
      result.authentication_evidence = 'LOGIN_REQUIRED';
      result.issues.push('ANTIGRAVITY_AUTH_NOT_LOGGED_IN');
    } else if (result.gemini_aggregate_quota.status === 'GEMINI_AGGREGATE_QUOTA_READ') {
      // /usage can return cached quota data; it does not expose a reliable
      // authenticated-session assertion. Keep it as quota metadata only; the
      // execution caller separately requires a fresh authorization attestation.
      result.authentication_evidence = 'QUOTA_ONLY_NOT_AUTH_PROOF';
    } else result.issues.push('ANTIGRAVITY_USAGE_OUTPUT_UNRECOGNIZED');
  } catch { result.issues.push('ANTIGRAVITY_USAGE_COMMAND_FAILED'); }
  const flagsConfirmed = result.headless_print_supported && result.stream_json_supported &&
    result.model_flag_supported && result.effort_flag_supported && result.sandbox_flag_supported &&
    result.mode_flag_supported && result.accept_edits_mode_supported;
  if (result.version && flagsConfirmed && result.model_catalog?.pinned_model_cataloged === true)
    result.status = 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH';
  else if (result.issues.length) result.status = 'METADATA_QUALIFICATION_INCOMPLETE';
  return result;
}

function emptyAntigravityRunEvidence(valid, reason = null) {
  return { valid, reason, session_id: null, session_started: valid ? false : null,
    cli_status: null, permission_mode_evidence: 'UNKNOWN', response_sha256: null, model_invoked: null,
    provider_usage_evidence: 'UNKNOWN', model_activity_evidence: 'UNKNOWN',
    tool_execution_evidence: 'UNKNOWN', tool_execution_count: 0,
    file_change_tool_evidence: 'UNKNOWN', file_change_tool_completed_count: 0,
    file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0,
    token_usage: null, event_count: 0, stdout_sha256: null, stdout_bytes: 0 };
}

function validAntigravityUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
  if (!fields.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

function sameAntigravityCwd(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !actual || !expected) return false;
  if (win32.isAbsolute(actual) && win32.isAbsolute(expected))
    return win32.normalize(actual).replace(/[\\/]+$/, '').toLowerCase() ===
      win32.normalize(expected).replace(/[\\/]+$/, '').toLowerCase();
  return actual === expected;
}

// Parse and hash the official Antigravity stream-json protocol without retaining
// model text or tool payloads in the returned receipt. `SUCCESS` is CLI state,
// never semantic or source acceptance.
export async function readAntigravityV2RunEvidence(stdoutPath, expectedSha256 = null,
  expectedCwd = null) {
  if (typeof expectedSha256 === 'string' && !/^[a-f0-9]{64}$/i.test(expectedSha256))
    return emptyAntigravityRunEvidence(false, 'ANTIGRAVITY_CAPTURE_HASH_INVALID');
  if (typeof expectedCwd !== 'string' || !(isAbsolute(expectedCwd) || win32.isAbsolute(expectedCwd)))
    return emptyAntigravityRunEvidence(false, 'ANTIGRAVITY_EXPECTED_CWD_INVALID');
  const hash = createHash('sha256');
  const tools = new Map();
  let bytes = 0;
  let eventCount = 0;
  let init = null;
  let result = null;
  let malformed = false;
  let permissionModeUnconfirmed = false;
  let streamError = false;
  let agentTextObserved = false;
  try {
    const stream = createReadStream(stdoutPath);
    stream.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { malformed = true; break; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { malformed = true; break; }
      eventCount++;
      if (event.event === 'init') {
        if (init || !event.init || typeof event.init !== 'object' || Array.isArray(event.init) ||
            typeof event.conversation_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(event.conversation_id) ||
            event.init.model !== ANTIGRAVITY_V2_MODEL || !sameAntigravityCwd(event.init.cwd, expectedCwd)) {
          malformed = true; break;
        }
        const permissionMode = event.init.permission_mode;
        if (!['accept-edits', 'request-review'].includes(permissionMode)) {
          permissionModeUnconfirmed = true; break;
        }
        init = { session_id: event.conversation_id, permission_mode: permissionMode };
      } else if (event.event === 'step_update') {
        const step = event.step_update;
        if (!init || !step || typeof step !== 'object' || Array.isArray(step) ||
            step.conversation_id !== init.session_id || !Number.isSafeInteger(step.step_index) ||
            step.step_index < 0 || !['ACTIVE', 'DONE'].includes(step.state) ||
            typeof step.step_type !== 'string') { malformed = true; break; }
        if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta.length)
          agentTextObserved = true;
        if (step.step_type === 'tool') {
          if (typeof step.tool_name !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(step.tool_name)) {
            malformed = true; break;
          }
          const previous = tools.get(step.step_index);
          if (previous && previous.name !== step.tool_name) { malformed = true; break; }
          tools.set(step.step_index, { name: step.tool_name, state: step.state,
            failed: step.state === 'DONE' && Boolean(step.tool_info?.error) });
        }
      } else if (event.event === 'result') {
        const terminal = event.result;
        if (!init || result || !terminal || typeof terminal !== 'object' || Array.isArray(terminal) ||
            terminal.conversation_id !== init.session_id ||
            !['SUCCESS', 'ERROR', 'CANCELED'].includes(terminal.status) ||
            typeof terminal.response !== 'string') { malformed = true; break; }
        result = { status: terminal.status, response: terminal.response,
          usage: validAntigravityUsage(terminal.usage) };
        if (!result.usage) { malformed = true; break; }
      } else {
        malformed = true; break;
      }
    }
  } catch { streamError = true; }

  const invalid = reason => emptyAntigravityRunEvidence(false, reason);
  if (streamError) return invalid('ANTIGRAVITY_JSONL_UNAVAILABLE');
  if (malformed) return invalid('ANTIGRAVITY_JSONL_INVALID');
  if (permissionModeUnconfirmed) return invalid('ANTIGRAVITY_PERMISSION_MODE_UNRECOGNIZED');
  if (!eventCount || !init || !result) return invalid('ANTIGRAVITY_JSONL_INCOMPLETE');
  const stdoutHash = hash.digest('hex');
  if (expectedSha256 && stdoutHash.toLowerCase() !== expectedSha256.toLowerCase())
    return invalid('ANTIGRAVITY_CAPTURE_HASH_MISMATCH');
  const toolValues = [...tools.values()];
  const fileTools = toolValues.filter(tool => ['replace_file_content', 'write_file', 'write_to_file']
    .includes(tool.name));
  const completedFileTools = fileTools.filter(tool => tool.state === 'DONE');
  const failedFileTools = completedFileTools.filter(tool => tool.failed);
  const incompleteFileTools = fileTools.filter(tool => tool.state !== 'DONE');
  const usage = result.usage;
  const modelInvoked = usage.input_tokens > 0 || usage.output_tokens > 0 || usage.thinking_tokens > 0;
  const hasToolCalls = tools.size > 0;
  return { valid: true, reason: null, session_id: init.session_id, session_started: true,
    cli_status: result.status, permission_mode_evidence: init.permission_mode === 'accept-edits'
      ? 'ACCEPT_EDITS_CONFIRMED' : 'REQUEST_REVIEW_CONFIRMED',
    response_sha256: sha(result.response), model_invoked: modelInvoked,
    provider_usage_evidence: modelInvoked ? 'OBSERVED' : 'NO_POSITIVE_USAGE_OBSERVED',
    model_activity_evidence: agentTextObserved || usage.output_tokens > 0 || usage.thinking_tokens > 0
      ? 'OBSERVED' : 'NO_ACTIVITY_OBSERVED',
    tool_execution_evidence: hasToolCalls ? 'OBSERVED' : 'NO_TOOL_CALLS_OBSERVED',
    tool_execution_count: tools.size,
    file_change_tool_evidence: completedFileTools.length ? 'OBSERVED' : 'NO_FILE_CHANGE_TOOL_OBSERVED',
    file_change_tool_completed_count: completedFileTools.length,
    file_change_tool_failed_count: failedFileTools.length,
    file_change_tool_incomplete_count: incompleteFileTools.length,
    token_usage: usage, event_count: eventCount, stdout_sha256: stdoutHash, stdout_bytes: bytes };
}
