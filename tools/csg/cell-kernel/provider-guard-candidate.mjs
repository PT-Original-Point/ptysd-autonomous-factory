import { createHash } from 'node:crypto';

export const PROVIDER_GUARD_POLICY_SCHEMA = 'vnext5.r3.provider-guard-policy.v1';
export const PROVIDER_GUARD_EVIDENCE_SCHEMA = 'vnext5.r3.provider-guard-evidence.v1';
export const PROVIDER_GUARD_RESULT_SCHEMA = 'vnext5.r3.provider-guard-result.v1';

const GIT_OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code) => { throw new Error(code); };
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const hashObject = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name}_OBJECT_REQUIRED`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!same(actual, expected)) fail(`${name}_FIELDS_INVALID`);
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name}_INVALID`);
  return value;
}

function oid(value, name) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail(`${name}_INVALID`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${name}_INVALID`);
  return value;
}

function safeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name}_INVALID`);
  return value;
}

const POLICY_KEYS = [
  'schema', 'provider', 'repository_id', 'resource_id', 'source_ref', 'target_ref',
  'base_commit', 'base_tree', 'candidate_commit', 'candidate_parent', 'candidate_tree',
  'integration_tree', 'workflow_path', 'workflow_digest', 'job_name', 'app_id',
  'protection_digest', 'protection_profile', 'sender_id', 'operation_id', 'idempotency_key',
];
const PROTECTION_KEYS = [
  'enforce_admins', 'allow_force_pushes', 'allow_deletions', 'required_approving_review_count',
];
const CHECK_KEYS = ['workflow_path', 'workflow_digest', 'job_name', 'app_id'];
const EVIDENCE_KEYS = [
  'schema', 'candidate_binding', 'required_check_readback', 'branch_protection_readback',
  'sender_fence_readback', 'pre_target_readback', 'publish_attempt', 'post_target_readback',
];

function validatePolicy(policy) {
  exactKeys(policy, POLICY_KEYS, 'PROVIDER_GUARD_POLICY');
  if (policy.schema !== PROVIDER_GUARD_POLICY_SCHEMA || policy.provider !== 'github') fail('POLICY_SCHEMA_OR_PROVIDER_INVALID');
  for (const key of ['repository_id', 'resource_id', 'source_ref', 'target_ref', 'workflow_path', 'job_name', 'app_id', 'sender_id', 'operation_id', 'idempotency_key']) text(policy[key], `POLICY_${key.toUpperCase()}`);
  for (const key of ['base_commit', 'candidate_commit', 'candidate_parent']) oid(policy[key], `POLICY_${key.toUpperCase()}`);
  for (const key of ['base_tree', 'candidate_tree', 'integration_tree']) oid(policy[key], `POLICY_${key.toUpperCase()}`);
  digest(policy.workflow_digest, 'POLICY_WORKFLOW_DIGEST');
  digest(policy.protection_digest, 'POLICY_PROTECTION_DIGEST');
  exactKeys(policy.protection_profile, PROTECTION_KEYS, 'POLICY_PROTECTION_PROFILE');
  if (typeof policy.protection_profile.enforce_admins !== 'boolean'
    || typeof policy.protection_profile.allow_force_pushes !== 'boolean'
    || typeof policy.protection_profile.allow_deletions !== 'boolean') fail('POLICY_PROTECTION_PROFILE_INVALID');
  safeCount(policy.protection_profile.required_approving_review_count, 'POLICY_APPROVAL_COUNT');
  if (policy.candidate_parent !== policy.base_commit) fail('CANDIDATE_NOT_DIRECT_CHILD_OF_BASE');
  if (policy.candidate_tree !== policy.integration_tree) fail('INTEGRATION_TREE_MISMATCH');
  return policy;
}

function validateCandidateBinding(binding, policy) {
  exactKeys(binding, POLICY_KEYS.filter((key) => key !== 'schema' && key !== 'protection_digest' && key !== 'protection_profile'), 'CANDIDATE_BINDING');
  for (const key of Object.keys(binding)) if (binding[key] !== policy[key]) fail(`CANDIDATE_BINDING_MISMATCH_${key.toUpperCase()}`);
}

function validateCheckReadback(readback, policy) {
  exactKeys(readback, [
    'origin', 'repository_id', 'target_ref', 'run_id', 'run_attempt', 'head_sha', 'head_tree',
    'base_sha', 'workflow_path', 'workflow_digest', 'job_name', 'app_id', 'status', 'conclusion',
  ], 'REQUIRED_CHECK_READBACK');
  if (readback.origin !== 'GITHUB_CHECKS_READBACK') fail('CHECK_READBACK_ORIGIN_INVALID');
  for (const [key, expected] of Object.entries({
    repository_id: policy.repository_id,
    target_ref: policy.target_ref,
    head_sha: policy.candidate_commit,
    head_tree: policy.candidate_tree,
    base_sha: policy.base_commit,
    workflow_path: policy.workflow_path,
    workflow_digest: policy.workflow_digest,
    job_name: policy.job_name,
    app_id: policy.app_id,
  })) if (readback[key] !== expected) fail(`CHECK_READBACK_MISMATCH_${key.toUpperCase()}`);
  text(readback.run_id, 'CHECK_RUN_ID');
  if (!Number.isSafeInteger(readback.run_attempt) || readback.run_attempt < 1) fail('CHECK_RUN_ATTEMPT_INVALID');
  if (readback.status !== 'completed' || readback.conclusion !== 'success') fail('EXACT_REQUIRED_CHECK_NOT_SUCCESSFUL');
}

function validateProtectionReadback(readback, policy) {
  exactKeys(readback, [
    'origin', 'repository_id', 'target_ref', 'revision', 'config_digest', 'settings', 'required_checks',
  ], 'BRANCH_PROTECTION_READBACK');
  if (readback.origin !== 'GITHUB_BRANCH_PROTECTION_READBACK') fail('PROTECTION_READBACK_ORIGIN_INVALID');
  if (readback.repository_id !== policy.repository_id || readback.target_ref !== policy.target_ref) fail('PROTECTION_READBACK_TARGET_MISMATCH');
  oid(readback.revision, 'PROTECTION_READBACK_REVISION');
  digest(readback.config_digest, 'PROTECTION_CONFIG_DIGEST');
  if (readback.config_digest !== policy.protection_digest) fail('PROTECTION_CONFIG_DIGEST_MISMATCH');
  exactKeys(readback.settings, PROTECTION_KEYS, 'PROTECTION_SETTINGS');
  if (!same(readback.settings, policy.protection_profile)) fail('PROTECTION_SETTINGS_MISMATCH');
  if (!Array.isArray(readback.required_checks)) fail('PROTECTED_REQUIRED_CHECKS_INVALID');
  const matches = readback.required_checks.filter((check) => {
    exactKeys(check, CHECK_KEYS, 'PROTECTED_CHECK_IDENTITY');
    return same(check, {
      workflow_path: policy.workflow_path,
      workflow_digest: policy.workflow_digest,
      job_name: policy.job_name,
      app_id: policy.app_id,
    });
  });
  if (matches.length !== 1) fail('EXACT_REQUIRED_CHECK_NOT_PROTECTED_UNIQUELY');
}

const READBACK_KEYS = [
  'origin', 'repository_id', 'resource_id', 'ref', 'exists', 'commit', 'tree', 'revision', 'observed_at_utc', 'payload_sha256',
];

function validateTargetReadback(readback, policy, name) {
  if (readback === null) return null;
  exactKeys(readback, READBACK_KEYS, name);
  if (readback.origin !== 'GITHUB_REF_READBACK') fail(`${name}_ORIGIN_INVALID`);
  if (readback.repository_id !== policy.repository_id || readback.resource_id !== policy.resource_id || readback.ref !== policy.target_ref) fail(`${name}_TARGET_MISMATCH`);
  if (readback.exists !== true) fail(`${name}_REF_MISSING`);
  oid(readback.commit, `${name}_COMMIT`);
  oid(readback.tree, `${name}_TREE`);
  oid(readback.revision, `${name}_REVISION`);
  text(readback.observed_at_utc, `${name}_OBSERVED_AT`);
  digest(readback.payload_sha256, `${name}_PAYLOAD_DIGEST`);
  return readback;
}

function validateSenderFence(readback, policy) {
  exactKeys(readback, [
    'origin', 'repository_id', 'resource_id', 'target_ref', 'fence_id', 'generation',
    'owner_id', 'active_sender_ids', 'attempt_count', 'observed_at_utc', 'payload_sha256',
  ], 'SENDER_FENCE_READBACK');
  if (readback.origin !== 'GITHUB_SINGLE_SENDER_FENCE_READBACK') fail('SENDER_FENCE_ORIGIN_INVALID');
  if (readback.repository_id !== policy.repository_id || readback.resource_id !== policy.resource_id || readback.target_ref !== policy.target_ref) fail('SENDER_FENCE_TARGET_MISMATCH');
  text(readback.fence_id, 'SENDER_FENCE_ID');
  safeCount(readback.generation, 'SENDER_FENCE_GENERATION');
  if (readback.generation < 1 || readback.owner_id !== policy.sender_id) fail('SENDER_FENCE_OWNER_MISMATCH');
  if (!Array.isArray(readback.active_sender_ids) || readback.active_sender_ids.length !== 1 || readback.active_sender_ids[0] !== policy.sender_id) fail('MULTIPLE_OR_UNKNOWN_ACTIVE_SENDERS');
  if (readback.attempt_count !== 1) fail('SENDER_FENCE_ATTEMPT_COUNT_INVALID');
  text(readback.observed_at_utc, 'SENDER_FENCE_OBSERVED_AT');
  digest(readback.payload_sha256, 'SENDER_FENCE_PAYLOAD_DIGEST');
}

function validatePublishAttempt(attempt, policy) {
  exactKeys(attempt, [
    'operation_id', 'idempotency_key', 'sender_id', 'attempt_number', 'outcome', 'provider_request_id',
  ], 'PUBLISH_ATTEMPT');
  if (attempt.operation_id !== policy.operation_id || attempt.idempotency_key !== policy.idempotency_key || attempt.sender_id !== policy.sender_id) fail('PUBLISH_ATTEMPT_IDENTITY_MISMATCH');
  if (attempt.attempt_number !== 1) fail('PUBLISH_ATTEMPT_NOT_SINGLE');
  if (!['ACKNOWLEDGED', 'ACK_LOST', 'NOT_DISPATCHED'].includes(attempt.outcome)) fail('PUBLISH_ATTEMPT_OUTCOME_INVALID');
  if (attempt.outcome === 'NOT_DISPATCHED') {
    if (attempt.provider_request_id !== null) fail('NOT_DISPATCHED_HAS_PROVIDER_REQUEST');
  } else text(attempt.provider_request_id, 'PROVIDER_REQUEST_ID');
}

function classifyPostState(post, policy) {
  if (post.commit === policy.candidate_commit && post.tree === policy.candidate_tree) return 'OBSERVED_POSTSTATE_CANDIDATE_EXACT';
  if (post.commit === policy.base_commit && post.tree === policy.base_tree) return 'OBSERVED_PRESTATE_UNCHANGED';
  return 'OBSERVED_POSTSTATE_CONFLICT';
}

/**
 * Shape-checks a fully collected ProviderGuard evidence package. This pure
 * candidate evaluator performs no I/O, authenticates no provider response,
 * and cannot publish. The caller must obtain and independently protect every
 * readback before any later trusted workflow can consume it.
 */
export function evaluateProviderGuardEvidence({ policy, evidence } = {}) {
  validatePolicy(policy);
  exactKeys(evidence, EVIDENCE_KEYS, 'PROVIDER_GUARD_EVIDENCE');
  if (evidence.schema !== PROVIDER_GUARD_EVIDENCE_SCHEMA) fail('UNSUPPORTED_PROVIDER_GUARD_EVIDENCE_SCHEMA');
  validateCandidateBinding(evidence.candidate_binding, policy);
  validateCheckReadback(evidence.required_check_readback, policy);
  validateProtectionReadback(evidence.branch_protection_readback, policy);
  validateSenderFence(evidence.sender_fence_readback, policy);
  const before = validateTargetReadback(evidence.pre_target_readback, policy, 'PRE_TARGET_READBACK');
  if (before.commit !== policy.base_commit || before.tree !== policy.base_tree) fail('PRE_TARGET_NOT_EXACT_BASE');
  validatePublishAttempt(evidence.publish_attempt, policy);

  const attempt = evidence.publish_attempt;
  const post = validateTargetReadback(evidence.post_target_readback, policy, 'POST_TARGET_READBACK');
  let decision;
  if (attempt.outcome === 'NOT_DISPATCHED') {
    if (post !== null) fail('NOT_DISPATCHED_HAS_POST_TARGET_READBACK');
    decision = 'NOT_DISPATCHED';
  } else if (post === null) {
    decision = 'UNKNOWN_NO_RETRY';
  } else {
    const observed = classifyPostState(post, policy);
    if (attempt.outcome === 'ACK_LOST') {
      decision = observed === 'OBSERVED_POSTSTATE_CANDIDATE_EXACT'
        ? 'ACK_LOSS_RECONCILED_CANDIDATE_PRESENT'
        : observed === 'OBSERVED_PRESTATE_UNCHANGED'
          ? 'ACK_LOSS_UNRESOLVED_NO_RETRY'
          : 'ACK_LOSS_CONFLICT_NO_RETRY';
    } else {
      decision = observed === 'OBSERVED_POSTSTATE_CANDIDATE_EXACT'
        ? 'ACKNOWLEDGED_AND_POSTSTATE_EXACT'
        : observed === 'OBSERVED_PRESTATE_UNCHANGED'
          ? 'ACKNOWLEDGED_BUT_POSTSTATE_UNCHANGED_NO_RETRY'
          : 'ACKNOWLEDGED_BUT_POSTSTATE_CONFLICT_NO_RETRY';
    }
  }

  const result = {
    schema: PROVIDER_GUARD_RESULT_SCHEMA,
    decision,
    evidence_quality: 'SHAPE_CHECK_ONLY_PROVIDER_AUTHENTICATION_NOT_PERFORMED',
    dispatch_allowed: false,
    provider_api_called: false,
    retry_allowed: false,
    canonical_acceptance: false,
    host_or_production_qualification: false,
    candidate_commit: policy.candidate_commit,
    candidate_tree: policy.candidate_tree,
    operation_id: policy.operation_id,
    attempt_number: attempt.attempt_number,
    policy_sha256: hashObject(policy),
    evidence_sha256: hashObject(evidence),
  };
  result.result_digest = hashObject(result);
  return result;
}
