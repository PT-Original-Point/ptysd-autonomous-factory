// PTYSD V5.3-R4: pure, read-only projection of EXISTING GitHub Issue #407 native receipts.
// No GitHub write, new daemon, model call, or inferred OS liveness.
const PROJECT = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
const HOST = 'DESKTOP-1B6PD2P';
const REPO = 'PT-Original-Point/ptysd-autonomous-factory';
const JOB = 'PTYSD_NATIVE_JOB_V1\n';
const RECEIPT = 'PTYSD_NATIVE_RECEIPT_V1\n';
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9-]{36}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const STATES = new Set(['STARTED', 'FINISHED', 'BLOCKED']);
const JOB_KINDS = new Set(['ping', 'native_preflight', 'native_v2_qualify', 'opencode_plan']);
const MAX_COMMENTS = 300;

function asTime(value) {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
function decode(body, marker) {
  if (typeof body !== 'string' || body.length > 5000 || !body.startsWith(marker)) return null;
  try {
    const obj = JSON.parse(body.slice(marker.length));
    return obj && !Array.isArray(obj) && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}
export function parseNativeJob(body) {
  const o = decode(body, JOB);
  return o && (o.schema === 1 || o.schema === 2) &&
    o.project_id === PROJECT && o.host === HOST && REQUEST.test(o.request_id || '') &&
    SHA.test(o.source_sha || '') && JOB_KINDS.has(o.kind) ? o : null;
}
export function parseNativeReceipt(body) {
  const o = decode(body, RECEIPT);
  return o && o.schema === 1 && o.project_id === PROJECT && o.host === HOST &&
    REQUEST.test(o.request_id || '') && SHA.test(o.source_sha || '') &&
    UUID.test(o.attempt_id || '') && JOB_KINDS.has(o.kind) && STATES.has(o.state) ? o : null;
}
export async function fetchNativeIssueReceipts(repo = REPO, fetchImpl = fetch) {
  if (repo !== REPO) return { status: 'UNKNOWN', error: 'NATIVE_REPO_IDENTITY_MISMATCH', checked_at: null, comments: [] };
  const aborter = new AbortController();
  const timeout = setTimeout(() => aborter.abort(), 7500);
  try {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const r = await fetchImpl('https://api.github.com/repos/' + REPO +
        '/issues/407/comments?per_page=100&page=' + page, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PTYSD-Monitor-ReadOnly' },
        signal: aborter.signal,
      });
      if (!r?.ok) return { status: 'UNKNOWN', error: 'NATIVE_GITHUB_HTTP_' + (Number(r?.status) || 0),
        checked_at: null, comments: [] };
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length > 100) throw new Error('INVALID_NATIVE_COMMENT_PAGE');
      for (const c of arr) {
        if (Number.isSafeInteger(c?.id) && typeof c?.body === 'string' && c.body.length <= 5000) {
          out.push({ id: c.id, body: c.body, created_at: c.created_at || null,
            login: typeof c.user?.login === 'string' ? c.user.login : null });
        }
      }
      if (out.length > MAX_COMMENTS) throw new Error('NATIVE_COMMENT_LIMIT');
      if (arr.length < 100) break;
      if (page === 3) throw new Error('NATIVE_COMMENT_INCOMPLETE');
    }
    return { status: 'OK', checked_at: new Date().toISOString(), comments: out, error: null };
  } catch {
    return { status: 'UNKNOWN', checked_at: null, comments: [], error: 'NATIVE_RECEIPT_READ_FAILED_OR_INCOMPLETE' };
  } finally { clearTimeout(timeout); }
}
export function deriveNativeV2Status({ provider, windows, sectionFreshness, now = Date.now() } = {}) {
  const safe = { source: 'UNKNOWN', checked_at: null, last_request: null,
    last_kind: null, last_receipt: '無法確認 GitHub 收據',
    last_receipt_at: null, last_outcome: null, scheduler: '排程讀回未知',
    process: '程序讀回未知', coding: '尚未確認有任何實際寫碼與 Git 提交',
    note: '網頁有回應不代表 OpenCode 正在工作' };
  const win = windows?.data || windows || {};
  if (sectionFreshness?.processes === 'FRESH') {
    const list = Array.isArray(win.processes) ? win.processes : [];
    const count = list.filter(p => /^opencode(?:2|-cli)?(?:\.exe)?$/i.test(String(p.name || ''))).length;
    safe.process = count
      ? '看見 ' + count + ' 個 OpenCode 程序；尚未綁定到寫碼任務'
      : '未發現 OpenCode 程序（最近 OS 查詢）';
  } else {
    safe.process = 'Windows 程序資料未取得或已過期';
  }
  if (sectionFreshness?.scheduled_tasks === 'FRESH') {
    const tasks = Array.isArray(win.scheduled_tasks) ? win.scheduled_tasks : [];
    const task = tasks.find(t => /^PTYSD-Native-OpenCode$/i.test(String(t.name || '')));
    if (!task) safe.scheduler = '未找到 PTYSD-Native-OpenCode 排程';
    else {
      const st = String(task.state || 'UNKNOWN').toUpperCase();
      const date = asTime(task.last_run);
      const last = date ? new Date(date).toISOString() : '未知';
      safe.scheduler = st === 'DISABLED' ? '排程已停用；最近執行 ' + last :
        (st === 'RUNNING' ? '排程器正在執行（不等於寫碼）；最近 ' :
          '排程存在／' + st + '（不等於寫碼）；最近 ') + last;
    }
  } else {
    safe.scheduler = 'Windows 排程資料未取得或已過期';
  }
  const checked = asTime(provider?.checked_at);
  if (provider?.status !== 'OK' || checked === null || checked > now + 5000 || now - checked > 9 * 60 * 1000) {
    safe.source = checked !== null && now - checked > 9 * 60 * 1000 ? 'STALE' : 'UNKNOWN';
    safe.note = 'GitHub 工作收據未能取得新鮮資料；不推測主機正在執行';
    return safe;
  }
  safe.source = 'FRESH';
  safe.checked_at = provider.checked_at;
  const comments = Array.isArray(provider.comments) ? provider.comments.slice().sort((a,b) => a.id - b.id) : [];
  const jobs = comments.map(c => ({ ...c, job: parseNativeJob(c.body) })).filter(c => c.job);
  const receipts = comments.map(c => ({ ...c, receipt: parseNativeReceipt(c.body) })).filter(c => c.receipt);
  if (!jobs.length) {
    safe.last_receipt = 'Issue #407 尚無有效的接單任務';
    safe.note = '只查到 GitHub 服務，不代表主機正在寫碼';
    return safe;
  }
  const latest = jobs.at(-1);
  safe.last_request = latest.job.request_id;
  safe.last_kind = latest.job.kind;
  const matching = receipts.filter(c => c.receipt.request_id === latest.job.request_id &&
    c.receipt.source_sha === latest.job.source_sha && c.receipt.kind === latest.job.kind &&
    c.id > latest.id);
  const starts = matching.filter(c => c.receipt.state === 'STARTED');
  const terminals = matching.filter(c =>
    c.receipt.state !== 'STARTED' &&
    starts.some(s => s.receipt.attempt_id === c.receipt.attempt_id && s.id < c.id));
  const last = terminals.at(-1) || starts.at(-1);
  safe.last_receipt_at = last?.created_at || null;
  if (!last) safe.last_receipt = 'GitHub 已發單；還沒有匹配的 Win11 開始收據';
  else if (last.receipt.state === 'STARTED') {
    safe.last_receipt = '已有 STARTED；執行中狀態無法由 GitHub 單獨證明';
    const started = asTime(last.created_at);
    if (started !== null && now - started > 20 * 60 * 1000)
      safe.last_receipt = 'STARTED 超過 20 分鐘無終態；需查實機，不能盲重跑';
  } else {
    safe.last_receipt = last.receipt.state === 'FINISHED'
      ? '已收到 FINISHED（不等於寫碼驗收）' : '已收到 BLOCKED（任務受阻）';
    safe.last_outcome = typeof last.receipt.outcome === 'string' &&
      /^[A-Z0-9_-]{1,80}$/.test(last.receipt.outcome) ? last.receipt.outcome : 'UNKNOWN';
  }
  safe.note = '僅是公開 GitHub 收據；未證明發文者所在主機、即時 PID 或編碼差異';
  return safe;
}
