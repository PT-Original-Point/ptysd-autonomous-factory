#!/usr/bin/env node
// Dedicated Task Scheduler entrypoint. It has no GitHub publisher API calls.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardConfig, JOB_MARKER, parseJob, receipt, runPlan, terminalStateForResult } from './worker.mjs';
import { assertPhysicalDirectory, claimPendingManifest, executorResultPath, getCurrentWindowsSid } from './windows-executor.mjs';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(code) { const error = new Error(code); error.code = code; throw error; }

function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

export async function executePendingManifest({ config, manifestDir, currentSid = getCurrentWindowsSid,
  execute = runPlan, rename = renameSync } = {}) {
  if (process.platform !== 'win32') fail('EXECUTOR_WINDOWS_ONLY');
  const runtime = config?.executor_runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) fail('EXECUTOR_RUNTIME_CONFIG_REQUIRED');
  if (!SID.test(runtime.user_sid || '') || !SID.test(runtime.publisher_sid || '') ||
      RESERVED_SIDS.has(runtime.user_sid.toUpperCase()) || RESERVED_SIDS.has(runtime.publisher_sid.toUpperCase()) ||
      runtime.user_sid.toUpperCase() === runtime.publisher_sid.toUpperCase())
    fail('EXECUTOR_RUNTIME_IDENTITY_INVALID');
  const actualSid = currentSid().toUpperCase();
  if (actualSid !== runtime.user_sid.toUpperCase()) fail('EXECUTOR_RUNTIME_IDENTITY_MISMATCH');
  if (typeof runtime.manifest_dir !== 'string' || typeof runtime.results_dir !== 'string' ||
      resolve(runtime.manifest_dir).toLowerCase() !== resolve(manifestDir).toLowerCase() ||
      resolve(runtime.results_dir).toLowerCase() !== resolve(config.state_dir).toLowerCase())
    fail('EXECUTOR_RUNTIME_PATH_MISMATCH');
  assertPhysicalDirectory(runtime.results_dir, 'EXECUTOR_RESULT_DIRECTORY_UNAVAILABLE');
  assertPhysicalDirectory(config.workspace, 'EXECUTOR_WORKSPACE_NOT_PHYSICAL_DIRECTORY');

  const runningPath = claimPendingManifest(manifestDir, rename);
  if (!runningPath) return { outcome: 'NO_PENDING_EXECUTOR_MANIFEST', exit_code: 0 };

  const manifest = JSON.parse(readFileSync(runningPath, 'utf8'));
  const parsedJob = parseJob(JOB_MARKER + JSON.stringify(manifest.job));
  if (!parsedJob || !['opencode_plan', 'opencode_edit'].includes(parsedJob.kind) || manifest.schema !== 1 ||
      manifest.kind !== 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1' ||
      parsedJob.project_id !== config.project_id || parsedJob.host.toUpperCase() !== config.host.toUpperCase() ||
      manifest.request_id !== parsedJob.request_id || manifest.source_sha !== parsedJob.source_sha ||
      manifest.spec_sha256 !== parsedJob.spec_sha256 || typeof manifest.spec !== 'string' ||
      digest(Buffer.from(manifest.spec, 'utf8')) !== parsedJob.spec_sha256 ||
      !/^[a-f0-9-]{36}$/.test(manifest.attempt_id || '') ||
      basename(runningPath).toLowerCase() !== `${manifest.attempt_id}.running.json`.toLowerCase())
    fail('EXECUTOR_MANIFEST_IDENTITY_OR_HASH_INVALID');

  const target = executorResultPath(runtime.results_dir, parsedJob.request_id, manifest.attempt_id);
  if (existsSync(target)) fail('EXECUTOR_RESULT_ALREADY_EXISTS');

  let result;
  try { result = await execute(manifest.spec, config, parsedJob, manifest.attempt_id); }
  catch (error) {
    result = { outcome: `EXECUTION_ERROR_${String(error?.code || 'UNKNOWN').slice(0, 36)}`,
      exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
  }
  const terminal = receipt(parsedJob.request_id, manifest.attempt_id,
    terminalStateForResult(result), parsedJob, result);
  atomicJson(target, { request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
    terminal, local_evidence: result.local_evidence ?? null });
  return { outcome: 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE',
    exit_code: terminal.exit_code, terminal_state: terminal.state, result_path: target,
    evidence_sha256: terminal.evidence_sha256, evidence_bytes: terminal.evidence_bytes };
}

async function main() {
  const configArg = process.argv.indexOf('--config');
  const manifestArg = process.argv.indexOf('--manifest-dir');
  if (configArg < 0 || !process.argv[configArg + 1] || manifestArg < 0 || !process.argv[manifestArg + 1])
    fail('USAGE: executor.mjs --config <executor-config.json> --manifest-dir <directory>');
  const config = guardConfig(JSON.parse(readFileSync(resolve(process.argv[configArg + 1]), 'utf8').replace(/^\uFEFF/, '')));
  const result = await executePendingManifest({ config, manifestDir: resolve(process.argv[manifestArg + 1]) });
  console.log(`${result.outcome}${result.terminal_state ? `_${result.terminal_state}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`NATIVE_EXECUTOR_BLOCKED: ${String(error?.code || error?.message || 'UNKNOWN').slice(0, 120)}`);
    process.exitCode = 2;
  });
}
