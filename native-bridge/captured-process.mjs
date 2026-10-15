import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { finished, pipeline } from 'node:stream/promises';

const STDERR_SEPARATOR = Buffer.from('\n--- STDERR ---\n', 'utf8');

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(error.code)
    ? error.code : 'IO_ERROR';
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
  terminate = () => {},
} = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      typeof cwd !== 'string' || !cwd || typeof stdoutPath !== 'string' ||
      typeof stderrPath !== 'string' || stdoutPath === stderrPath ||
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
  let terminationState = 'NOT_REQUESTED';
  let terminationError = null;
  const terminateOnce = () => {
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
        terminationError = errorCode(result?.error);
      } else {
        terminationState = 'TERMINATION_UNCONFIRMED';
      }
    } catch (error) {
      terminationState = 'TERMINATION_UNCONFIRMED';
      terminationError = errorCode(error);
    }
  };
  const classifyMissingOutputPipe = () => {
    if (!missingOutputPipe || !spawnStarted) return;
    captureError ??= 'OUTPUT_PIPE_UNAVAILABLE';
    terminateOnce();
  };

  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  stdoutFile.once('error', error => { storageError ??= errorCode(error); terminateOnce(); });
  stderrFile.once('error', error => { storageError ??= errorCode(error); terminateOnce(); });
  child.once('spawn', () => {
    spawnStarted = true;
    classifyMissingOutputPipe();
  });
  child.once('error', error => {
    if (spawnStarted) processError ??= errorCode(error);
    else spawnError ??= errorCode(error);
  });

  const pipe = (source, destination) => {
    if (!source) {
      missingOutputPipe = true;
      classifyMissingOutputPipe();
      destination.end();
      return finished(destination).catch(() => {});
    }
    return pipeline(source, destination).catch(error => {
      if (!storageError && !spawnError) captureError ??= errorCode(error);
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
          stdinError ??= errorCode(error);
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
  if (missingOutputPipe && !spawnError && !captureError)
    captureError = 'OUTPUT_PIPE_UNAVAILABLE';

  let evidence = null;
  try { evidence = await hashEvidence(stdoutPath, stderrPath); }
  catch (error) { storageError ??= errorCode(error); }

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
      exit_signal: exit.signal ?? null,
    },
  };
}
