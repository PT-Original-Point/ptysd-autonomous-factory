// Bounded, zero-inference V2 metadata qualification. Reuse the existing native
// GitHub worker; never read or publish credentials, raw auth JSON or account IDs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const MODEL_ID = /^[a-z][a-z0-9_-]{1,39}\/[A-Za-z0-9_./:-]{1,160}(?:#[a-z][a-z0-9_-]{0,39})?$/;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_MODELS_BYTES = 1024 * 1024;
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
    saved_account_count: Math.min(count, 10000) };
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
