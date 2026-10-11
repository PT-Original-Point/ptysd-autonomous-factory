import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// R3 source-lane resumption evidence (host source lane, worker-w1 only).
// Authoritative source is the real controller dispatch policy:
//   {"w1":{"automatic_dispatch":true,"latest_recovery_probe":"<file>.verification.json"}}
// round-status probes, nested refs and root-level probes are never
// authoritative for this lane.
// ---------------------------------------------------------------------------

const R3_RECEIPT_STATUS = 'HOST_NATIVE_HELPER_END_TO_END_DELIVERY_PASS_SOURCE_LANE_RESUMED';
const R3_CI_BLOCKED_STATUS = 'NATIVE_HOSTED_CI_BLOCKED_BASELINE_TEST_MUTATION_AND_DELETION';
const R3_MAX_RECEIPT_BYTES = 256 * 1024;
const R3_MAX_STATUS_BYTES = 4 * 1024 * 1024;

export function __r3SafePath(phaseDir, name, maxBytes = R3_MAX_RECEIPT_BYTES) {
  if (typeof phaseDir !== 'string' || !phaseDir) return null;
  if (typeof name !== 'string' || !name || name.length > 128) return null;
  // Lexical rule: plain basename only (no separators, no traversal, no roots).
  if (path.basename(name) !== name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;

  const abs = path.join(phaseDir, name);
  const rel = path.relative(phaseDir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  // Real-path rule: a symlink must not resolve outside the real phase dir,
  // and the target must be a bounded regular file (never a new directory).
  let realRoot;
  let realFile;
  let stat;
  try {
    realRoot = fs.realpathSync(phaseDir);
    realFile = fs.realpathSync(abs);
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  const realRel = path.relative(realRoot, realFile);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  if (!stat.isFile() || stat.size > maxBytes) return null;
  return abs;
}

function __r3ReadJson(file, maxBytes = R3_MAX_RECEIPT_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function __r3NativeSourceCi(phaseDir) {
  const file = __r3SafePath(phaseDir, 'round-status.json', R3_MAX_STATUS_BYTES);
  const status = file ? __r3ReadJson(file, R3_MAX_STATUS_BYTES) : null;
  return status && typeof status.native_source_ci === 'object' ? status.native_source_ci : null;
}

export function __r3HostSourceLane(phaseDir, policyW1, workerStatus) {
  const w1 = policyW1 && typeof policyW1 === 'object' ? policyW1 : {};

  // Only an explicit true may ever reach READY; false outranks a good receipt.
  if (w1.automatic_dispatch === false) {
    return { ready: 'PAUSED', evidence: 'policy.w1.automatic_dispatch=false' };
  }
  if (w1.automatic_dispatch !== true) {
    return { ready: 'UNKNOWN', evidence: 'policy.w1.automatic_dispatch not true' };
  }

  // A live attempt is busy regardless of any stored receipt.
  if (workerStatus === 'RUNNING') {
    return { ready: 'BUSY', evidence: 'W1 RUNNING' };
  }

  const probe = w1.latest_recovery_probe;
  if (typeof probe !== 'string' || !probe) {
    return { ready: 'UNKNOWN', evidence: 'policy.w1.latest_recovery_probe missing' };
  }

  const file = __r3SafePath(phaseDir, probe);
  if (!file) return { ready: 'UNKNOWN', evidence: 'probe path rejected' };

  const receipt = __r3ReadJson(file);
  if (!receipt) return { ready: 'UNKNOWN', evidence: 'probe receipt unreadable' };

  const transport = receipt.transport && typeof receipt.transport === 'object' ? receipt.transport : {};
  const session = receipt.session_id ?? receipt.sessionId;
  const transportSession = transport.session_id ?? transport.sessionId;
  const sessionOk = typeof session === 'string' && session.length > 0 && session === transportSession;
  const outcomeOk = receipt.native_outcome === 'succeeded';
  const transportOk = transport.ok === true;

  // When the receipt names the model actually used it must bind to the
  // reported provider / id / variant.
  const model = receipt.model && typeof receipt.model === 'object' ? receipt.model : {};
  const provider = model.provider ?? receipt.model_provider;
  const modelId = model.id ?? model.name ?? receipt.model_id;
  const parts = [provider, modelId, model.variant].filter((v) => typeof v === 'string' && v);
  const am = receipt.actual_model && typeof receipt.actual_model === 'object' ? receipt.actual_model : null;
  const lm = receipt.model && typeof receipt.model === 'object' ? receipt.model : null;
  let modelOk = false;
  if (typeof transport.model === 'string' && transport.model) {
    const p = am ? am.providerID : lm ? (lm.providerID ?? lm.provider) : undefined;
    const i = am ? am.id : lm ? (lm.id ?? lm.name) : undefined;
    const v = am ? am.variant : lm ? lm.variant : undefined;
    if (typeof p === 'string' && p && typeof i === 'string' && i && typeof v === 'string' && v) modelOk = transport.model === p + '/' + i + '#' + v;
  }

  if (receipt.status === R3_RECEIPT_STATUS && outcomeOk && transportOk && sessionOk && modelOk) {
    return { ready: 'READY', evidence: probe };
  }
  return { ready: 'PAUSED', evidence: 'receipt not host-source verified' };
}

function __r3BlockedEvaluate(headSha, nci, phaseDir) {
  if (typeof headSha !== 'string' || !headSha) return null;
  if (!nci || typeof nci !== 'object') return null;
  // Exact head match only: a local count such as "126" is never a candidate
  // head and never provider-PASS evidence.
  if (nci.candidate_under_test !== headSha) return null;

  const inline = typeof nci.status === 'string' ? nci.status : '';
  let blocked = inline.includes('FAIL') || inline.includes('BLOCKED');
  let tests = 'SKIPPED';

  const name = nci.receipt;
  if (typeof name === 'string' && name) {
    const file = __r3SafePath(phaseDir, name);
    const receipt = file ? __r3ReadJson(file) : null;
    const head = receipt ? (receipt.candidate_head ?? receipt.candidate_under_test) : null;
    if (receipt && head === headSha) {
      const rs = typeof receipt.status === 'string' ? receipt.status : '';
      if (rs === R3_CI_BLOCKED_STATUS || rs.includes('FAIL')) blocked = true;
      if (typeof receipt.tests === 'string' && receipt.tests) tests = receipt.tests;
      const shaOk = /^[0-9a-f]{40}$/.test(headSha);
      const passOk = rs === 'NATIVE_HOSTED_EXACT_CANDIDATE_126_TESTS_PASS';
      const nOk = Number.isInteger(receipt.tests) && Number.isInteger(receipt.pass) && receipt.tests > 0 && receipt.tests === receipt.pass && receipt.fail === 0;
      const jOk = Number.isSafeInteger(receipt.run_id) && receipt.run_id > 0 && Number.isSafeInteger(receipt.job_id) && receipt.job_id > 0;
      const cOk = nci.candidate_tests !== 'SKIPPED' && receipt.candidate_tests !== 'SKIPPED';
      if (shaOk && passOk && nOk && jOk && cOk) return { blocked: false, tests: '126 passed (native GitHub)', native_pass: true };
      if (blocked) return { blocked: true, tests };
    }
  }

  // No false legacy PASS is manufactured when nothing blocks the candidate.
  if (!blocked) return null;
  return { blocked: true, tests };
}

// One evaluation per candidate head per dashboard build: the card status,
// tests and next fields all read the same memoised result instead of
// repeating the synchronous reads three times.
let r3BlockedMemo = null;

export function __r3BlockedMemoReset() {
  r3BlockedMemo = null;
}

export function __r3Blocked(headSha, phaseDir) {
  const key = `${phaseDir || ''}|${headSha || ''}`;
  if (r3BlockedMemo && r3BlockedMemo.key === key) return r3BlockedMemo.result;
  const result = __r3BlockedEvaluate(headSha, __r3NativeSourceCi(phaseDir), phaseDir);
  r3BlockedMemo = { key, result };
  return result;
}

export function loadConfig(configPath) {
  const defaultPath = path.resolve(MODULE_DIR, 'config.json');
  const targetPath = configPath || defaultPath;
  if (fs.existsSync(targetPath)) {
    try {
      return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch {
      throw new Error('INVALID_MONITOR_CONFIG_JSON');
    }
  }
  return {};
}

// A missing configuration may produce UNKNOWN data, but must never silently
// move the desktop monitor to a random port, breaking the fixed localhost URL.
export function configuredListenPort(config) {
  const port = config?.port === undefined ? 2667 : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('INVALID_MONITOR_PORT');
  }
  return port;
}

export function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function isPathInWorkspace(targetPath, workspaceRoot) {
  const normTarget = normalizePath(targetPath);
  const normRoot = normalizePath(workspaceRoot);
  if (!normTarget || !normRoot) return false;
  return normTarget === normRoot || normTarget.startsWith(normRoot + '/');
}

export function formatTimestamp(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    if (val < 1e11) return new Date(val * 1000).toISOString();
    return new Date(val).toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  return null;
}

export function redactSecrets(text, workspaceRoot = '') {
  if (!text || typeof text !== 'string') return '';
  let s = text.replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  s = s.replace(/bearer\s+[a-zA-Z0-9_\-\.~]+/gi, 'Bearer [REDACTED_TOKEN]');
  s = s.replace(/\b(sk-[a-zA-Z0-9_\-]{16,})\b/g, '[REDACTED_API_KEY]');
  s = s.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, '[REDACTED_GH_TOKEN]');
  s = s.replace(/(token|key|password|secret|auth)\s*[:=]\s*["']?[a-zA-Z0-9_\-\.~]{8,}["']?/gi, '$1=[REDACTED]');
  s = s.replace(/[A-Za-z]:\\[Uu]sers\\[^\\\s"']+/g, '[REDACTED_USER_PATH]');
  s = s.replace(/\/home\/[^/\s"']+/g, '[REDACTED_USER_PATH]');
  if (workspaceRoot) {
    const normRoot = normalizePath(workspaceRoot);
    const escaped = normRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(escaped, 'gi'), '[WORKSPACE_ROOT]');
  }
  s = s.trim();
  return s.length > 240 ? s.slice(0, 237) + '...' : s;
}

export function bootstrapRolloutBoundary(filePath, maxScan = 32 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size > maxScan) return { lastBoundary: null, status: null };
    const toReadTotal = Math.min(stat.size, maxScan);
    const chunkCap = 256 * 1024;
    const buf = Buffer.alloc(chunkCap);
    let cur = 0;
    let rem = '';
    let lastBoundary = null;
    let status = null;
    while (cur < toReadTotal) {
      const readLen = Math.min(chunkCap, toReadTotal - cur);
      const n = fs.readSync(fd, buf, 0, readLen, cur);
      if (n <= 0) break;
      cur += n;
      rem += buf.toString('utf8', 0, n);
      if (rem.length > 1024 * 1024) rem = rem.slice(-1024 * 1024);
      const lines = rem.split('\n');
      rem = lines.pop() || '';
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          const isEventMsg = ev.type === 'event_msg' || ev.event === 'event_msg' || Boolean(ev.event_msg);
          if (!isEventMsg) continue;
          const payload = ev.payload || ev.event_msg || ev;
          const evType = payload.type || ev.type || ev.event;
          if (evType === 'task_started') {
            lastBoundary = 'task_started';
            status = 'RUNNING';
          } else if (evType === 'task_complete') {
            lastBoundary = 'task_complete';
            status = 'COMPLETED';
          } else if (evType === 'turn_aborted') {
            lastBoundary = 'turn_aborted';
            status = 'IDLE';
          }
        } catch {}
      }
    }
    if (rem.trim()) {
      try {
        const ev = JSON.parse(rem.trim());
        const isEventMsg = ev.type === 'event_msg' || ev.event === 'event_msg' || Boolean(ev.event_msg);
        const payload = isEventMsg ? (ev.payload || ev.event_msg || ev) : {};
        const evType = payload.type || ev.type || ev.event;
        if (evType === 'task_started') {
          lastBoundary = 'task_started';
          status = 'RUNNING';
        } else if (evType === 'task_complete') {
          lastBoundary = 'task_complete';
          status = 'COMPLETED';
        } else if (evType === 'turn_aborted') {
          lastBoundary = 'turn_aborted';
          status = 'IDLE';
        }
      } catch {}
    }
    return { lastBoundary, status };
  } catch {
    return { lastBoundary: null, status: null };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function readIncrementalRolloutLog(filePath, stateMap, maxBytes = 2 * 1024 * 1024) {
  let fileState = stateMap.get(filePath);
  if (!fileState) {
    fileState = {
      offset: 0,
      remainingText: '',
      status: 'UNKNOWN',
      lastBoundary: null,
      lastEventAt: null,
      lastAgentMessage: null,
      lastGenericActivity: null,
      model: null,
      reasoningEffort: null
    };
    stateMap.set(filePath, fileState);
  }

  if (!fs.existsSync(filePath)) return fileState;
  const stat = fs.statSync(filePath);

  if (stat.size < fileState.offset) {
    fileState.offset = 0;
    fileState.remainingText = '';
    fileState.status = 'UNKNOWN';
    fileState.lastBoundary = null;
    fileState.lastEventAt = null;
    fileState.lastAgentMessage = null;
    fileState.lastGenericActivity = null;
    fileState.model = null;
    fileState.reasoningEffort = null;
  }

  if (stat.size === fileState.offset) return fileState;

  if (fileState.offset === 0 && stat.size > maxBytes) {
    const boot = bootstrapRolloutBoundary(filePath);
    if (boot.lastBoundary) {
      fileState.lastBoundary = boot.lastBoundary;
      fileState.status = boot.status;
    }
    fileState.offset = stat.size - maxBytes;
    fileState.remainingText = '';
  }

  const bytesToRead = Math.min(stat.size - fileState.offset, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(bytesToRead);
  fs.readSync(fd, buffer, 0, bytesToRead, fileState.offset);
  fs.closeSync(fd);

  fileState.offset += bytesToRead;
  const chunkText = fileState.remainingText + buffer.toString('utf8');
  const lines = chunkText.split('\n');
  fileState.remainingText = lines.pop();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      const payload = ev.payload || ev.event_msg || ev;
      const evType = payload.type || ev.type || ev.event;
      const evTime = formatTimestamp(ev.timestamp || payload.timestamp || ev.event_at || ev.at_utc);
      if (evTime) fileState.lastEventAt = evTime;

      if (payload.model || ev.model) fileState.model = payload.model || ev.model;
      if (payload.reasoning_effort || ev.reasoning_effort) {
        fileState.reasoningEffort = payload.reasoning_effort || ev.reasoning_effort;
      }

      if (evType === 'task_started') {
        fileState.lastBoundary = 'task_started';
        fileState.status = 'RUNNING';
      } else if (evType === 'task_complete') {
        fileState.lastBoundary = 'task_complete';
        fileState.status = 'COMPLETED';
      } else if (evType === 'turn_aborted') {
        fileState.lastBoundary = 'turn_aborted';
        fileState.status = 'IDLE';
      }

      const item = payload.item || ev.item;
      if (item) {
        if (item.type === 'Reasoning' || item.reasoning) continue;
        if (item.type === 'AgentMessage' && (item.phase === 'commentary' || item.phase === 'final_answer')) {
          let msgText = '';
          if (Array.isArray(item.content)) {
            msgText = item.content.filter(c => c && (c.type === 'text' || c.type === 'Text') && typeof c.text === 'string').map(c => c.text).join(' ');
          } else if (typeof item.content === 'string') {
            msgText = item.content;
          }
          fileState.lastAgentMessage = redactSecrets(msgText);
        } else if (item.type === 'CommandExecution' || item.type === 'McpToolCall') {
          fileState.lastGenericActivity = `Tool: ${item.type} (${item.status || 'executed'})`;
        }
      }
    } catch {}
  }
  return fileState;
}

export function readCodexDb(dbPath, workspaceRoot, threadTitles = {}, stateMap = new Map(), now = Date.now()) {
  const threads = [];
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { threads, error: 'Codex DB file not found or inaccessible' };
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('threads', 'sessions')").all();
    const tableName = tables.find(t => t.name === 'threads')?.name || tables.find(t => t.name === 'sessions')?.name;
    if (!tableName) {
      db.close();
      return { threads, error: 'No threads/sessions table found in Codex DB' };
    }
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
    const whitelist = ['id', 'rollout_path', 'cwd', 'model', 'reasoning_effort', 'updated_at', 'archived'];
    const selectCols = whitelist.filter(c => cols.includes(c));
    if (!selectCols.includes('id') || !selectCols.includes('cwd')) {
      db.close();
      return { threads, error: 'Required schema columns missing' };
    }
    const rows = db.prepare(`SELECT ${selectCols.join(', ')} FROM ${tableName}`).all();
    db.close();

    for (const row of rows) {
      if (!isPathInWorkspace(row.cwd, workspaceRoot)) continue;
      const safeTitle = threadTitles[row.id] || `Codex 執行緒 (${row.id.slice(0, 8)})`;
      let rolloutState = null;
      if (row.rollout_path) {
        rolloutState = readIncrementalRolloutLog(row.rollout_path, stateMap);
      }

      let status = 'UNKNOWN';
      let eventAt = formatTimestamp(row.updated_at);
      let finalModel = row.model || 'unknown';
      let effort = row.reasoning_effort || null;
      let publicProgress = null;

      if (rolloutState) {
        if (rolloutState.lastEventAt) eventAt = rolloutState.lastEventAt;
        if (rolloutState.model) finalModel = rolloutState.model;
        if (rolloutState.reasoningEffort) effort = rolloutState.reasoningEffort;
        publicProgress = rolloutState.lastAgentMessage || rolloutState.lastGenericActivity || null;

        if (rolloutState.lastBoundary === 'task_started') {
          status = 'RUNNING';
          if (eventAt && (now - new Date(eventAt).getTime() > 90000)) {
            status = 'STALE';
          }
        } else if (rolloutState.lastBoundary === 'task_complete') {
          status = 'COMPLETED';
        } else if (rolloutState.lastBoundary === 'turn_aborted') {
          status = 'IDLE';
        } else {
          status = 'UNKNOWN';
        }
      } else {
        status = 'UNKNOWN';
      }

      threads.push({
        id: row.id,
        rollout_path: row.rollout_path || null,
        cwd: row.cwd,
        model: finalModel,
        reasoning_effort: effort,
        updated_at: eventAt,
        archived: Boolean(row.archived),
        title: safeTitle,
        status,
        public_progress: publicProgress
      });
    }
    return { threads, error: null };
  } catch (err) {
    return { threads, error: err.message };
  }
}

export function scanPairedAttempts(phaseDir, attemptsCache = new Map()) {
  const attempts = [];
  if (!phaseDir || !fs.existsSync(phaseDir)) return attempts;
  try {
    const files = fs.readdirSync(phaseDir);
    const intentFiles = files.filter(f => f.endsWith('.intent.json'));

    for (const intFile of intentFiles) {
      const base = intFile.slice(0, -'.intent.json'.length);
      const intPath = path.join(phaseDir, intFile);
      let intent = null;
      try { intent = JSON.parse(fs.readFileSync(intPath, 'utf8')); } catch { continue; }

      let processInfo = null;
      const procPath = path.join(phaseDir, `${base}.process.json`);
      if (fs.existsSync(procPath)) {
        try { processInfo = JSON.parse(fs.readFileSync(procPath, 'utf8')); } catch {}
      }

      let terminalInfo = null;
      const termPath = path.join(phaseDir, `${base}.terminal.json`);
      if (fs.existsSync(termPath)) {
        try { terminalInfo = JSON.parse(fs.readFileSync(termPath, 'utf8')); } catch {}
      }

      let eventsSummary = attemptsCache.get(base) || {
        nativeInitModel: null,
        resultStatus: null,
        deniedActions: [],
        streamAuth403: false,
        lastEventAt: null,
        mtime: 0
      };

      const evPath = path.join(phaseDir, `${base}.events.jsonl`);
      if (fs.existsSync(evPath)) {
        const st = fs.statSync(evPath);
        if (st.mtimeMs > eventsSummary.mtime) {
          eventsSummary.mtime = st.mtimeMs;
          eventsSummary.eventTimeBasis = null;
          try {
            const readSize = Math.min(st.size, 512 * 1024);
            const fd = fs.openSync(evPath, 'r');
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, st.size - readSize);
            fs.closeSync(fd);
            const lines = buf.toString('utf8').split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const ev = JSON.parse(trimmed);
                if (ev.event === 'init' && ev.init?.model) {
                  eventsSummary.nativeInitModel = ev.init.model;
                }
                if (ev.event === 'result' && ev.result) {
                  eventsSummary.resultStatus = ev.result.status;
                  if (Array.isArray(ev.result.denied_actions)) {
                    eventsSummary.deniedActions = ev.result.denied_actions;
                  }
                }
                if ((ev.type === 'error' || ev.event === 'error') && ev.error) {
                  if (ev.error.status === 403 || ev.error.type === 'provider.auth') {
                    eventsSummary.streamAuth403 = true;
                    eventsSummary.streamAuthError = ev.error;
                  }
                }
                const t = formatTimestamp(ev.timestamp || ev.at_utc);
                if (t) {
                  eventsSummary.lastEventAt = t;
                  eventsSummary.eventTimeBasis = 'NATIVE';
                }
              } catch {}
            }
            if (eventsSummary.eventTimeBasis !== 'NATIVE' && lines.some(l => l.trim())) {
              eventsSummary.lastEventAt = new Date(st.mtimeMs).toISOString();
              eventsSummary.eventTimeBasis = 'FS_MTIME';
            }
            attemptsCache.set(base, eventsSummary);
          } catch {}
        }
      }

      const expPath = path.join(phaseDir, `${base}.export.json`);
      const hasExport = fs.existsSync(expPath);
      if (eventsSummary.nativeModelEvidence === 'OBSERVED_NATIVE_EXPORT') {
        eventsSummary.nativeInitModel = null;
        eventsSummary.nativeModelEvidence = null;
        eventsSummary.resultStatus = null;
      }
      eventsSummary.nativeExportError = null;
      if (hasExport) {
        try {
          const expData = JSON.parse(fs.readFileSync(expPath, 'utf8'));
          const expInfo = expData && expData.info;
          const expModel = expInfo && expInfo.model;
          const reqModel = intent && intent.model;
          let parsedReq = null;
          if (typeof reqModel === 'string') {
            const hIdx = reqModel.lastIndexOf('#');
            if (hIdx > 0 && hIdx < reqModel.length - 1) {
              const baseP = reqModel.slice(0, hIdx);
              const variant = reqModel.slice(hIdx + 1);
              const sIdx = baseP.indexOf('/');
              if (sIdx > 0 && sIdx < baseP.length - 1) {
                parsedReq = { providerID: baseP.slice(0, sIdx), id: baseP.slice(sIdx + 1), variant };
              }
            }
          }
          const hasReqFields = Boolean(parsedReq && parsedReq.providerID && parsedReq.id && parsedReq.variant);
          const hasExpFields = Boolean(expInfo && expInfo.id && expModel && expModel.providerID && expModel.id && expModel.variant);
          const sessionMatch = Boolean(hasExpFields && intent && intent.session_id && expInfo.id === intent.session_id);
          const modelMatch = Boolean(hasReqFields && hasExpFields &&
            parsedReq.providerID === expModel.providerID &&
            parsedReq.id === expModel.id &&
            parsedReq.variant === expModel.variant);

          if (sessionMatch && modelMatch) {
            eventsSummary.nativeInitModel = `${expModel.providerID}/${expModel.id}#${expModel.variant}`;
            eventsSummary.nativeModelEvidence = 'OBSERVED_NATIVE_EXPORT';
            eventsSummary.resultStatus = expInfo.outcome === 'succeeded' ? 'SUCCESS' : 'FAILED';
          } else {
            eventsSummary.nativeInitModel = null;
            eventsSummary.nativeModelEvidence = null;
            eventsSummary.resultStatus = 'FAILED';
            eventsSummary.nativeExportError = 'binding mismatch';
          }
        } catch {
          eventsSummary.nativeInitModel = null;
          eventsSummary.nativeModelEvidence = null;
          eventsSummary.resultStatus = 'FAILED';
          eventsSummary.nativeExportError = 'binding mismatch';
        }
        attemptsCache.set(base, eventsSummary);
      } else {
        attemptsCache.set(base, eventsSummary);
      }
      if (!('nativeModelEvidence' in eventsSummary)) eventsSummary.nativeModelEvidence = null;
      if (!('nativeExportError' in eventsSummary)) eventsSummary.nativeExportError = null;

      const isOpenCode = hasExport || Boolean(intent && (intent.session_id || (typeof intent.model === 'string' && intent.model.includes('#'))));
      let hasArtifact = false;
      const artPath = path.join(phaseDir, `${base}.artifact.json`);
      if (fs.existsSync(artPath)) {
        try {
          if (isOpenCode) {
            const raw = fs.readFileSync(artPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.files) && parsed.files.length > 0 &&
                parsed.files.every(f => f && typeof f.path === 'string' && f.path.trim().length > 0 && typeof f.content === 'string' && f.content.length > 0)) {
              hasArtifact = true;
            }
          } else {
            const parsed = JSON.parse(fs.readFileSync(artPath, 'utf8'));
            const vF = Array.isArray(parsed?.files) && parsed.files.length > 0 && parsed.files.every(f => f?.path?.trim() && typeof f.content === 'string');
            const vP = Array.isArray(parsed?.patches) && parsed.patches.length > 0 && parsed.patches.every(p => p?.path?.trim() && typeof p.find === 'string' && typeof p.replace === 'string');
            hasArtifact = Boolean(vF || vP);
          }
        } catch {}
      }

      let atUtc = formatTimestamp(intent.at_utc);
      if (!atUtc) {
        try { atUtc = fs.statSync(intPath).mtime.toISOString(); } catch {}
      }

      attempts.push({
        base,
        at_utc: atUtc,
        intent,
        processInfo,
        terminalInfo,
        eventsSummary,
        hasArtifact
      });
    }

    attempts.sort((a, b) => new Date(a.at_utc || 0).getTime() - new Date(b.at_utc || 0).getTime());
    return attempts;
  } catch {
    return attempts;
  }
}

export function evaluateWorkerState({
  attempt,
  osProcesses = [],
  policy = null,
  now = Date.now(),
  workerRole = 'W2'
}) {
  const {
    intent = {},
    processInfo = null,
    terminalInfo = null,
    eventsSummary = {},
    hasArtifact = false
  } = attempt || {};

  const taskId = intent.task || intent.task_id || 'UNKNOWN';
  const taskDesc = intent.task_description || intent.description || '';
  const requestedModel = intent.model || 'UNKNOWN';
  let actualModel = requestedModel;
  let modelEvidence = 'REQUESTED_ONLY';
  let status = 'UNKNOWN';
  let blocker = null;
  let next = null;
  let pid = processInfo ? processInfo.pid : null;
  let eventAt = (terminalInfo && formatTimestamp(terminalInfo.at_utc || terminalInfo.timestamp)) ||
    eventsSummary.lastEventAt ||
    (processInfo && formatTimestamp(processInfo.at_utc || processInfo.timestamp)) ||
    formatTimestamp(intent.at_utc) || null;

  if (eventsSummary.nativeInitModel) {
    actualModel = eventsSummary.nativeInitModel;
    modelEvidence = 'OBSERVED_NATIVE_INIT';
  }
  if(eventsSummary.nativeModelEvidence==='OBSERVED_NATIVE_EXPORT'&&eventsSummary.nativeInitModel){
    actualModel=eventsSummary.nativeInitModel;
    modelEvidence='OBSERVED_NATIVE_EXPORT';
  }

  if (workerRole === 'W1') {
    const w1Policy = policy?.w1 || policy?.worker1;
    const isHumanPaused = policy?.humanW1Paused === true || policy?.config?.humanW1Paused === true;
    if (isHumanPaused || w1Policy?.operational_state === 'PAUSED_BY_USER_REPEATED_ERROR_RULE' || w1Policy?.automatic_dispatch === false) {
      status = 'PAUSED';
      blocker = isHumanPaused ? '人類指令暫停 (Human Instruction PAUSED)' : (w1Policy?.pause_reason || w1Policy?.hold || 'Muse Spark XHIGH and Step 5 High both returned provider 403 FreeTierError');
      next = '用戶暫停規則生效，問題解決前不再發起派遣';
      return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
    }
  }

  const FAIL_STATUSES = ['FAILED', 'ERROR', 'CANCELLED', 'DENIED', 'INTERRUPTED', 'TIMED_OUT'];
  const sNorm = String(eventsSummary?.resultStatus || '').trim().toUpperCase();
  const tNorm = String(terminalInfo?.result?.status || terminalInfo?.resultStatus || '').trim().toUpperCase();
  const nExp = eventsSummary?.nativeExportError;
  const hasExpErr = nExp != null && String(nExp).trim() !== '';
  const isFailedOutcome = hasExpErr || FAIL_STATUSES.includes(sNorm) || FAIL_STATUSES.includes(tNorm);
  if (isFailedOutcome) {
    status = 'FAILED';
    blocker = '原生結果標記為失敗 (Native Result FAILED)';
    next = '重新派遣修正失敗';
    if (!/OBSERVED/.test(modelEvidence)) modelEvidence = 'HISTORICAL';
    return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
  }

  if (eventsSummary.deniedActions && eventsSummary.deniedActions.length > 0) {
    status = 'BLOCKED';
    blocker = `動作權限被拒絕 (Denied Actions: ${eventsSummary.deniedActions.join(', ')})`;
    next = '等待操作權限授權解除阻礙';
    return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
  }

  if(eventsSummary.streamAuth403){
    const rE=eventsSummary.streamAuthError||eventsSummary.streamAuth403;
    const rT=`${rE&&rE.name||''} ${rE&&rE.message||''} ${rE&&rE.type||''}${typeof rE==='string'?rE:''}`;
    const isFT=/FreeTierError|free.?tier/i.test(rT);
    status='BLOCKED';
    blocker=isFT?'授權失敗 FreeTierError tool-route':'授權不明 AUTH_UNKNOWN tool-route';
    next='builtinBuild送審不重試';
    if(!/OBSERVED/.test(modelEvidence))modelEvidence='REQUESTED_ONLY';
    return{taskId,taskDesc,requestedModel,actualModel,modelEvidence,status,blocker,next,pid,eventAt};
  }

  if (terminalInfo) {
    const isDenied = (terminalInfo.denied_actions && terminalInfo.denied_actions.length > 0) ||
      (terminalInfo.result?.denied_actions && terminalInfo.result.denied_actions.length > 0) ||
      terminalInfo.status === 'denied';
    const tE=terminalInfo.error||{};
    const tTxt=`${tE.name||''} ${tE.message||''} ${tE.type||''}`;
    const tSt=tE.status||tE.statusCode||terminalInfo.status_code||null;
    const isFree=/FreeTierError|free.?tier/i.test(tTxt);
    const isReg=/RegionError|region/i.test(tTxt);
    const isAuth403=tSt===403||tE.type==='provider.auth';
    const isQ429=tSt===429||/quota|429/i.test(tTxt);
    const isU503=tSt===503||/upstream|503/i.test(tTxt);
    const isResultSuccess=(tNorm==='SUCCESS'||sNorm==='SUCCESS');

    if (isDenied) {
      status = 'BLOCKED';
      blocker = '動作權限被拒絕 (Denied Actions)';
      next = '等待操作權限授權解除阻礙';
    }else if(isReg){
      status='BLOCKED';
      blocker='區域受限 RegionError tool-route';
      next='builtinBuild送審不重試';
      if(!/OBSERVED/.test(modelEvidence))modelEvidence='REQUESTED_ONLY';
    }else if(isQ429){
      status='BLOCKED';
      blocker='配額受限 Quota 429 tool-route';
      next='builtinBuild送審不重試';
      if(!/OBSERVED/.test(modelEvidence))modelEvidence='REQUESTED_ONLY';
    }else if(isU503){
      status='BLOCKED';
      blocker='上游異常 Upstream 503 tool-route';
      next='builtinBuild送審不重試';
    }else if(isAuth403){
      status='BLOCKED';
      blocker=isFree?'授權失敗 FreeTierError tool-route':'授權不明 AUTH_UNKNOWN tool-route';
      next='builtinBuild送審不重試';
      if(!/OBSERVED/.test(modelEvidence))modelEvidence='REQUESTED_ONLY';
    }else if(terminalInfo.exit_code === undefined || terminalInfo.exit_code === null){
      status = 'UNKNOWN';
      blocker = '終端退出碼缺失 (Missing exit_code)';
      next = '等待進程退出碼確認';
    }else if(terminalInfo.exit_code===0){
      if (!hasArtifact) {
        status = 'UNKNOWN';
        blocker = '終端退出碼0但工件缺失 (Artifact Missing)';
        next = '檢查原生交件與交件收據';
      } else if (!isResultSuccess) {
        status = 'UNKNOWN';
        blocker = '終端退出碼0但缺少原生成功結果 (Native Result Missing)';
        next = '等待原生結果確認';
      } else {
        status = 'COMPLETED';
        next = '源碼已生成，等待控制器審查與驗證';
      }
    } else {
      status = 'FAILED';
      blocker = `終端退出碼非 0 (${terminalInfo.exit_code})`;
      next = '重新派遣修正執行錯誤';
    }
    if(!/OBSERVED/.test(modelEvidence)){
      modelEvidence=(status==='BLOCKED'&&modelEvidence==='REQUESTED_ONLY')?'REQUESTED_ONLY':'HISTORICAL';
    }
    return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
  }

  if (pid) {
    const matchedProc = osProcesses.find(p => p.pid === pid);
    if (!matchedProc) {
      status = 'UNKNOWN';
      blocker = '無對應作業系統進程 (Orphan)';
      next = '進程已消失，等待狀態清理';
    } else {
      const procName = (matchedProc.name || '').toLowerCase();
      const expectedExe = workerRole === 'W1' ? /^opencode(-cli)?(\.exe)?$/i : /^agy(\.exe)?$/i;
      if (!expectedExe.test(procName)) {
        status = 'UNKNOWN';
        blocker = `進程可執行檔不匹配 (${matchedProc.name || 'unknown'}, 期望 ${workerRole === 'W1' ? 'opencode-cli' : 'agy'})`;
        next = '等待核實進程歸屬';
        return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
      }

      if (!matchedProc.created_at) {
        status = 'UNKNOWN';
        blocker = '進程創建時間缺失 (Missing creation time)';
        next = '等待進程元數據採集';
        return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
      }

      const procCreatedMs = new Date(matchedProc.created_at).getTime();
      if (isNaN(procCreatedMs)) {
        status = 'UNKNOWN';
        blocker = '進程創建時間無效 (Invalid creation time)';
        next = '等待有效進程元數據採集';
        return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
      }
      if (procCreatedMs > now + 5000) {
        status = 'UNKNOWN';
        blocker = '進程創建時間為未來時間 (Future creation time)';
        next = '等待系統時間校準';
        return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
      }

      if (policy?.osFresh === false || policy?.osFreshness === 'STALE' || policy?.osFreshness === 'ERROR' || policy?.osFreshness === 'UNKNOWN') {
        status = 'UNKNOWN';
        blocker = '作業系統採集數據過期或失敗，無法證實進程存活 (OS query expired/stale)';
        next = '等待作業系統進程刷新';
        return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
      }

      if (processInfo?.created_at) {
        const expProcMs = new Date(processInfo.created_at).getTime();
        if (isNaN(expProcMs) || expProcMs > now + 5000) {
          status = 'UNKNOWN';
          blocker = '進程預期創建時間無效 (Invalid processInfo.created_at)';
          next = '等待有效進程元數據採集';
          return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
        }
        if (Math.abs(procCreatedMs - expProcMs) > 5000) {
          status = 'UNKNOWN';
          blocker = '檢測到 PID 重複使用 (PID Reuse: processInfo mismatch)';
          next = '等待新進程啟動';
          return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
        }
      } else {
        if (!intent?.at_utc) {
          status = 'UNKNOWN';
          blocker = '缺少進程與意圖創建時間證明 (Missing creation & intent timestamp proof)';
          next = '等待有效任務意圖或進程元數據';
          return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
        }
        const intentUtcMs = new Date(intent.at_utc).getTime();
        if (isNaN(intentUtcMs) || intentUtcMs > now + 5000) {
          status = 'UNKNOWN';
          blocker = '意圖時間戳無效 (Invalid intent timestamp)';
          next = '等待有效任務意圖時間戳';
          return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
        }
        if (Math.abs(procCreatedMs - intentUtcMs) > 60000) {
          status = 'UNKNOWN';
          blocker = '檢測到 PID 重複使用 (PID Reuse outside ±60s)';
          next = '等待新進程啟動';
          return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
        }
      }

      if (!eventAt) {
        status = 'UNKNOWN';
        blocker = '缺少源事件時間更新 (Missing source event)';
        next = '等待工作者回傳首個事件';
      } else {
        const evMs = new Date(eventAt).getTime();
        if (isNaN(evMs)) {
          status = 'UNKNOWN';
          blocker = '源事件時間戳無效 (Invalid event timestamp)';
          next = '等待有效源事件更新';
        } else if (evMs > now + 5000) {
          status = 'UNKNOWN';
          blocker = '源事件時間戳為未來時間 (Future event timestamp)';
          next = '等待系統時間校準';
        } else {
          const age = now - evMs;
          if (age > 90000) {
            status = 'STALE';
            blocker = '超過90秒未收到源事件更新';
            next = '等待工作者回傳最新心跳或狀態事件';
          } else {
            status = 'RUNNING';
            next = '施工中，執行自定義任務指令';
          }
        }
      }
    }
  } else {
    status = 'PENDING';
    next = '等待進程初始化啟動';
  }

  return { taskId, taskDesc, requestedModel, actualModel, modelEvidence, status, blocker, next, pid, eventAt };
}

export function trackMaterialChanges(changeList, newSnapshot, prevSnapshot, maxEntries = 20) {
  if (!prevSnapshot) return;
  const changes = [];
  const nowIso = new Date().toISOString();

  const prevWorkers = new Map((prevSnapshot.workers || []).map(w => [w.id, w]));
  for (const w of newSnapshot.workers || []) {
    const old = prevWorkers.get(w.id);
    if (old && (old.status !== w.status || old.task !== w.task)) {
      changes.push(`工作者 ${w.name} 狀態變更: ${old.status} -> ${w.status} (${w.task || '無任務'})`);
    }
  }

  const prevTasks = new Map((prevSnapshot.tasks || []).map(t => [t.id, t]));
  for (const t of newSnapshot.tasks || []) {
    const old = prevTasks.get(t.id);
    if (old && (old.status !== t.status || old.head !== t.head)) {
      changes.push(`任務 ${t.title || t.id} 狀態變更: ${old.status} -> ${t.status}`);
    }
  }

  const prevHandoffs = new Map((prevSnapshot.handoffs || []).map(h => [h.id, h]));
  for (const h of newSnapshot.handoffs || []) {
    const old = prevHandoffs.get(h.id);
    if (old && old.status !== h.status) {
      changes.push(`交接 ${h.id} 狀態變更: ${old.status} -> ${h.status}`);
    }
  }

  for (const text of changes) {
    changeList.unshift({ at: nowIso, text });
    if (changeList.length > maxEntries) changeList.pop();
  }
}

export async function fetchGitHubActions(repo) {
  if (!repo) return { runs: [], status: 'DISABLED', error: 'No repo configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=10`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PTYSD-Observer/1.0', 'Accept': 'application/vnd.github.v3+json' }
    });
    clearTimeout(timer);
    if (res.status === 403 || res.status === 429) {
      return { runs: [], status: 'STALE', error: 'GitHub API 速率限制 (Rate limit reached)' };
    }
    if (!res.ok) {
      return { runs: [], status: 'FAILED', error: `GitHub API 響應錯誤: ${res.status}` };
    }
    const data = await res.json();
    const runs = (data.workflow_runs || []).map(r => ({
      id: r.id,
      name: r.name,
      head_sha: r.head_sha || '',
      status: (r.status || 'unknown').toUpperCase(),
      conclusion: r.conclusion ? r.conclusion.toUpperCase() : null,
      html_url: r.html_url,
      created_at: formatTimestamp(r.created_at),
      updated_at: formatTimestamp(r.updated_at)
    }));
    return { runs, status: 'MONITORING', error: null, collected_at: new Date().toISOString() };
  } catch (err) {
    return { runs: [], status: 'STALE', error: err.name === 'AbortError' ? 'GitHub 請求超時 (8s)' : 'GitHub 網絡不可達' };
  }
}

// Public, read-only GitHub canonical readback. A branch update between two reads
// fails the digest comparison instead of yielding a false accepted state.
export async function fetchGitHubCanonical(repo, ref = 'v45/factory-control', fetchImpl = fetch) {
  const result = { verified: false, status: 'UNKNOWN', collected_at: null, error: null, ref };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !/^[A-Za-z0-9_./-]+$/.test(ref || '') || ref.includes('..')) {
    return { ...result, error: 'GitHub canonical locator 無效' };
  }
  const api = `https://api.github.com/repos/${repo}/contents/`;
  const request = async (file) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    try {
      const url = api + file + `?ref=${encodeURIComponent(ref)}`;
      const response = await fetchImpl(url, { signal: abort.signal,
        headers: { 'User-Agent': 'PTYSD-Observer/1.0', 'Accept': 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string' ||
          envelope.size > 4 * 1024 * 1024) throw new Error('GitHub content invalid');
      const raw = Buffer.from(envelope.content.replace(/\s/g, ''), 'base64');
      if (raw.length > 4 * 1024 * 1024) throw new Error('GitHub content oversized');
      return { doc: JSON.parse(raw.toString('utf8')), raw, blob: envelope.sha };
    } finally { clearTimeout(timer); }
  };
  try {
    const { doc: pointer, blob, raw: pointerRaw } = await request('governance/csg/current.json');
    if (pointer.project_id !== 'CHATGPT_GLOBAL_SKILL_GOVERNANCE' ||
        !Number.isSafeInteger(pointer.checkpoint_seq) || pointer.checkpoint_seq < 1 ||
        !/^governance\/csg\/checkpoints\/[0-9]{6}\.json$/.test(pointer.checkpoint_path) ||
        !/^sha256:[0-9a-f]{64}$/.test(pointer.checkpoint_digest || '')) {
      throw new Error('GitHub pointer mismatch');
    }
    const checkpoint = await request(pointer.checkpoint_path);
    const digest = crypto.createHash('sha256').update(checkpoint.raw).digest('hex');
    if ('sha256:' + digest !== pointer.checkpoint_digest ||
        checkpoint.doc.project_id !== pointer.project_id ||
        checkpoint.doc.checkpoint_seq !== pointer.checkpoint_seq) {
      throw new Error('GitHub pointer/checkpoint inconsistency');
    }
    // Read the mutable pointer again after the checkpoint. A branch movement
    // between the first pointer and checkpoint reads must not be shown as live.
    // This is a bounded readback, not a claim that the branch cannot move later.
    const current = await request('governance/csg/current.json');
    if (current.blob !== blob || !current.raw.equals(pointerRaw)) {
      throw new Error('GitHub canonical pointer drift during readback');
    }
    return { ...result, verified: true, status: 'MONITORING',
      collected_at: new Date().toISOString(), pointer, checkpoint: checkpoint.doc,
      pointer_blob_sha: blob, checkpoint_blob_sha: checkpoint.blob };
  } catch (e) { return { ...result, error: redactSecrets(String(e.message)) }; }
}

export function executeVmSsh(config) {
  return new Promise(resolve => {
    if (!config.ssh || !config.vmHost || !config.vmUser || !config.vmKey || !config.vmKnownHosts) {
      return resolve({ status: 'DISABLED', data: null, error: 'VM SSH 參數未配置完整' });
    }
    const remoteCmd = 'uname -s -r -m; hostname; echo "===PROCESSES==="; ps -eo pid,user,comm --no-headers; echo "===TIMERS==="; systemctl --user list-timers --all --no-legend --no-pager 2>/dev/null; echo "===TIMERS_EXIT:$?==="';
    const args = [
      '-i', config.vmKey,
      '-o', `UserKnownHostsFile=${config.vmKnownHosts}`,
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      `${config.vmUser}@${config.vmHost}`,
      remoteCmd
    ];
    const child = childProcess.spawn(config.ssh, args, { timeout: 12000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', err => resolve({ status: 'FAILED', data: null, error: err.message }));
    child.on('close', code => {
      if (code === 0) {
        const raw = stdout.trim();
        const procIdx = raw.indexOf('===PROCESSES===');
        const timerIdx = raw.indexOf('===TIMERS===');
        const header = procIdx !== -1 ? raw.slice(0, procIdx).trim() : '';
        const PROC_MARKER = '===PROCESSES===';
        const TIMER_MARKER = '===TIMERS===';
        const EXIT_MARKER = '===TIMERS_EXIT:';
        const exitIdx = raw.indexOf(EXIT_MARKER);
        const procRaw = (procIdx !== -1 && timerIdx !== -1) ? raw.slice(procIdx + PROC_MARKER.length, timerIdx).trim() : '';
        const timerRaw = (timerIdx !== -1 && exitIdx !== -1) ? raw.slice(timerIdx + TIMER_MARKER.length, exitIdx).trim() : (timerIdx !== -1 ? raw.slice(timerIdx + TIMER_MARKER.length).trim() : '');
        let timerExitCode = null;
        if (exitIdx !== -1) {
          const codeStr = raw.slice(exitIdx + EXIT_MARKER.length).split('===')[0].trim();
          const parsed = parseInt(codeStr, 10);
          if (!Number.isNaN(parsed)) timerExitCode = parsed;
        }

        const processes = [];
        for (const line of procRaw.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            processes.push({ pid: parseInt(parts[0], 10), user: parts[1], comm: parts.slice(2).join(' ') });
          }
        }

        const timers = [];
        if (timerExitCode === 0) {
          for (const line of timerRaw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) timers.push(trimmed);
          }
        }

        resolve({
          status: 'MONITORING',
          data: {
            header,
            processes,
            timers: timerExitCode === 0 ? timers : null,
            timer_status: timerExitCode === 0 ? 'OK' : 'UNKNOWN'
          },
          error: null,
          collected_at: new Date().toISOString()
        });
      } else {
        resolve({ status: 'FAILED', data: null, error: `SSH 退出碼 ${code}` });
      }
    });
  });
}

export function executeWindowsCollector(config) {
  return new Promise(resolve => {
    const pwsh = config.powershell || 'pwsh.exe';
    const script = path.resolve(MODULE_DIR, 'collect.ps1');
    if (!fs.existsSync(script)) return resolve({ status: 'FAILED', data: null, error: 'collect.ps1 不存在' });
    const child = childProcess.spawn(pwsh, ['-NoProfile', '-NonInteractive', '-File', script], {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', err => resolve({ status: 'FAILED', data: null, error: err.message }));
    child.on('close', code => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ status: 'MONITORING', data: parsed, error: null, collected_at: parsed.collected_at || new Date().toISOString() });
        } catch {
          resolve({ status: 'FAILED', data: null, error: 'collect.ps1 輸出非合法 JSON' });
        }
      } else {
        resolve({ status: 'FAILED', data: null, error: `collect.ps1 退出碼 ${code}` });
      }
    });
  });
}

export function scanAutomations(automationRoot, workspaceRoot, controllerThreadId) {
  const automations = [];
  if (!automationRoot || !fs.existsSync(automationRoot)) return { automations, status: 'UNKNOWN' };
  try {
    const dirs = fs.readdirSync(automationRoot, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const tomlPath = path.join(automationRoot, d.name, 'automation.toml');
      if (fs.existsSync(tomlPath)) {
        const content = fs.readFileSync(tomlPath, 'utf8');
        let inScope = false;
        let hasScope = false;
        let kind = null;
        let targetThreadId = null;
        const normRoot = workspaceRoot ? path.resolve(workspaceRoot).toLowerCase() : null;
        const isMatch = target => {
          if (!target || !normRoot) return false;
          try {
            if (typeof isPathInWorkspace === 'function' && isPathInWorkspace(target, workspaceRoot)) return true;
          } catch {}
          const nTarget = path.resolve(target).toLowerCase();
          return nTarget === normRoot || nTarget.startsWith(normRoot + path.sep);
        };
        let inMultiline = null;
        let inTable = false;
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (inMultiline) {
            if (line.includes(inMultiline)) inMultiline = null;
            continue;
          }
          if (trimmed.includes('"""') && (trimmed.match(/"""/g) || []).length % 2 === 1) {
            inMultiline = '"""';
            continue;
          }
          if (trimmed.includes("'''") && (trimmed.match(/'''/g) || []).length % 2 === 1) {
            inMultiline = "'''";
            continue;
          }
          if (/^\[.+\]/.test(trimmed)) {
            inTable = true;
            continue;
          }
          if (!inTable) {
            if (/^(?:cwd|cwds)\s*=/i.test(trimmed)) {
              hasScope = true;
              for (const m of trimmed.matchAll(/["']([^"']+)["']/g)) {
                if (isMatch(m[1])) { inScope = true; break; }
              }
              if (inScope) break;
            }
            const km = trimmed.match(/^kind\s*=\s*["']([^"']+)["']/i);
            if (km) kind = km[1].trim();
            const tm = trimmed.match(/^target_thread_id\s*=\s*["']([^"']+)["']/i);
            if (tm) targetThreadId = tm[1].trim();
          }
        }
        if (!inScope && !hasScope && typeof controllerThreadId === 'string' && controllerThreadId.trim()) {
          if (kind && kind.toLowerCase() === 'heartbeat' && targetThreadId && targetThreadId === controllerThreadId.trim()) {
            inScope = true;
          }
        }
        if (inScope) {
          let autoStatus = 'UNKNOWN';
          const sMatch = content.match(/status\s*=\s*["']([^"']+)["']/i);
          if (sMatch) {
            const sVal = sMatch[1].trim().toUpperCase();
            if (sVal === 'ACTIVE' || sVal === 'RUNNING') autoStatus = 'MONITORING';
            else if (sVal === 'PAUSED' || sVal === 'DISABLED') autoStatus = 'PAUSED';
            else autoStatus = sVal;
          } else if (/enabled\s*=\s*false/i.test(content) || /active\s*=\s*false/i.test(content)) {
            autoStatus = 'PAUSED';
          } else if (/enabled\s*=\s*true/i.test(content) || /active\s*=\s*true/i.test(content)) {
            autoStatus = 'MONITORING';
          }
          let autoTask = d.name;
          const pMatch = content.match(/(?:prompt|task|description)\s*=\s*["']([^"']+)["']/i);
          if (pMatch) {
            autoTask = pMatch[1].trim().replace(/\s+/g, ' ').slice(0, 120);
          }
          if (typeof redactSecrets === 'function') autoTask = redactSecrets(autoTask);
          automations.push({ name: d.name, status: autoStatus, task: autoTask, path: tomlPath });
        }
      }
    }
    return { automations, status: automations.length > 0 ? 'MONITORING' : 'UNKNOWN' };
  } catch {
    return { automations: [], status: 'UNKNOWN' };
  }
}

export function mergeCollectorReadback(previous, result, attemptedAt = Date.now()) {
  const attemptIso = new Date(attemptedAt).toISOString();
  if (!result) {
    const out = {
      status: 'UNKNOWN',
      error: 'Collector failed',
      data: null
    };
    Object.defineProperties(out, {
      cached: { value: false, enumerable: false, writable: true, configurable: true },
      last_attempt_at: { value: attemptIso, enumerable: false, writable: true, configurable: true },
      observed_at: { value: null, enumerable: false, writable: true, configurable: true }
    });
    return out;
  }

  const isExplicitFailed = result.status === 'FAILED' || result.status === 'ERROR' || (Boolean(result.error) && result.status !== 'OK' && result.status !== 'MONITORING' && !result.data);

  if (!isExplicitFailed) {
    if (previous === null) {
      const out = { ...result };
      Object.defineProperties(out, {
        cached: { value: false, enumerable: false, writable: true, configurable: true },
        last_attempt_at: { value: attemptIso, enumerable: false, writable: true, configurable: true },
        observed_at: { value: result?.collected_at || attemptIso, enumerable: false, writable: true, configurable: true }
      });
      return out;
    }
    return {
      ...result,
      cached: false,
      last_attempt_at: attemptIso,
      observed_at: result?.collected_at || attemptIso
    };
  }

  const rawErr = result?.error?.message || result?.error || 'Collector failed';
  const errStr = typeof redactSecrets === 'function' ? redactSecrets(String(rawErr)) : String(rawErr);
  const hasPrevData = previous && (previous.data != null || (Array.isArray(previous.runs) && previous.runs.length > 0));

  if (hasPrevData) {
    return {
      ...previous,
      status: 'STALE',
      error: errStr,
      cached: true,
      last_attempt_at: attemptIso,
      collected_at: previous.collected_at !== undefined ? previous.collected_at : previous.updated_at,
      observed_at: previous.observed_at || previous.collected_at || previous.updated_at || null
    };
  }

  return {
    status: 'UNKNOWN',
    error: errStr,
    data: null,
    cached: false,
    last_attempt_at: attemptIso,
    observed_at: null,
    ...(previous && Array.isArray(previous.runs) ? { runs: [] } : (result && Array.isArray(result.runs) ? { runs: [] } : {}))
  };
}

export function attemptOwner(a) {
  if (!a) return 'UNKNOWN';
  const toRole = val => {
    if (!val || typeof val !== 'string') return null;
    const s = val.toLowerCase().trim();
    const isW1 = s.includes('step') || s.includes('bunny') || s.includes('muse') || s.includes('opencode') || s === 'w1' || s === 'worker-w1';
    const isW2 = s.includes('gemini') || s === 'w2' || s === 'worker-w2';
    if (isW1 && !isW2) return 'W1';
    if (isW2 && !isW1) return 'W2';
    return null;
  };
  const obs = toRole(a.eventsSummary?.nativeInitModel);
  const req = toRole(a.intent?.model);
  const exp = toRole(a.intent?.to);
  const detected = [obs, req, exp].filter(Boolean);
  if (detected.length === 0) return 'UNKNOWN';
  const unique = new Set(detected);
  if (unique.size === 1) return unique.values().next().value;
  return 'UNKNOWN';
}

export function buildDashboardState(ctx) {
  const now = ctx.now || Date.now();
  const nowIso = new Date(now).toISOString();
  const config = ctx.config || {};
  const phaseDir = config.phase || '';

  let policy = null;
  let policyError = null;
  let policyMtime = null;
  let policyReadAt = null;
  const policyPath = phaseDir ? path.join(phaseDir, 'controller-dispatch-policy.json') : '';
  if (phaseDir && fs.existsSync(policyPath)) {
    try {
      policyMtime = fs.statSync(policyPath).mtime.toISOString();
      policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      policyReadAt = nowIso;
    } catch (e) {
      policyError = `controller-dispatch-policy.json 解析錯誤: ${e.message}`;
    }
  }
  if (config?.humanW1Paused) {
    policy = Object.assign({}, policy, { humanW1Paused: true, config });
  }

  let roundStatus = null;
  let roundStatusError = null;
  let roundStatusMtime = null;
  let roundStatusReadAt = null;
  const roundPath = phaseDir ? path.join(phaseDir, 'round-status.json') : '';
  if (phaseDir && fs.existsSync(roundPath)) {
    try {
      roundStatusMtime = fs.statSync(roundPath).mtime.toISOString();
      roundStatus = JSON.parse(fs.readFileSync(roundPath, 'utf8'));
      roundStatusReadAt = nowIso;
    } catch (e) {
      roundStatusError = `round-status.json 解析錯誤: ${e.message}`;
    }
  }

  let handoffsDoc = null;
  let handoffsError = null;
  let handoffsMtime = null;
  let handoffsReadAt = null;
  const handoffsPath = phaseDir ? path.join(phaseDir, 'monitor-ownership-and-handoffs.json') : '';
  if (phaseDir && fs.existsSync(handoffsPath)) {
    try {
      handoffsMtime = fs.statSync(handoffsPath).mtime.toISOString();
      handoffsDoc = JSON.parse(fs.readFileSync(handoffsPath, 'utf8'));
      handoffsReadAt = nowIso;
    } catch (e) {
      handoffsError = `monitor-ownership-and-handoffs.json 解析錯誤: ${e.message}`;
    }
  }

  const codex = ctx.codexData || { threads: [] };
  const winRaw = ctx.windowsData || {};
  const win = winRaw.data || winRaw || {};
  const vmRaw = ctx.vmData || {};
  const vm = vmRaw.data || {};
  const gh = ctx.githubData || { runs: [], status: 'UNKNOWN' };

  const winTtls = (config.sourceTtls && config.sourceTtls.windows) || 60;
  const winObserved = winRaw.observed_at || winRaw.collected_at || win.collected_at || (ctx.winLastRun ? new Date(ctx.winLastRun).toISOString() : null);
  const winErrors = Array.isArray(win.errors) ? win.errors : [];
  const sectionErrors = win.section_errors && typeof win.section_errors === 'object' ? win.section_errors : {};
  const sectionAt = win.section_collected_at && typeof win.section_collected_at === 'object' ? win.section_collected_at : null;
  const procError = sectionErrors.processes || winErrors.find(e =>
    typeof e === 'string' && /^processes\s*:/i.test(e)) || null;
  // A new aggregate timestamp never upgrades a failed process query to FRESH.
  const processObserved = sectionAt ? sectionAt.processes : winObserved;
  const osFreshness = evaluateFreshness({
    observed_at: processObserved,
    ttl_seconds: winTtls,
    error: winRaw.error || procError,
    cached: Boolean(winRaw.cached),
    now
  });
  const osFresh = osFreshness === 'FRESH';
  const windowsSectionFreshness = {};
  for (const section of ['processes', 'scheduled_tasks', 'services', 'vms']) {
    const error = sectionErrors[section] || winErrors.find(e =>
      typeof e === 'string' && e.toLowerCase().startsWith(section.toLowerCase() + ':')) || null;
    windowsSectionFreshness[section] = evaluateFreshness({
      observed_at: sectionAt ? sectionAt[section] : winObserved,
      ttl_seconds: winTtls, error: winRaw.error || error,
      cached: Boolean(winRaw.cached), now
    });
  }
  const windowsOverviewFreshness = Object.values(windowsSectionFreshness).every(v => v === 'FRESH')
    ? 'FRESH'
    : (Object.values(windowsSectionFreshness).some(v => v === 'FRESH') ? 'PARTIAL' : osFreshness);


  policy = Object.assign({}, policy, {
    osFresh,
    osFreshness
  });

  const attempts = (ctx.phaseAttempts || []).filter(a => {
    const intent = a?.intent || {};
    const m = (intent.model || '').toLowerCase();
    const tid = (intent.task || intent.task_id || '').toLowerCase();
    return (
      m.includes('gemini') || m.includes('step') || m.includes('bunny') || m.includes('muse') ||
      tid.includes('w1') || tid.includes('w2') || tid.includes('monitor')
    );
  });
  const changes = ctx.changes || [];
  const alerts = [];

  if (codex.error) {
    alerts.push(`Codex DB 錯誤: ${codex.error}`);
  }
  if (policyError) {
    alerts.push(policyError);
  }
  if (roundStatusError) {
    alerts.push(roundStatusError);
  }
  if (handoffsError) {
    alerts.push(handoffsError);
  }

  const workers = [];
  const ctrlThread = codex.threads.find(t => t.id === config.controllerThread);
  const ctrlTask = ctrlThread?.public_progress || roundStatus?.current_task?.description || '外包施工治理監控與工作交接協調';
  const ctrlNext = roundStatus?.current_task?.controller || roundStatus?.current_task?.state || roundStatus?.next_responsibility?.[0]?.item || '監聽外部工作者源碼提交與測試驗證';

  workers.push({
    id: config.controllerThread || 'controller-main',
    name: '調度控制器 (Controller)',
    kind: 'controller',
    status: ctrlThread ? ctrlThread.status : 'UNKNOWN',
    model_evidence: (ctrlThread && ctrlThread.status === 'RUNNING') ? 'OBSERVED_NATIVE_INIT' : 'HISTORICAL',
    task: ctrlTask,
    next: ctrlNext,
    model: ctrlThread ? ctrlThread.model : 'controller-dispatch',
    reasoning: ctrlThread ? ctrlThread.reasoning_effort : null,
    source: 'state_5.sqlite',
    observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
    event_at: ctrlThread ? ctrlThread.updated_at : null,
    pid: null,
    blocker: codex.error || null,
    scope: config.workspace || ''
  });

  for (const t of codex.threads) {
    if (t.id === config.controllerThread || t.archived || t.status === 'archived') continue;
    workers.push({
      id: t.id,
      name: t.title,
      kind: 'agent',
      status: t.status,
      task: t.public_progress || t.title,
      next: null,
      model: t.model,
      model_evidence: t.model_evidence || (t.status === 'RUNNING' ? 'OBSERVED_NATIVE_INIT' : 'HISTORICAL'),
      reasoning: t.reasoning_effort || null,
      source: 'state_5.sqlite',
      observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
      event_at: t.updated_at,
      pid: null,
      blocker: null,
      scope: t.cwd
    });
  }

  const w1Attempts = attempts.filter(a => attemptOwner(a) === 'W1');
  const w1Latest = w1Attempts.length > 0 ? w1Attempts[w1Attempts.length - 1] : null;
  const w1Eval = evaluateWorkerState({
    attempt: w1Latest,
    osProcesses: win.processes || [],
    policy,
    now,
    workerRole: 'W1'
  });

  workers.push({
    id: 'worker-w1',
    name: '施工工作者 W1 (OpenCode)',
    kind: 'worker',
    status: w1Eval.status,
    task: w1Eval.taskDesc || w1Eval.taskId,
    next: w1Eval.next,
    model: w1Eval.actualModel,
    model_evidence: w1Eval.modelEvidence || null,
    reasoning: w1Latest?.intent?.effort || w1Latest?.intent?.reasoning || w1Latest?.intent?.variant || 'UNKNOWN',
    source: w1Latest ? `${w1Latest.base}.intent.json` : 'round-status.json',
    observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
    event_at: w1Eval.eventAt,
    pid: w1Eval.pid,
    blocker: w1Eval.blocker,
    scope: config.phase || ''
  });

  // Host source lane, worker-w1 only, evaluated once per build from the real
  // controller dispatch policy (policy.w1). Nested refs and round-status
  // probes are not authoritative for this lane.
  __r3BlockedMemoReset();
  const w1Worker = workers[workers.length - 1];
  if (w1Worker && w1Worker.id === 'worker-w1') {
    const lane = __r3HostSourceLane(config.phase || '', (policy && policy.w1) || null, w1Worker.status);
    w1Worker.host_source_ready = lane.ready;
    w1Worker.resumption_evidence = lane.evidence;
    w1Worker.latest_result = w1Worker.task || 'UNKNOWN';
  }

  const w2Attempts = attempts.filter(a => attemptOwner(a) === 'W2');

  const w2Active = [...w2Attempts].reverse().find(a => {
    const ev = evaluateWorkerState({ attempt: a, osProcesses: win.processes || [], policy, now, workerRole: 'W2' });
    return ev.status === 'RUNNING';
  }) || (w2Attempts.length > 0 ? w2Attempts[w2Attempts.length - 1] : null);

  const w2Eval = evaluateWorkerState({
    attempt: w2Active,
    osProcesses: win.processes || [],
    policy,
    now,
    workerRole: 'W2'
  });

  workers.push({
    id: 'worker-w2',
    name: `施工工作者 W2 (${policy?.w2?.current_user_named_model || 'Antigravity'})`,
    kind: 'worker',
    status: w2Eval.status,
    task: w2Eval.taskDesc || w2Eval.taskId,
    next: w2Eval.next,
    model: w2Eval.actualModel,
    model_evidence: w2Eval.modelEvidence || null,
    reasoning: w2Active?.intent?.effort || w2Active?.intent?.reasoning || w2Active?.intent?.variant || 'UNKNOWN',
    source: w2Active ? (w2Active.eventsSummary?.eventTimeBasis === 'FS_MTIME' ? `${w2Active.base}.events.jsonl (filesystem mtime)` : `${w2Active.base}.intent.json`) : 'round-status.json',
    observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
    event_at: w2Eval.eventAt,
    pid: w2Eval.pid,
    blocker: w2Eval.blocker,
    scope: config.phase || ''
  });

  for (const a of w2Attempts) {
    const ev = evaluateWorkerState({ attempt: a, osProcesses: win.processes || [], policy, now, workerRole: 'W2' });
    if (ev.status === 'RUNNING' || ev.status === 'STALE') {
      const taskDesc = ev.taskDesc || ev.taskId || a.intent?.task || a.intent?.task_id || '施工任務';
      const rowSource = a.eventsSummary?.eventTimeBasis === 'FS_MTIME'
        ? `${a.base}.events.jsonl (filesystem mtime)`
        : `${a.base}.intent.json`;
      workers.push({
        id: `worker-w2-${a.base}`,
        name: `W2｜${taskDesc}`,
        kind: 'worker',
        status: ev.status,
        task: taskDesc,
        next: ev.next,
        model: ev.actualModel,
        model_evidence: ev.modelEvidence || null,
        reasoning: a.intent?.effort || a.intent?.reasoning || a.intent?.variant || 'UNKNOWN',
        source: rowSource,
        observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
        event_at: ev.eventAt,
        pid: ev.pid,
        blocker: ev.blocker,
        scope: config.phase || ''
      });
    }
  }

  const w3File = path.join(phaseDir, 'w3-host-vm-readonly.dispatch.json');
  let receipt = null;
  if (fs.existsSync(w3File)) {
    try {
      const p = JSON.parse(fs.readFileSync(w3File, 'utf8'));
      receipt = (p && typeof p === 'object' && p.receipt && typeof p.receipt === 'object') ? p.receipt : p;
    } catch { receipt = null; }
  }
  const isValidReceipt = Boolean(
    receipt && typeof receipt === 'object' && receipt.worker === 'W3' && receipt.route === 'chatgpt-web/zero-risk' &&
    typeof receipt.task_id === 'string' && receipt.task_id.startsWith('W3-R3-') &&
    typeof receipt.agent_id === 'string' && receipt.agent_id.trim().length > 0 &&
    typeof receipt.at_utc === 'string' && !Number.isNaN(Date.parse(receipt.at_utc))
  );
  let status = 'UNKNOWN', next = '等待日間人類操作者在場確認', blocker = '人類在場狀態未被觀察到 (Human presence not observed)';
  let task = (isValidReceipt && receipt?.task_id) ? (policy?.w3 ? `${receipt.task_id} (${policy.w3})` : receipt.task_id) : (policy?.w3 || 'NOT_DISPATCHED_NIGHT');
  if (isValidReceipt) {
    const isTimeout = String(receipt.handoff || '').includes('TIMEOUT') || String(receipt.execution || '').includes('TIMEOUT');
    const isReview = receipt.outcome === 'SOURCE_EVIDENCE_RETURNED_REVIEW_REQUIRED';
    if (isTimeout) {
      status = 'BLOCKED'; next = '人工重新貼上提示詞 (Manual prompt paste action required)';
      blocker = '交接逾時，需人工在 Web 端貼上提示詞 (Handoff timeout; explicit paste action required)';
    } else if (isReview) {
      status = 'UNKNOWN'; next = '控制器審查來源證據 (Controller review source evidence)'; blocker = null;
    } else if (receipt.outcome === 'COMPLETED') {
      let ok = false; const res = receipt.result;
      if (res && typeof res === 'object' && res.task_id === receipt.task_id && res.controller_verdict === 'ACCEPTED_BOUNDED_READONLY_EVIDENCE') {
        try {
          const phaseReal = fs.realpathSync(phaseDir);
          const isUnder = p => { const pr = phaseReal.toLowerCase(), pl = p.toLowerCase(); return pl === pr || pl.startsWith(pr + path.sep); };
          const revCand = path.resolve(phaseDir, res.controller_review || '');
          const rcpCand = path.resolve(res.receipt_path || '');
          if (revCand.toLowerCase().endsWith('.json') && rcpCand.toLowerCase().endsWith('.json')) {
            const revReal = fs.realpathSync(revCand), rcpReal = fs.realpathSync(rcpCand);
            if (isUnder(revReal) && isUnder(rcpReal) && revReal.toLowerCase().endsWith('.json') && rcpReal.toLowerCase().endsWith('.json')) {
              const rev = JSON.parse(fs.readFileSync(revReal, 'utf8')), buf = fs.readFileSync(rcpReal);
              const sha = crypto.createHash('sha256').update(buf).digest('hex'), rcpJ = JSON.parse(buf.toString('utf8'));
              const idOk = rev.task_id === receipt.task_id && rev.worker === receipt.worker && rev.agent_id === receipt.agent_id &&
                rev.outcome === 'ACCEPTED_BOUNDED_READONLY_EVIDENCE' && rcpJ.task_id === receipt.task_id;
              const aRes = res.acceptance || {}, aRev = rev.acceptance || {};
              const accEqual = aRes.T15 === 'UNKNOWN' && aRes.T23 === 'UNKNOWN' && aRes.T24 === 'NOT_PASSED' &&
                aRev.T15 === 'UNKNOWN' && aRev.T23 === 'UNKNOWN' && aRev.T24 === 'NOT_PASSED' &&
                rcpJ.T15?.status === 'UNKNOWN' && rcpJ.T23?.status === 'UNKNOWN' && rcpJ.T24?.status === 'NOT_PASSED';
              const revFiles = Array.isArray(rev.files) ? rev.files : [];
              const revFile = revFiles.find(f => {
                const fp = String(f?.path || '');
                return path.basename(fp).toLowerCase() === path.basename(rcpReal).toLowerCase() || f?.sha256 === sha;
              });
              const shaOk = sha === res.receipt_sha256 && revFile && revFile.sha256 === sha;
              if (idOk && accEqual && shaOk) ok = true;
            }
          }
        } catch {}
      }
      if (ok) {
        status = 'COMPLETED';
        task = `${receipt.task_id} (bounded readonly; T15/T23 UNKNOWN, T24 NOT_PASSED)`;
        next = receipt.next || 'W2監控修復;Controller既有SSH收據讀回;Human權限受阻'; blocker = null;
      } else {
        status = 'UNKNOWN'; next = '等待有效完成結果與控制器審查'; blocker = '完成結果驗證失敗或證據不符 (Missing or invalid completion result)';
      }
    } else if (receipt.execution === 'RUNNING_NATIVE_TOOLS_OBSERVED' && receipt.handoff === 'HUMAN_SENT_ZERO_RISK_CONNECTED' && Number.isSafeInteger(receipt.actual_tool_calls_observed) && receipt.actual_tool_calls_observed > 0) {
      const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : (now ? new Date(now).getTime() : Date.now()));
      const ageMin = (nowMs - new Date(receipt.at_utc).getTime()) / 60000;
      if (ageMin >= 0 && ageMin <= 5) {
        status = 'RUNNING'; next = '觀察原生工具執行進度與回傳結果 (Monitor native tool execution & results)'; blocker = null;
      } else {
        status = 'STALE'; next = '檢查心跳逾時與連線狀態 (Check heartbeat timeout & session)'; blocker = '事件回傳已逾時 (>5 分鐘) (Heartbeat stale)';
      }
    } else if (receipt.handoff === 'HUMAN_SENT_ZERO_RISK_CONNECTED') {
      status = 'CONNECTED'; next = '等待原生工具呼叫觀察 (Wait for native tool calls to be observed)'; blocker = '已連線但原生工具呼叫尚未被觀察到 (Connected only; native tool calls not observed)';
    } else {
      status = 'UNKNOWN'; next = '等待原生工具執行觀察 (Wait for native tool execution)'; blocker = '執行狀態尚未被確認 (Execution not confirmed)';
    }
  }
  workers.push({
    id: 'worker-w3', name: '工作者 W3 (人類承包商)', kind: 'human', status, task, next,
    model: 'chatgpt-web/zero-risk; Web model UNKNOWN', reasoning: null, source: 'w3-host-vm-readonly.dispatch.json',
    observed_at: nowIso, event_at: isValidReceipt ? receipt.at_utc : null, pid: null, blocker, scope: config.workspace || ''
  });

  const mechanics = [
    {
      id: 'mech-observer',
      name: '進程自身觀察機制 (Observer Core)',
      status: 'MONITORING',
      task: '唯讀狀態聚合與 HTTP 伺服服務',
      source: 'server.mjs',
      observed_at: nowIso,
      event_at: nowIso,
      next_run: null,
      last_run: nowIso,
      last_result: 0,
      error: null
    },
    {
      id: 'mech-collector-local',
      name: '本地元數據採集器',
      status: codex.error ? 'UNKNOWN' : 'MONITORING',
      task: '採集 SQLite、回執與日誌 tail (每 3 秒)',
      source: 'node:fs / node:sqlite',
      observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
      event_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : nowIso,
      next_run: ctx.localScheduledNext ? new Date(ctx.localScheduledNext).toISOString() : null,
      last_run: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : null,
      last_result: codex.error ? 1 : 0,
      error: codex.error || null
    },
    {
      id: 'mech-collector-windows',
      name: 'Windows 作業系統採集器',
      status: winRaw.status || 'UNKNOWN',
      task: 'Win32 進程、排程與服務採集 (每 30 秒)',
      source: 'collect.ps1',
      observed_at: ctx.winLastRun ? new Date(ctx.winLastRun).toISOString() : nowIso,
      event_at: winRaw.collected_at || null,
      next_run: ctx.winScheduledNext ? new Date(ctx.winScheduledNext).toISOString() : null,
      last_run: ctx.winLastRun ? new Date(ctx.winLastRun).toISOString() : null,
      last_result: winRaw.error ? 1 : 0,
      error: winRaw.error || null
    },
    {
      id: 'mech-collector-vm',
      name: 'VM SSH 狀態回讀器',
      status: vmRaw.status || 'UNKNOWN',
      task: 'SSH 嚴格固定唯讀查詢 (每 60 秒)',
      source: 'ssh.exe',
      observed_at: ctx.vmLastRun ? new Date(ctx.vmLastRun).toISOString() : nowIso,
      event_at: vmRaw.collected_at || null,
      next_run: ctx.vmScheduledNext ? new Date(ctx.vmScheduledNext).toISOString() : null,
      last_run: ctx.vmLastRun ? new Date(ctx.vmLastRun).toISOString() : null,
      last_result: vmRaw.status === 'MONITORING' ? 0 : 1,
      error: vmRaw.error || null
    },
    {
      id: 'mech-collector-github',
      name: 'GitHub CI 狀態採集器',
      status: gh.status || 'UNKNOWN',
      task: '公開 GitHub Actions 工作流狀態 (每 180 秒)',
      source: 'https://api.github.com',
      observed_at: ctx.ghLastRun ? new Date(ctx.ghLastRun).toISOString() : nowIso,
      event_at: gh.collected_at || null,
      next_run: ctx.ghScheduledNext ? new Date(ctx.ghScheduledNext).toISOString() : null,
      last_run: ctx.ghLastRun ? new Date(ctx.ghLastRun).toISOString() : null,
      last_result: gh.status === 'MONITORING' ? 0 : 1,
      error: gh.error || null
    }
  ];

  const isWinStale = windowsOverviewFreshness !== 'FRESH';
  for (const err of (win.errors || [])) {
    const rawErrMsg = err.message || err.error || String(err);
    const safeErrMsg = typeof redactSecrets === 'function' ? redactSecrets(rawErrMsg) : rawErrMsg;
    mechanics.push({
      id: `win-err-${err.code || err.name || mechanics.length}`,
      name: `Windows 錯誤: ${err.name || err.code || '系統異常'}`,
      status: 'UNKNOWN',
      task: safeErrMsg,
      source: 'Windows',
      observed_at: winRaw.collected_at || nowIso,
      event_at: null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: safeErrMsg
    });
  }
  for (const hvm of (win.vms || win.hyperv || win.hyperv_vms || [])) {
    const hState = (hvm.state || '').toUpperCase();
    const hName = hvm.name || hvm.id || '權限未知';
    mechanics.push({
      id: `hyperv-vm-${hvm.name || hvm.id || mechanics.length}`,
      name: `Hyper-V VM: ${hName}`,
      status: isWinStale ? 'STALE' : (hState === 'RUNNING' ? 'MONITORING' : (hState || 'UNKNOWN')),
      task: `虛擬機狀態: ${hvm.state || 'UNKNOWN'}`,
      source: 'Hyper-V',
      observed_at: winRaw.collected_at || nowIso,
      event_at: null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: hvm.error || null
    });
  }
  const attemptsList = (typeof attempts !== 'undefined' && attempts) ? attempts : ((config && config.attempts) || []);
  for (const p of win.processes || []) {
    let procTask = 'duty UNKNOWN unless assigned';
    if (p.pid === process.pid) {
      procTask = '監控觀測器主進程 (自身職責)';
    } else {
      const matchedAttempt = attemptsList.find(a => a && a.processInfo && a.processInfo.pid === p.pid);
      if (matchedAttempt) {
        let isVerified = true;
        if (typeof evaluateWorkerState === 'function') {
          const st = evaluateWorkerState({
            attempt: matchedAttempt,
            osProcesses: [p],
            workerRole: attemptOwner(matchedAttempt),
            now,
            policy
          });
          const stName = (typeof st === 'string' ? st : (st && (st.status || st.state))) || '';
          isVerified = ['RUNNING', 'STALE'].includes(String(stName).toUpperCase());
        }
        if (isVerified) {
          procTask = (matchedAttempt.intent && matchedAttempt.intent.task_description) || matchedAttempt.task_description || '工作進程 (Worker)';
        }
      }
    }
    mechanics.push({
      id: `win-proc-${p.pid}`,
      name: `進程: ${p.name} (PID ${p.pid})`,
      status: isWinStale ? 'STALE' : 'RUNNING',
      task: procTask,
      source: p.path || 'Win32_Process',
      observed_at: winRaw.collected_at || nowIso,
      event_at: p.created_at || null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: null
    });
  }

  for (const t of win.scheduled_tasks || []) {
    const isStateDisabled = (t.state || '').toUpperCase() === 'DISABLED';
    const isReadyOrRunning = (t.state || '').toUpperCase() === 'READY' || (t.state || '').toUpperCase() === 'RUNNING';
    const taskStatus = isStateDisabled ? 'DISABLED' : (isReadyOrRunning ? 'MONITORING' : 'IDLE');
    mechanics.push({
      id: `task-${t.name}`,
      name: `排程任務: ${t.name}`,
      status: taskStatus,
      task: t.action || t.name,
      source: t.path || 'Win32_ScheduledTask',
      observed_at: winRaw.collected_at || nowIso,
      event_at: t.last_run || null,
      next_run: isStateDisabled ? null : (t.next_run || null),
      last_run: t.last_run || null,
      last_result: t.last_result,
      error: t.error || null
    });
  }

  for (const s of win.services || []) {
    const isSvcDisabled = (s.start_type || s.StartType || s.start_mode || '').toUpperCase() === 'DISABLED';
    const svcRunning = (s.status || '').toUpperCase() === 'RUNNING';
    const svcStatus = isWinStale ? 'STALE' : (isSvcDisabled ? 'DISABLED' : (svcRunning ? 'MONITORING' : 'IDLE'));
    const svcTask = (s.name === 'ServiceRunner' || s.display_name === 'ServiceRunner')
      ? '執行背景排程與自動化工作'
      : (s.description || `服務職責: ${s.name}`);
    mechanics.push({
      id: `win-svc-${s.name}`,
      name: `系統服務: ${s.display_name || s.name}`,
      status: svcStatus,
      task: svcTask,
      source: 'Win32_Service',
      observed_at: winRaw.collected_at || nowIso,
      event_at: null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: null
    });
  }

  const isVmStale = vmRaw.status === 'FAILED' || vmRaw.status === 'STALE' || Boolean(vmRaw.cached);
  if (vm.header) {
    mechanics.push({
      id: 'mech-vm-header',
      name: 'VM 主機資訊',
      status: isVmStale ? 'STALE' : 'MONITORING',
      task: vm.header,
      source: 'uname/hostname',
      observed_at: vmRaw.collected_at || nowIso,
      event_at: null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: null
    });
  }
  const vmProcRegex = /agy|opencode|node|runner|cloudflared|ssh/i;
  for (const p of vm.processes || []) {
    if (vmProcRegex.test(p.comm || '')) {
      mechanics.push({
        id: `vm-proc-${p.pid}`,
        name: `VM 進程: ${p.comm} (PID ${p.pid})`,
        status: isVmStale ? 'STALE' : 'RUNNING',
        task: `用戶: ${p.user}, 指令: ${p.comm}`,
        source: 'ps',
        observed_at: vmRaw.collected_at || nowIso,
        event_at: null,
        next_run: null,
        last_run: null,
        last_result: null,
        error: null
      });
    }
  }
  if (vm.timers || vm.timer_status === 'UNKNOWN') {
    const timersFailed = vm.timers === null || vm.timer_status === 'UNKNOWN';
    mechanics.push({
      id: 'mech-vm-timers',
      name: 'VM User Timers (systemctl --user)',
      status: timersFailed ? 'UNKNOWN' : (isVmStale ? 'STALE' : (vm.timers.length > 0 ? 'MONITORING' : 'IDLE')),
      task: timersFailed ? '定時器獲取失敗' : `定時器總數: ${vm.timers.length}`,
      source: 'systemctl',
      observed_at: vmRaw.collected_at || nowIso,
      event_at: null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: timersFailed ? (vm.timer_error || 'systemctl error') : null
    });
    if (Array.isArray(vm.timers)) {
      for (let i = 0; i < vm.timers.length; i++) {
        const t = vm.timers[i];
        const tParts = typeof t === 'string' ? t.trim().split(/\s+/) : [];
        const tUnit = tParts.length >= 2 ? tParts[tParts.length - 2] : `timer-${i}`;
        mechanics.push({
          id: `vm-timer-${i}`,
          name: `VM 定時器: ${tUnit}`,
          status: isVmStale ? 'STALE' : 'MONITORING',
          task: typeof t === 'string' ? t : (t.action || t.name || 'native timer'),
          source: 'systemctl',
          observed_at: vmRaw.collected_at || nowIso,
          event_at: null,
          next_run: null,
          last_run: null,
          last_result: null,
          error: null
        });
      }
    }
  }

  const autoScan = scanAutomations(config.automationRoot, config.workspace, config.controllerThread);
  for (const auto of autoScan.automations) {
    mechanics.push({
      id: `mech-auto-${auto.name}`,
      name: `自動化: ${auto.name}`,
      status: auto.status,
      task: auto.task || auto.name,
      source: auto.path || 'automation.toml',
      observed_at: nowIso,
      event_at: null,
      next_run: null,
      last_run: null,
      last_result: null,
      error: null
    });
  }
  mechanics.push({
    id: 'mech-automations',
    name: '自動化工作流 (.codex/automations)',
    status: autoScan.status,
    task: autoScan.automations.length > 0 ? `加載 ${autoScan.automations.length} 個作用域內自動化` : '覆蓋範圍未知 (0 in-scope or unavailable)',
    source: 'automation.toml',
    observed_at: nowIso,
    event_at: null,
    next_run: null,
    last_run: null,
    last_result: null,
    error: null
  });

  const tasks = [];
  for (const a of attempts) {
    const role = attemptOwner(a);
    const ev = evaluateWorkerState({
      attempt: a,
      osProcesses: win.processes || [],
      policy,
      now,
      workerRole: role
    });
    tasks.push({
      id: `${a.base}-${ev.taskId}`,
      title: ev.taskDesc || ev.taskId,
      worker: role === 'W2' ? 'worker-w2' : (role === 'W1' ? 'worker-w1' : 'worker-unknown'),
      status: ev.status,
      head: null,
      pr: null,
      url: null,
      tests: 'unknown',
      updated_at: ev.eventAt,
      next: ev.next
    });
  }

  if (roundStatus?.source_candidates) {
    for (const sc of roundStatus.source_candidates) {
      let testPass = null;
      if (phaseDir) {
        const taskKey = sc.task.toLowerCase().replace(/^r3-/, '');
        const tFile = path.join(phaseDir, `${taskKey}-final-test-receipt.json`);
        const tFileAlt = path.join(phaseDir, `${taskKey}-test-receipt.json`);
        const chosen = fs.existsSync(tFile) ? tFile : (fs.existsSync(tFileAlt) ? tFileAlt : null);
        if (chosen) {
          try {
            const tr = JSON.parse(fs.readFileSync(chosen, 'utf8'));
            const count = tr.green_test_count ?? tr.green_pass_count;
            if (tr.green_exit === 0 && Number.isFinite(count) && count > 0) {
              testPass = `${count} passed`;
            }
          } catch {}
        }
      }

      let pubUrl = null;
      let pubHead = null;
      let pubTime = null;
      if (phaseDir) {
        const taskKey = sc.task.toLowerCase().replace(/^r3-/, '');
        const pFile = path.join(phaseDir, `${taskKey}-publication-readback.json`);
        if (fs.existsSync(pFile)) {
          try {
            const prDoc = JSON.parse(fs.readFileSync(pFile, 'utf8'));
            pubUrl = prDoc.url || null;
            pubHead = prDoc.head || prDoc.sha || null;
            pubTime = prDoc.at_utc || null;
          } catch {}
        }
      }

      let taskHead = pubHead || sc.head || 'UNKNOWN';
      if (pubHead && sc.head && pubHead !== sc.head) {
        taskHead = 'UNKNOWN';
        alerts.push(`源碼候選 PR #${sc.pr} (${sc.task}) head mismatch: ${sc.head} vs ${pubHead}`);
      }

      tasks.push({
        id: sc.task,
        title: `${sc.task} (源碼候選 PR #${sc.pr})`,
        worker: 'worker-w2',
        status: (__r3Blocked(sc.head, config.phase || '')?.blocked ? 'REWORK_REQUIRED' : 'COMPLETED'),
        head: taskHead,
        pr: sc.pr,
        url: pubUrl,
        tests: (__r3Blocked(sc.head, config.phase || '')?.blocked
          ? (__r3Blocked(sc.head, config.phase || '')?.tests || 'SKIPPED')
          : (__r3Blocked(sc.head, config.phase || '')?.tests || testPass || 'UNKNOWN')),
        updated_at: pubTime,
        next: (__r3Blocked(sc.head, config.phase || '')?.blocked
          ? 'REWORK_REQUIRED: 本地126與structural CI不代表候選已通過'
          : (sc.deployment || 'NOT_DEPLOYED'))
      });
    }
  }

  for (const r of gh.runs || []) {
    tasks.push({
      id: `ci-run-${r.id}`,
      title: `GitHub CI: ${r.name}`,
      worker: 'GitHub Actions',
      status: r.status === 'COMPLETED' ? (r.conclusion === 'SUCCESS' ? 'COMPLETED' : 'FAILED') : 'RUNNING',
      head: r.head_sha,
      pr: null,
      url: r.html_url,
      tests: r.conclusion || 'running',
      updated_at: r.updated_at,
      next: r.status === 'COMPLETED' ? 'CI 執行完畢' : '等待 CI 完成'
    });
  }

  const handoffs = [];
  if (handoffsDoc?.handoffs) {
    for (const h of handoffsDoc.handoffs) {
      handoffs.push({
        id: h.id,
        task_id: h.task || h.task_id,
        from: h.from,
        to: h.to,
        status: h.status,
        at: h.at || h.at_utc,
        evidence: Array.isArray(h.evidence) ? h.evidence.join(', ') : h.evidence,
        next: h.next
      });
    }
  }

  for (const a of attempts) {
    if (a.intent.from && a.intent.to) {
      const ev = evaluateWorkerState({
        attempt: a,
        osProcesses: win.processes || [],
        policy,
        now,
        workerRole: attemptOwner(a)
      });
      handoffs.push({
        id: `handoff-attempt-${a.base}`,
        task_id: a.intent.task || a.intent.task_id || a.base,
        from: a.intent.from,
        to: a.intent.to,
        status: ev.status === 'COMPLETED' ? 'SOURCE_RETURNED_WAITING_REVIEW' : ev.status,
        at: a.at_utc,
        evidence: `${a.base}.intent.json`,
        next: a.intent.supersedes ? `接手並取代 ${a.intent.supersedes}` : ev.next
      });
    }
  }

  if (win.vms && win.vms.length > 0 && win.vms[0].error === 'LOCAL_OS_PRIVILEGE_REQUIRED') {
    alerts.push('Hyper-V 查詢需要本地作業系統特權 (LOCAL_OS_PRIVILEGE_REQUIRED)');
  }
  if (w1Eval.status === 'PAUSED') {
    alerts.push(`Worker W1 已暫停: ${w1Eval.blocker}`);
  } else if (w1Eval.status === 'BLOCKED') {
    alerts.push(`Worker W1 遭遇動作阻擋: ${w1Eval.blocker}`);
  }
  if (w2Eval.status === 'BLOCKED') {
    alerts.push(`Worker W2 遭遇動作阻擋: ${w2Eval.blocker}`);
  }

  const nextSnapshot = {
    workers,
    tasks,
    handoffs
  };
  trackMaterialChanges(changes, nextSnapshot, ctx.prevSnapshot);
  ctx.prevSnapshot = nextSnapshot;

  const ttls = config.sourceTtls || {};
  const sources = {
    local: {
      source: 'Codex DB & 本機文件',
      observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : null,
      source_at: ctx.codexData?.threads?.[0]?.updated_at || null,
      ttl_seconds: ttls.local || 10,
      freshness: evaluateFreshness({
        observed_at: ctx.localLastRun ? new Date(ctx.localLastRun).toISOString() : null,
        ttl_seconds: ttls.local || 10,
        error: codex.error,
        cached: false,
        now
      }),
      last_attempt_at: ctx.localScheduledStart ? new Date(ctx.localScheduledStart).toISOString() : null,
      error: codex.error || null,
      cached: false
    },
    policy: {
      source: '調度策略 (dispatch-policy)',
      observed_at: policyReadAt,
      source_at: policyMtime,
      ttl_seconds: ttls.local || 10,
      freshness: evaluateFreshness({
        observed_at: policyReadAt,
        ttl_seconds: ttls.local || 10,
        error: policyError,
        cached: false,
        now
      }),
      last_attempt_at: policyPath ? nowIso : null,
      error: policyError,
      cached: false
    },
    roundStatus: {
      source: '輪次狀態 (round-status)',
      observed_at: roundStatusReadAt,
      source_at: roundStatusMtime,
      ttl_seconds: ttls.local || 10,
      freshness: evaluateFreshness({
        observed_at: roundStatusReadAt,
        ttl_seconds: ttls.local || 10,
        error: roundStatusError,
        cached: false,
        now
      }),
      last_attempt_at: roundPath ? nowIso : null,
      error: roundStatusError,
      cached: false
    },
    handoffs: {
      source: '職責交接 (handoffs)',
      observed_at: handoffsReadAt,
      source_at: handoffsMtime,
      ttl_seconds: ttls.local || 10,
      freshness: evaluateFreshness({
        observed_at: handoffsReadAt,
        ttl_seconds: ttls.local || 10,
        error: handoffsError,
        cached: false,
        now
      }),
      last_attempt_at: handoffsPath ? nowIso : null,
      error: handoffsError,
      cached: false
    },
    windows: {
      source: 'Windows OS (進程/服務/任務)',
      observed_at: winRaw.observed_at || winRaw.collected_at || (ctx.winLastRun ? new Date(ctx.winLastRun).toISOString() : null),
      source_at: winRaw.data?.collected_at || winRaw.collected_at || null,
      ttl_seconds: ttls.windows || 60,
      freshness: windowsOverviewFreshness,
      processes_freshness: osFreshness,
      section_freshness: windowsSectionFreshness,
      last_attempt_at: winRaw.last_attempt_at || (ctx.winScheduledStart ? new Date(ctx.winScheduledStart).toISOString() : null),
      error: winRaw.error || (winErrors.length > 0 ? winErrors.join('; ') : null),
      cached: Boolean(winRaw.cached)
    },
    vm: {
      source: 'VM SSH (Linux 監控)',
      observed_at: vmRaw.observed_at || vmRaw.collected_at || (ctx.vmLastRun ? new Date(ctx.vmLastRun).toISOString() : null),
      source_at: vmRaw.data?.header?.timestamp || vmRaw.collected_at || null,
      ttl_seconds: ttls.vm || 120,
      freshness: evaluateFreshness({
        observed_at: vmRaw.observed_at || vmRaw.collected_at || (ctx.vmLastRun ? new Date(ctx.vmLastRun).toISOString() : null),
        ttl_seconds: ttls.vm || 120,
        error: vmRaw.error,
        cached: Boolean(vmRaw.cached),
        now
      }),
      last_attempt_at: vmRaw.last_attempt_at || (ctx.vmScheduledStart ? new Date(ctx.vmScheduledStart).toISOString() : null),
      error: vmRaw.error || null,
      cached: Boolean(vmRaw.cached)
    },
    github: {
      source: 'GitHub Actions CI',
      observed_at: gh.observed_at || gh.collected_at || (ctx.ghLastRun ? new Date(ctx.ghLastRun).toISOString() : null),
      source_at: gh.runs?.[0]?.updated_at || gh.collected_at || null,
      ttl_seconds: ttls.github || 360,
      freshness: evaluateFreshness({
        observed_at: gh.observed_at || gh.collected_at || (ctx.ghLastRun ? new Date(ctx.ghLastRun).toISOString() : null),
        ttl_seconds: ttls.github || 360,
        error: gh.error,
        cached: Boolean(gh.cached),
        now
      }),
      last_attempt_at: gh.last_attempt_at || (ctx.ghScheduledStart ? new Date(ctx.ghScheduledStart).toISOString() : null),
      error: gh.error || null,
      cached: Boolean(gh.cached)
    }
  };

  const canonical = ctx.canonicalData || null;
  sources.canonical = {
    source: 'GitHub 正式控制指標',
    observed_at: canonical?.collected_at || null,
    source_at: canonical?.checkpoint?.event?.type || null,
    ttl_seconds: ttls.canonical || 600,
    freshness: evaluateFreshness({
      observed_at: canonical?.collected_at,
      ttl_seconds: ttls.canonical || 600,
      error: canonical?.error || null,
      cached: Boolean(canonical?.cached), now
    }),
    last_attempt_at: canonical?.last_attempt_at || null,
    error: canonical?.error || null,
    cached: Boolean(canonical?.cached)
  };

  const home = deriveHomeOverview({
    now,
    config,
    sources,
    workers,
    tasks,
    attempts,
    codex,
    policy,
    canonicalData: canonical
  });

  return {
    generated_at: nowIso,
    project: roundStatus?.project_id || 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    authority: '工廠監控（唯讀）',
    workers,
    mechanics,
    tasks,
    handoffs,
    alerts,
    changes,
    sources,
    home
  };
}

export function evaluateFreshness({ observed_at, ttl_seconds, error, cached, now = Date.now() }) {
  if (cached) return 'STALE';
  if (error) return 'ERROR';
  if (!observed_at) return 'UNKNOWN';
  const obsMs = new Date(observed_at).getTime();
  if (isNaN(obsMs)) return 'UNKNOWN';
  const ageMs = now - obsMs;
  if (ageMs < 0) return 'UNKNOWN';
  if (ageMs > (ttl_seconds || 0) * 1000) return 'STALE';
  return 'FRESH';
}

export function deriveHomeOverview({
  now = Date.now(),
  config = {},
  sources = {},
  workers = [],
  tasks = [],
  attempts = [],
  codex = { threads: [] },
  policy = null,
  canonicalData = null
}) {
  const currentControllerId = config.controllerThread || null;
  const currentControllerTitle = '工廠主控';
  const isWinFresh = (sources.windows?.processes_freshness || sources.windows?.freshness) === 'FRESH';
  const seenProcesses = new Set();
  const genuinelyActive = isWinFresh ? workers.filter(w => {
    if (w.status !== 'RUNNING' || !Number.isInteger(Number(w.pid)) || Number(w.pid) <= 0 ||
        w.model_evidence === 'HISTORICAL' || w.kind === 'human') return false;
    const key = String(w.pid);
    if (seenProcesses.has(key)) return false;
    seenProcesses.add(key);
    return true;
  }) : [];
  const activeWorkerCount = isWinFresh ? genuinelyActive.length : '未知';

  const trustedDeliveries = attempts.filter(a => {
    return a.hasArtifact && a.terminalInfo?.exit_code === 0 &&
      (String(a.terminalInfo?.result?.status || a.eventsSummary?.resultStatus || '').toUpperCase() === 'SUCCESS');
  }).map(a => {
    const intent = a.intent || {};
    return {
      id: intent.task || intent.task_id || a.base,
      title: intent.task_description || intent.description || 'W2 交付成果',
      worker: intent.worker || 'W2',
      artifactStatus: 'VALID_PARSED_JSON',
      exit_code: 0,
      nativeResult: 'SUCCESS',
      canonicalStatus: 'NOT_ACCEPTED',
      deliveredAt: a.eventsSummary?.lastEventAt || a.terminalInfo?.at_utc || a.at_utc || null
    };
  });

  const humanTodos = [];

  const isW1Paused = config.humanW1Paused === true || policy?.humanW1Paused === true ||
    policy?.w1?.operational_state === 'PAUSED_BY_USER_REPEATED_ERROR_RULE' || policy?.w1?.automatic_dispatch === false;

  const isGhFresh = sources.github?.freshness === 'FRESH';
  const candSha = (typeof config.candidateSha === 'string' && /^[0-9a-fA-F]{40}$/.test(config.candidateSha.trim()))
    ? config.candidateSha.trim().toLowerCase()
    : null;

  let ciStatus = 'NOT_RUN';
  let ciNote = '無配置有效 40 位候選版本 SHA，CI 尚未執行';

  if (!candSha) {
    ciStatus = 'NOT_RUN';
    ciNote = '尚未配置候選版本 SHA (No candidateSha)';
  } else if (!isGhFresh) {
    ciStatus = 'NOT_QUALIFIED';
    ciNote = 'GitHub CI 來源非最新 (GitHub reader not fresh)';
  } else {
    const matchingRun = tasks.find(t =>
      t.worker === 'GitHub Actions' &&
      t.status === 'COMPLETED' &&
      (String(t.tests).toUpperCase() === 'SUCCESS' || String(t.tests).toUpperCase() === 'PASSED') &&
      typeof t.head === 'string' &&
      t.head.toLowerCase() === candSha
    );
    if (matchingRun) {
      // A successful GitHub run is not necessarily an approved trusted verifier.
      // This monitor has not bound a required workflow identity and test contract.
      ciStatus = 'GITHUB_RUN_SUCCESS_UNVERIFIED';
      ciNote = `版本 ${candSha.slice(0, 7)} 有成功的 GitHub 執行紀錄；未核對可信驗收器與測試契約`;
    } else {
      ciStatus = 'NOT_QUALIFIED';
      ciNote = `未發現候選版本 ${candSha.slice(0, 7)} 之成功 CI 記錄`;
    }
  }

  const factoryOverview = {
    controller: {
      threadId: currentControllerId,
      title: currentControllerTitle,
      activity: '活動訊號待OS核實'
    },
    activeWorkersCount: activeWorkerCount,
    canonical: {
      reference: (sources.canonical?.freshness === 'FRESH' && canonicalData?.verified)
        ? `同來源正式控制 checkpoint ${canonicalData.pointer.checkpoint_seq}（${canonicalData.ref}）；R4 尚未獲完整驗收`
        : '歷史快照不可代表即時正式控制（讀回未知）',
      status: 'NOT_ACCEPTED',
      candidate: 'R4 本地候選，未完成正式驗收',
      accepted: false,
      control_readback: (sources.canonical?.freshness === 'FRESH' && canonicalData?.verified)
        ? 'PROVIDER_CONFIRMED' : 'UNKNOWN'
    },
    ciQualification: {
      status: ciStatus,
      note: ciNote
    },
    humanGate: {
      w1Paused: isW1Paused,
      productionGate: 'REVERSIBLE_LOCAL_WORKSPACE_AUTHORIZED'
    }
  };

  return {
    factoryOverview,
    genuinelyActive,
    trustedDeliveries,
    humanTodos,
    sourceFreshness: Object.values(sources)
  };
}

export function createHttpServer(ctx) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request: Invalid Host');
      return;
    }

    const securityHeaders = {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    };

    if (req.url === '/health') {
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), pid: process.pid }));
      return;
    }

    if (req.url === '/api/state') {
      const state = buildDashboardState(ctx);
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      const indexPath = path.resolve(MODULE_DIR, 'index.html');
      if (!isPathInWorkspace(indexPath, MODULE_DIR)) {
        res.writeHead(403, securityHeaders);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(indexPath)) {
        res.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: index.html not yet authored by W2 front writer');
        return;
      }
      const html = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  });

  return server;
}

export function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export async function main() {
  const config = loadConfig();
  const stateMap = new Map();
  const attemptsCache = new Map();
  const ctx = {
    config,
    changes: [],
    codexData: { threads: [] },
    windowsData: { status: 'PENDING', data: null, error: null },
    vmData: { status: 'PENDING', data: null, error: null },
    githubData: { status: 'PENDING', runs: [], error: null },
    canonicalData: null,
    phaseAttempts: [],
    localLastRun: null,
    localScheduledStart: null,
    localScheduledNext: null,
    winLastRun: null,
    winScheduledStart: null,
    winScheduledNext: null,
    vmLastRun: null,
    vmScheduledStart: null,
    vmScheduledNext: null,
    ghLastRun: null,
    ghScheduledStart: null,
    ghScheduledNext: null,
    prevSnapshot: null
  };

  const server = createHttpServer(ctx);
  const listenPort = configuredListenPort(config);
  server.listen(listenPort, '127.0.0.1', () => {
    const port = server.address().port;
    const startData = {
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
      started_at: new Date().toISOString()
    };
    const startPath = path.resolve(MODULE_DIR, 'server.start.json');
    try { fs.writeFileSync(startPath, JSON.stringify(startData, null, 2), 'utf8'); } catch {}
  });

  function pollLocal() {
    ctx.localScheduledStart = Date.now();
    ctx.localScheduledNext = ctx.localScheduledStart + 3000;
    ctx.localLastRun = ctx.localScheduledStart;
    ctx.codexData = readCodexDb(config.codexDb, config.workspace, config.threadTitles, stateMap, ctx.localLastRun);
    ctx.phaseAttempts = scanPairedAttempts(config.phase, attemptsCache);
  }
  pollLocal();
  setInterval(pollLocal, 3000);

  let winBusy = false;
  async function pollWin() {
    if (winBusy) return;
    winBusy = true;
    ctx.winScheduledStart = Date.now();
    ctx.winScheduledNext = ctx.winScheduledStart + 30000;
    try {
      const res = await executeWindowsCollector(config);
      ctx.winLastRun = Date.now();
      ctx.windowsData = mergeCollectorReadback(ctx.windowsData, res);
    } catch (err) {
      ctx.windowsData = mergeCollectorReadback(ctx.windowsData, { status: 'FAILED', error: err.message });
    } finally {
      winBusy = false;
    }
  }
  pollWin();
  setInterval(pollWin, 30000);

  let vmBusy = false;
  async function pollVm() {
    if (vmBusy) return;
    vmBusy = true;
    ctx.vmScheduledStart = Date.now();
    ctx.vmScheduledNext = ctx.vmScheduledStart + 60000;
    try {
      const res = await executeVmSsh(config);
      ctx.vmLastRun = Date.now();
      ctx.vmData = mergeCollectorReadback(ctx.vmData, res);
    } catch (err) {
      ctx.vmData = mergeCollectorReadback(ctx.vmData, { status: 'FAILED', error: err.message });
    } finally {
      vmBusy = false;
    }
  }
  pollVm();
  setInterval(pollVm, 60000);

  let ghBusy = false;
  async function pollGh() {
    if (ghBusy) return;
    ghBusy = true;
    ctx.ghScheduledStart = Date.now();
    ctx.ghScheduledNext = ctx.ghScheduledStart + 180000;
    try {
      const res = await fetchGitHubActions(config.repo);
      ctx.ghLastRun = Date.now();
      ctx.githubData = mergeCollectorReadback(ctx.githubData, res);
    } catch (err) {
      ctx.githubData = mergeCollectorReadback(ctx.githubData, { status: 'FAILED', error: err.message });
    } finally {
      ghBusy = false;
    }
  }
  pollGh();
  setInterval(pollGh, 180000);

  let canonicalBusy = false;
  async function pollCanonical() {
    if (canonicalBusy) return;
    canonicalBusy = true;
    try { ctx.canonicalData = await fetchGitHubCanonical(config.repo); }
    catch (e) { ctx.canonicalData = { verified: false, error: String(e.message) }; }
    finally { canonicalBusy = false; }
  }
  pollCanonical();
  setInterval(pollCanonical, 600000);
}

if (isDirectExecution()) {
  main().catch(() => process.exit(1));
}
