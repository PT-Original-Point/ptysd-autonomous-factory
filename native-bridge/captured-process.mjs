import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import { platform } from 'node:os';
import { finished, pipeline } from 'node:stream/promises';
import { safeErrorCode } from './safe-error-code.mjs';

const STDERR_SEPARATOR = Buffer.from('\n--- STDERR ---\n', 'utf8');

export function readWindowsProcessTree(rootPid, run = execFileSync, platformName = platform()) {
  const observedAt = new Date().toISOString();
  if (platformName !== 'win32' || !Number.isSafeInteger(rootPid) || rootPid < 1)
    return { state: 'UNKNOWN', root_pid: Number.isSafeInteger(rootPid) ? rootPid : null,
      process_ids: [], observed_at: observedAt, error: 'PROCESS_TREE_QUERY_UNAVAILABLE' };
  const script = `$ErrorActionPreference='Stop';$rootPid=${rootPid};` +
    `$all=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate);` +
    `$processSet=[System.Collections.Generic.HashSet[int]]::new();$invalid=$false;` +
    `foreach($p in $all){if($null-eq $p.ProcessId-or [int]$p.ProcessId-lt 0-or ` +
    `!$processSet.Add([int]$p.ProcessId)){$invalid=$true}};` +
    // A second process enumeration races with the CIM snapshot whenever Windows
    // starts or exits an unrelated process. Validate one complete CIM snapshot
    // instead of comparing two independently timed lists.
    `$censusComplete=(!$invalid-and $processSet.Count-gt 0-and $processSet.Contains($PID));` +
    `$known=[System.Collections.Generic.HashSet[int]]::new();[void]$known.Add($rootPid);` +
    `$changed=$true;while($changed){$changed=$false;foreach($p in $all){` +
    `if($known.Contains([int]$p.ParentProcessId)-and $known.Add([int]$p.ProcessId)){$changed=$true}}};` +
    `$found=@($all|Where-Object{$known.Contains([int]$_.ProcessId)});` +
    `$root=@($found|Where-Object{[int]$_.ProcessId-eq $rootPid});$created=$null;` +
    `if($root.Count-eq 1){$created=$root[0].CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')};` +
    `$state='UNKNOWN';$errorCode='EXECUTOR_PROCESS_CENSUS_INCOMPLETE';` +
    `if($found.Count-gt 0){$state='ALIVE';$errorCode=$null}` +
    `elseif($censusComplete){$state='DEAD';$errorCode=$null};` +
    `[pscustomobject]@{state=$state;process_ids=@($found|ForEach-Object{[int]$_.ProcessId});` +
    `root_created_at=$created;census_complete=$censusComplete;error=$errorCode}|ConvertTo-Json -Compress`;
  try {
    let value;
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, shell: false, timeout: 20000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      value = JSON.parse(output);
      if (value?.state !== 'UNKNOWN' || value?.error !== 'EXECUTOR_PROCESS_CENSUS_INCOMPLETE') break;
    }
    if (!['DEAD', 'ALIVE', 'UNKNOWN'].includes(value?.state) ||
        typeof value?.census_complete !== 'boolean' ||
        (value.state === 'UNKNOWN' && value.census_complete) ||
        (value.state === 'DEAD' && !value.census_complete))
      throw new Error('PROCESS_TREE_RESPONSE_INVALID');
    const processIds = Array.isArray(value.process_ids) ? value.process_ids :
      Number.isSafeInteger(value.process_ids) ? [value.process_ids] : [];
    if (!processIds.every(pid => Number.isSafeInteger(pid) && pid > 0) ||
        (value.state === 'DEAD' && processIds.length !== 0) ||
        (value.state === 'ALIVE' && processIds.length === 0))
      throw new Error('PROCESS_TREE_RESPONSE_INVALID');
    const rootCreatedAt = typeof value.root_created_at === 'string' &&
      !Number.isNaN(Date.parse(value.root_created_at)) ? value.root_created_at : null;
    const responseError = value.state === 'UNKNOWN'
      ? safeErrorCode({ code: value.error }, 'PROCESS_TREE_READBACK_FAILED') : null;
    return { state: value.state, root_pid: rootPid, process_ids: processIds,
      root_created_at: rootCreatedAt, observed_at: observedAt, error: responseError };
  } catch (error) {
    const code = safeErrorCode(error, 'PROCESS_TREE_READBACK_FAILED');
    return { state: 'UNKNOWN', root_pid: rootPid, process_ids: [],
      observed_at: observedAt, error: code };
  }
}

export function terminateProcessTree(child, {
  runTaskkill = execFileSync,
  readProcessTree = readWindowsProcessTree,
  platformName = platform(),
} = {}) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return { error: 'PROCESS_PID_UNAVAILABLE' };
  const rootExited = (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
  let terminationError = null;
  if (rootExited) {
    // Never signal a possibly reused PID. The OS tree readback below decides
    // whether descendants remain and supersedes the earlier unknown state.
  } else if (platformName === 'win32') {
    try {
      runTaskkill('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, shell: false, timeout: 15000, stdio: 'ignore',
      });
    } catch {
      terminationError = 'TASKKILL_TREE_FAILED';
      try { child.kill(); } catch { /* OS readback decides whether effects remain live. */ }
    }
  } else {
    terminationError = 'NON_WINDOWS_TREE_TERMINATION_UNVERIFIED';
    try { child.kill('SIGKILL'); }
    catch { terminationError = 'ROOT_TERMINATION_FAILED'; }
  }

  let readback;
  try { readback = readProcessTree(pid); }
  catch { readback = null; }
  const exactIds = Array.isArray(readback?.process_ids) &&
    readback.process_ids.every(value => Number.isSafeInteger(value) && value > 0);
  // Node already observed the root process exit, so the OS process table must no
  // longer hold that PID. Any ALIVE read-back after that point can no longer be
  // tied to this attempt: the root may still be present because the PID was
  // reused, or only descendants may remain with no captured spawn-time identity
  // to prove they are ours. Report UNKNOWN and never signal. Only a root that is
  // still running under a requested termination yields an evidenced orphan.
  const rootStillPresent = readback?.root_pid === pid &&
    ((readback.root_created_at !== null && readback.root_created_at !== undefined) ||
      (exactIds && readback.process_ids.includes(pid)));
  const aliveTree = readback?.root_pid === pid && exactIds &&
    readback.state === 'ALIVE' && readback.process_ids.length > 0;
  if (rootExited && aliveTree)
    return { requested: false, processTreeState: 'UNKNOWN',
      error: terminationError || (rootStillPresent
        ? 'PROCESS_TREE_IDENTITY_MISMATCH' : 'PROCESS_TREE_IDENTITY_UNPROVEN') };
  if (readback?.root_pid === pid && exactIds && readback.state === 'DEAD' && readback.process_ids.length === 0)
    return { treeConfirmed: true, processTreeState: 'DEAD', error: terminationError };
  if (aliveTree)
    return { rootOnly: true, processTreeState: 'ALIVE',
      error: terminationError || 'PROCESS_TREE_STILL_ACTIVE' };
  return { requested: !rootExited, processTreeState: 'UNKNOWN',
    error: terminationError || readback?.error || 'PROCESS_TREE_READBACK_UNKNOWN' };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function hashEvidence(stdoutPath, stderrPath) {
  const stdout = await hashFile(stdoutPath);
  const stderr = await hashFile(stderrPath);
  const combined = createHash('sha256');
  for await (const chunk of createReadStream(stdoutPath)) combined.update(chunk);
  combined.update(STDERR_SEPARATOR);
  for await (const chunk of createReadStream(stderrPath)) combined.update(chunk);
  return {
    sha256: combined.digest('hex'),
    bytes: stdout.bytes + STDERR_SEPARATOR.length + stderr.bytes,
    stdout,
    stderr,
  };
}

/**
 * Run a child with hidden-window, no-shell semantics and stream its raw output
 * to private local files. There is intentionally no wall-clock or byte-count
 * kill condition. A write/read failure is reported and requests child-tree
 * termination; an unconfirmed termination remains an unresolved attempt.
 */
export async function runCapturedProcess(command, args, {
  cwd,
  env,
  stdoutPath,
  stderrPath,
  stdinText,
  spawnProcess = spawn,
  terminate = terminateProcessTree,
  platformName = platform(),
  readProcessTree = readWindowsProcessTree,
  onSpawn = () => {},
} = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      typeof cwd !== 'string' || !cwd || typeof stdoutPath !== 'string' ||
      typeof stderrPath !== 'string' || stdoutPath === stderrPath ||
      typeof onSpawn !== 'function' ||
      (stdinText !== undefined && typeof stdinText !== 'string' && !Buffer.isBuffer(stdinText))) {
    throw new TypeError('CAPTURED_PROCESS_ARGUMENTS_INVALID');
  }

  const child = spawnProcess(command, args, {
    cwd, env, shell: false, windowsHide: true,
    stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let storageError = null;
  let captureError = null;
  let spawnError = null;
  let processError = null;
  let stdinError = null;
  let spawnStarted = false;
  let missingOutputPipe = false;
  let terminateRequested = false;
  let terminationNeeded = false;
  let terminationState = 'NOT_REQUESTED';
  let terminationError = null;
  let processTreeState = 'NOT_QUERIED';
  let processTreeError = null;
  const terminateOnce = () => {
    terminationNeeded = true;
    if (!spawnStarted) return;
    if (terminateRequested) return;
    terminateRequested = true;
    try {
      const result = terminate(child);
      if (typeof result?.error === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(result.error))
        terminationError = result.error;
      if (result?.treeConfirmed === true) terminationState = 'TERMINATION_CONFIRMED';
      else if (result?.rootOnly === true) terminationState = 'ORPHAN_POSSIBLE';
      else if (result?.requested === true) terminationState = 'TERMINATION_REQUESTED';
      else if (!result?.error) {
        terminationState = 'TERMINATION_UNCONFIRMED';
        terminationError = safeErrorCode(result?.error, 'IO_ERROR');
      } else {
        terminationState = 'TERMINATION_UNCONFIRMED';
      }
    } catch (error) {
      terminationState = 'TERMINATION_UNCONFIRMED';
      terminationError = safeErrorCode(error, 'IO_ERROR');
    }
  };
  const classifyMissingOutputPipe = () => {
    if (!missingOutputPipe || !spawnStarted) return;
    captureError ??= 'OUTPUT_PIPE_UNAVAILABLE';
    terminateOnce();
  };

  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  stdoutFile.once('error', error => { storageError ??= safeErrorCode(error, 'IO_ERROR'); terminateOnce(); });
  stderrFile.once('error', error => { storageError ??= safeErrorCode(error, 'IO_ERROR'); terminateOnce(); });
  child.once('spawn', () => {
    spawnStarted = true;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      captureError ??= 'PROCESS_PID_UNAVAILABLE';
      terminateOnce();
    } else {
      try { onSpawn(child.pid); }
      catch { captureError ??= 'PROCESS_STATE_RECORD_FAILED'; terminateOnce(); }
    }
    if (terminationNeeded) terminateOnce();
    classifyMissingOutputPipe();
  });
  child.once('error', error => {
    if (spawnStarted) processError ??= safeErrorCode(error, 'IO_ERROR');
    else spawnError ??= safeErrorCode(error, 'IO_ERROR');
  });

  const pipe = (source, destination) => {
    if (!source) {
      missingOutputPipe = true;
      classifyMissingOutputPipe();
      destination.end();
      return finished(destination).catch(() => {});
    }
    return pipeline(source, destination).catch(error => {
      if (!storageError && !spawnError) captureError ??= safeErrorCode(error, 'IO_ERROR');
      terminateOnce();
    });
  };
  const stdoutCapture = pipe(child.stdout, stdoutFile);
  const stderrCapture = pipe(child.stderr, stderrFile);
  let stdinCapture = Promise.resolve();
  if (stdinText !== undefined) {
    if (!child.stdin) {
      stdinError = 'INPUT_PIPE_UNAVAILABLE';
      terminateOnce();
    } else {
      stdinCapture = new Promise(resolveInput => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolveInput();
        };
        child.stdin.once('finish', settle);
        child.stdin.once('error', error => {
          stdinError ??= safeErrorCode(error, 'IO_ERROR');
          terminateOnce();
          settle();
        });
        child.stdin.once('close', () => {
          if (!child.stdin.writableFinished && !stdinError) {
            stdinError = 'INPUT_PIPE_CLOSED_EARLY';
            terminateOnce();
          }
          settle();
        });
        child.stdin.end(stdinText);
      });
    }
  }
  const closed = new Promise(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  const [exit] = await Promise.all([closed, stdoutCapture, stderrCapture, stdinCapture]);
  if (spawnStarted && Number.isSafeInteger(child.pid) && platformName === 'win32') {
    if (exit.code === null && exit.signal === null) {
      processTreeState = 'UNKNOWN';
      processTreeError = 'PROCESS_EXIT_STATUS_UNKNOWN';
      terminationState = 'TERMINATION_UNCONFIRMED';
      terminationError = 'PROCESS_EXIT_STATUS_UNKNOWN';
    } else {
      // A normal root close does not prove that descendants have exited. The
      // root-exited branch of terminateProcessTree performs readback only and
      // never signals a potentially reused PID.
      const finalTree = terminateProcessTree({ pid: child.pid, exitCode: exit.code,
        signalCode: exit.signal }, { readProcessTree, platformName });
      processTreeState = finalTree.processTreeState ?? 'UNKNOWN';
      processTreeError = finalTree.error ?? null;
      if (finalTree.treeConfirmed) {
        if (terminationState !== 'NOT_REQUESTED') {
          terminationState = 'TERMINATION_CONFIRMED';
          terminationError = null;
        }
      } else if (finalTree.rootOnly) {
        terminationState = 'ORPHAN_POSSIBLE';
        terminationError = 'PROCESS_TREE_STILL_ACTIVE';
      } else {
        terminationState = 'TERMINATION_UNCONFIRMED';
        terminationError = safeErrorCode(finalTree.error, 'PROCESS_TREE_READBACK_UNKNOWN');
      }
    }
  }
  if (missingOutputPipe && !spawnError && !captureError)
    captureError = 'OUTPUT_PIPE_UNAVAILABLE';

  let evidence = null;
  try { evidence = await hashEvidence(stdoutPath, stderrPath); }
  catch (error) { storageError ??= safeErrorCode(error, 'IO_ERROR'); }

  const outcome = storageError ? 'EVIDENCE_STORAGE_FAILED' :
    captureError ? 'OUTPUT_CAPTURE_FAILED' :
      spawnError ? 'OPENCODE_SPAWN_FAILED' :
        processError ? 'OPENCODE_PROCESS_FAILED' :
            stdinError ? 'OPENCODE_INPUT_FAILED' :
              exit.code === 0 ? 'OPENCODE_V2_EXIT_0_UNTRUSTED' : 'OPENCODE_V2_FAILED';
  return {
    exit_code: Number.isInteger(exit.code) ? exit.code : -1,
    outcome,
    evidence_sha256: evidence?.sha256 ?? null,
    evidence_bytes: evidence?.bytes ?? 0,
    local_evidence: {
      stdout_file: basename(stdoutPath),
      stderr_file: basename(stderrPath),
      stdout_sha256: evidence?.stdout.sha256 ?? null,
      stdout_bytes: evidence?.stdout.bytes ?? 0,
      stderr_sha256: evidence?.stderr.sha256 ?? null,
      stderr_bytes: evidence?.stderr.bytes ?? 0,
      storage_error: storageError,
      capture_error: captureError,
      spawn_error: spawnError,
      process_error: processError,
      stdin_error: stdinError,
      termination_state: terminationState,
      termination_error: terminationError,
      process_tree_state: processTreeState,
      process_tree_error: processTreeError,
      exit_signal: exit.signal ?? null,
    },
  };
}
