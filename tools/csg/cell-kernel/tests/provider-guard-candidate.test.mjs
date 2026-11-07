import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateProviderGuardEvidence,
  PROVIDER_GUARD_EVIDENCE_SCHEMA,
  PROVIDER_GUARD_POLICY_SCHEMA,
} from '../provider-guard-candidate.mjs';

const oid = (digit) => digit.repeat(40);
const sha = (digit) => digit.repeat(64);

function fixture(outcome = 'ACKNOWLEDGED', postState = 'candidate') {
  const policy = {
    schema: PROVIDER_GUARD_POLICY_SCHEMA,
    provider: 'github',
    repository_id: '1352411536',
    resource_id: '1352411536',
    source_ref: 'refs/heads/codex/r3-16-candidate',
    target_ref: 'refs/heads/v49/accepted-source',
    base_commit: oid('1'),
    base_tree: oid('2'),
    candidate_commit: oid('3'),
    candidate_parent: oid('1'),
    candidate_tree: oid('4'),
    integration_tree: oid('4'),
    workflow_path: '.github/workflows/r3-16-provider-guard.yml',
    workflow_digest: sha('a'),
    job_name: 'provider-guard',
    app_id: '9001',
    protection_digest: sha('b'),
    protection_profile: {
      enforce_admins: true,
      allow_force_pushes: false,
      allow_deletions: false,
      required_approving_review_count: 1,
    },
    sender_id: 'publisher-01',
    operation_id: 'R3-16-OP-LOCAL-001',
    idempotency_key: 'r3-16-local-001',
  };
  const candidateBinding = Object.fromEntries(
    Object.entries(policy).filter(([key]) => !['schema', 'protection_digest', 'protection_profile'].includes(key)),
  );
  const evidence = {
    schema: PROVIDER_GUARD_EVIDENCE_SCHEMA,
    candidate_binding: candidateBinding,
    required_check_readback: {
      origin: 'GITHUB_CHECKS_READBACK', repository_id: policy.repository_id, target_ref: policy.target_ref,
      run_id: 'run-123', run_attempt: 1, head_sha: policy.candidate_commit, head_tree: policy.candidate_tree,
      base_sha: policy.base_commit, workflow_path: policy.workflow_path, workflow_digest: policy.workflow_digest,
      job_name: policy.job_name, app_id: policy.app_id, status: 'completed', conclusion: 'success',
    },
    branch_protection_readback: {
      origin: 'GITHUB_BRANCH_PROTECTION_READBACK', repository_id: policy.repository_id, target_ref: policy.target_ref,
      revision: oid('5'), config_digest: policy.protection_digest,
      settings: { ...policy.protection_profile },
      required_checks: [{ workflow_path: policy.workflow_path, workflow_digest: policy.workflow_digest, job_name: policy.job_name, app_id: policy.app_id }],
    },
    sender_fence_readback: {
      origin: 'GITHUB_SINGLE_SENDER_FENCE_READBACK', repository_id: policy.repository_id,
      resource_id: policy.resource_id, target_ref: policy.target_ref, fence_id: 'fence-01', generation: 1,
      owner_id: policy.sender_id, active_sender_ids: [policy.sender_id], attempt_count: 1,
      observed_at_utc: '2026-09-26T00:00:00Z', payload_sha256: sha('c'),
    },
    pre_target_readback: {
      origin: 'GITHUB_REF_READBACK', repository_id: policy.repository_id, resource_id: policy.resource_id,
      ref: policy.target_ref, exists: true, commit: policy.base_commit, tree: policy.base_tree,
      revision: oid('1'), observed_at_utc: '2026-09-26T00:00:01Z', payload_sha256: sha('d'),
    },
    publish_attempt: {
      operation_id: policy.operation_id, idempotency_key: policy.idempotency_key,
      sender_id: policy.sender_id, attempt_number: 1, outcome,
      provider_request_id: outcome === 'NOT_DISPATCHED' ? null : 'provider-request-1',
    },
    post_target_readback: postState === null ? null : {
      origin: 'GITHUB_REF_READBACK', repository_id: policy.repository_id, resource_id: policy.resource_id,
      ref: policy.target_ref, exists: true,
      commit: postState === 'candidate' ? policy.candidate_commit : postState === 'base' ? policy.base_commit : oid('6'),
      tree: postState === 'candidate' ? policy.candidate_tree : postState === 'base' ? policy.base_tree : oid('7'),
      revision: postState === 'candidate' ? oid('3') : postState === 'base' ? oid('1') : oid('6'),
      observed_at_utc: '2026-09-26T00:00:02Z', payload_sha256: sha('e'),
    },
  };
  return { policy, evidence };
}

test('exact tree, protected check, branch settings, pre/post readback and one sender are shape-consistent', () => {
  const { policy, evidence } = fixture();
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.decision, 'ACKNOWLEDGED_AND_POSTSTATE_EXACT');
  assert.equal(result.dispatch_allowed, false);
  assert.equal(result.provider_api_called, false);
  assert.equal(result.retry_allowed, false);
  assert.equal(result.canonical_acceptance, false);
  assert.match(result.result_digest, /^[0-9a-f]{64}$/);
});

test('lost acknowledgement plus exact candidate target readback reconciles without retry', () => {
  const { policy, evidence } = fixture('ACK_LOST', 'candidate');
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.decision, 'ACK_LOSS_RECONCILED_CANDIDATE_PRESENT');
  assert.equal(result.retry_allowed, false);
});

test('lost acknowledgement plus unchanged prestate remains unknown and cannot retry', () => {
  const { policy, evidence } = fixture('ACK_LOST', 'base');
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.decision, 'ACK_LOSS_UNRESOLVED_NO_RETRY');
  assert.equal(result.retry_allowed, false);
});

test('lost acknowledgement plus an unexpected target state is a conflict and cannot retry', () => {
  const { policy, evidence } = fixture('ACK_LOST', 'other');
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.decision, 'ACK_LOSS_CONFLICT_NO_RETRY');
});

test('missing post-readback after acknowledgement loss stays unknown without a retry', () => {
  const { policy, evidence } = fixture('ACK_LOST', null);
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.decision, 'UNKNOWN_NO_RETRY');
});

test('candidate must be an exact direct child and match its integration tree', () => {
  const directParent = fixture();
  directParent.policy.candidate_parent = oid('8');
  assert.throws(() => evaluateProviderGuardEvidence(directParent), /CANDIDATE_NOT_DIRECT_CHILD_OF_BASE/);
  const wrongTree = fixture();
  wrongTree.policy.integration_tree = oid('9');
  assert.throws(() => evaluateProviderGuardEvidence(wrongTree), /INTEGRATION_TREE_MISMATCH/);
});

test('required check readback must bind exact candidate head, tree, workflow, job and app', () => {
  const { policy, evidence } = fixture();
  evidence.required_check_readback.head_sha = oid('8');
  assert.throws(() => evaluateProviderGuardEvidence({ policy, evidence }), /CHECK_READBACK_MISMATCH_HEAD_SHA/);
});

test('branch protection must contain the exact uniquely identified required check', () => {
  const { policy, evidence } = fixture();
  evidence.branch_protection_readback.required_checks = [];
  assert.throws(() => evaluateProviderGuardEvidence({ policy, evidence }), /EXACT_REQUIRED_CHECK_NOT_PROTECTED_UNIQUELY/);
});

test('protection digest and settings must match the pinned policy', () => {
  const { policy, evidence } = fixture();
  evidence.branch_protection_readback.settings.allow_force_pushes = true;
  assert.throws(() => evaluateProviderGuardEvidence({ policy, evidence }), /PROTECTION_SETTINGS_MISMATCH/);
});

test('unknown or multiple active senders fail closed', () => {
  const { policy, evidence } = fixture();
  evidence.sender_fence_readback.active_sender_ids.push('publisher-02');
  assert.throws(() => evaluateProviderGuardEvidence({ policy, evidence }), /MULTIPLE_OR_UNKNOWN_ACTIVE_SENDERS/);
});

test('a second attempt fails closed even with an otherwise valid provider readback', () => {
  const { policy, evidence } = fixture();
  evidence.publish_attempt.attempt_number = 2;
  assert.throws(() => evaluateProviderGuardEvidence({ policy, evidence }), /PUBLISH_ATTEMPT_NOT_SINGLE/);
});

test('cross-resource provider readbacks and unreviewed fields fail closed', () => {
  const wrongTarget = fixture();
  wrongTarget.evidence.pre_target_readback.resource_id = 'other-resource';
  assert.throws(() => evaluateProviderGuardEvidence(wrongTarget), /PRE_TARGET_READBACK_TARGET_MISMATCH/);
  const extra = fixture();
  extra.evidence.unreviewed = true;
  assert.throws(() => evaluateProviderGuardEvidence(extra), /PROVIDER_GUARD_EVIDENCE_FIELDS_INVALID/);
});

test('NOT_DISPATCHED remains non-dispatching and requires no poststate claim', () => {
  const { policy, evidence } = fixture('NOT_DISPATCHED', null);
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.decision, 'NOT_DISPATCHED');
  assert.equal(result.provider_api_called, false);
  assert.equal(result.retry_allowed, false);
});

test('policy expectations and evidence are explicitly local data, never canonical acceptance', () => {
  const { policy, evidence } = fixture();
  const result = evaluateProviderGuardEvidence({ policy, evidence });
  assert.equal(result.evidence_quality, 'SHAPE_CHECK_ONLY_PROVIDER_AUTHENTICATION_NOT_PERFORMED');
  assert.equal(result.canonical_acceptance, false);
  assert.equal(result.host_or_production_qualification, false);
  assert.match(result.policy_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.evidence_sha256, /^[0-9a-f]{64}$/);
});

test('versioned isolated-CI contract is non-dispatching and cannot trust candidate-owned acceptance', () => {
  const contract = JSON.parse(readFileSync(new URL('../../../../governance/r3-16/provider-guard-contract-candidate.v1.json', import.meta.url), 'utf8'));
  assert.equal(contract.dispatch_enabled, false);
  assert.equal(contract.provider_api_enabled, false);
  assert.equal(contract.trusted_verifier, false);
  assert.equal(contract.isolated_ci_recipe.activation_state, 'DOCUMENTATION_ONLY_NOT_A_GITHUB_WORKFLOW');
  assert.equal(contract.isolated_ci_recipe.candidate_owned_tests_define_acceptance, false);
  assert.equal(contract.acknowledgement_loss.resend_allowed, false);
});
