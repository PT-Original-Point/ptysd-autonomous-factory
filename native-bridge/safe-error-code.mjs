const SAFE_SYSTEM_CODES = new Set([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EBUSY', 'ECONNREFUSED', 'ECONNRESET',
  'EEXIST', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENAMETOOLONG', 'ENETUNREACH',
  'ENFILE', 'ENOENT', 'ENOMEM', 'ENOTDIR', 'ENOTEMPTY', 'ENOTSUP', 'EPIPE', 'EPERM',
  'ETIMEDOUT', 'EXDEV',
]);
const SAFE_APPLICATION_PREFIXES = [
  'CANDIDATE_', 'CODEX_', 'EDIT_', 'EXECUTOR_', 'LOCAL_', 'OPENCODE_', 'OPERATOR_', 'PREFLIGHT_', 'RECOVERY_',
  'RESULT_', 'SCOPED_EDIT_', 'TASK_', 'TRIGGER_', 'V2_', 'WORKSPACE_',
];
const SAFE_APPLICATION_CODES = new Set([
  'PROCESS_TREE_IDENTITY_MISMATCH', 'PROCESS_TREE_IDENTITY_UNPROVEN',
]);
const SAFE_EDIT_GIT_CAPTURE_LABELS = new Set([
  'HEAD', 'BEFORE', 'AFTER', 'AFTER-HEAD', 'AFTER-IGNORED', 'DIFF',
  'CHANGED-FILE-TREE',
  'PROJECT-ROOT-BEFORE-HEAD-BEFORE', 'PROJECT-ROOT-BEFORE-STATUS',
  'PROJECT-ROOT-BEFORE-HEAD-AFTER',
  'PROJECT-ROOT-AFTER-HEAD-BEFORE', 'PROJECT-ROOT-AFTER-STATUS',
  'PROJECT-ROOT-AFTER-HEAD-AFTER',
]);
const SAFE_EDIT_GIT_CAPTURE_FAILURES = new Set([
  'SPAWN_FAILED', 'CAPTURE_FAILED', 'STORAGE_FAILED', 'PROCESS_FAILED',
  'STDIN_FAILED', 'EXIT_NONZERO', 'TERMINATION_CONFIRMED',
  'TERMINATION_REQUESTED', 'TERMINATION_UNCONFIRMED', 'ORPHAN_POSSIBLE',
  'TERMINATION_STATE_UNKNOWN',
]);
const SAFE_FALLBACK_CODES = new Set([
  'INVALID', 'IO_ERROR', 'PREFLIGHT_FAILED', 'PROCESS_TREE_READBACK_FAILED',
  'PROCESS_TREE_READBACK_UNKNOWN', 'UNKNOWN',
]);
const SENSITIVE_CODE_MARKERS = /TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER|API_KEY|GHP_|GHO_|GHS_|GHR_/;

function safeCode(value) {
  if (SAFE_SYSTEM_CODES.has(value)) return value;
  if (typeof value !== 'string') return null;
  const editGitFailure = /^EDIT_GIT_([A-Z][A-Z0-9-]{0,79})_([A-Z][A-Z0-9_]{0,63})$/.exec(value);
  const safeEditGitCaptureLabel = editGitFailure &&
    (SAFE_EDIT_GIT_CAPTURE_LABELS.has(editGitFailure[1]) ||
      /^CHANGED-FILE-BLOB-(?:0|[1-9][0-9]{0,2})$/.test(editGitFailure[1]));
  if (editGitFailure && safeEditGitCaptureLabel &&
      SAFE_EDIT_GIT_CAPTURE_FAILURES.has(editGitFailure[2])) {
    return `EDIT_GIT_${editGitFailure[1].replaceAll('-', '_')}_${editGitFailure[2]}`;
  }
  if (/^ERR_[A-Z0-9_]{1,64}$/.test(value)) return 'NODE_RUNTIME_ERROR';
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(value) || SENSITIVE_CODE_MARKERS.test(value) ||
      value.split('_').some(part => part.length > 32) ||
      !(SAFE_APPLICATION_CODES.has(value) ||
        SAFE_APPLICATION_PREFIXES.some(prefix => value.startsWith(prefix)))) return null;
  return value;
}

export function safeErrorCode(error, fallback = 'UNKNOWN') {
  const code = safeCode(error?.code) || safeCode(error?.message);
  if (code) return code;
  return safeCode(fallback) || (SAFE_FALLBACK_CODES.has(fallback) ? fallback : 'UNKNOWN');
}
