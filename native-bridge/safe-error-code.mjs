const SAFE_SYSTEM_CODES = new Set([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EBUSY', 'ECONNREFUSED', 'ECONNRESET',
  'EEXIST', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENAMETOOLONG', 'ENETUNREACH',
  'ENFILE', 'ENOENT', 'ENOMEM', 'ENOTDIR', 'ENOTEMPTY', 'ENOTSUP', 'EPIPE', 'EPERM',
  'ETIMEDOUT', 'EXDEV',
]);
const SAFE_APPLICATION_PREFIXES = [
  'CANDIDATE_', 'CODEX_', 'EXECUTOR_', 'LOCAL_', 'OPENCODE_', 'RECOVERY_',
  'RESULT_', 'SCOPED_EDIT_', 'TASK_', 'TRIGGER_', 'V2_', 'WORKSPACE_',
];
const SENSITIVE_CODE_MARKERS = /TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER|API_KEY|GHP_|GHO_|GHS_|GHR_/;

function safeCode(value) {
  if (SAFE_SYSTEM_CODES.has(value)) return value;
  if (typeof value !== 'string') return null;
  if (/^ERR_[A-Z0-9_]{1,64}$/.test(value)) return 'NODE_RUNTIME_ERROR';
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(value) || SENSITIVE_CODE_MARKERS.test(value) ||
      value.split('_').some(part => part.length > 32) ||
      !SAFE_APPLICATION_PREFIXES.some(prefix => value.startsWith(prefix))) return null;
  return value;
}

export function safeErrorCode(error, fallback = 'UNKNOWN') {
  const code = safeCode(error?.code) || safeCode(error?.message);
  if (code) return code;
  return fallback;
}
