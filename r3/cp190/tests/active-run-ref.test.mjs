import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  checkpointPayloadDigest,
  LEGACY_CHECKPOINT_PROFILE,
  parseStrictJson,
  resolveDirectoryActiveRun,
  validateCurrentCheckpointSchema,
  validateProjectRecord,
} from '../src/active-run-ref.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR_SHA = 'f22a9eb9e75d6b2d89dc9b950109910af8d290bb';
const CONTROL_SHA = '209e0ad9040a08965a49109e18f783cfd9c7c7f4';
const PROJECT_ID = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
const READ_FILES = {
  directoryDescriptor: 'evidence/source-readback/directory-descriptor-f22a.json',
  legacyProject: 'evidence/source-readback/directory-project-f22a.json',
  control: 'evidence/source-readback/current-control-209e.json',
  checkpoint: 'evidence/source-readback/checkpoint-000190-209e.json',
  pr297Control: 'evidence/source-readback/current-control-pr297-1375.json',
  pr297Checkpoint: 'evidence/source-readback/checkpoint-000191-pr297-1375.json',
  csgSchema: 'evidence/source-readback/csg-schema-209e.mjs',
  legacyProfile: 'profiles/csg-checkpoint-v1-legacy-authorization-mode.profile.json',
};
const SCHEMAS = {
  projectV2: 'schemas/csg/project.v2.schema.json',
  activeRunRefV1: 'schemas/csg/active-run-ref.v1.schema.json',
};

async function raw(name) { return readFile(path.join(ROOT, READ_FILES[name]), 'utf8'); }
function rawSha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function gitBlobSha1(text) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0`, 'utf8').update(text, 'utf8').digest('hex');
}
async function baseInputs() {
  return {
    descriptor: parseStrictJson(await raw('directoryDescriptor')),
    legacyProject: parseStrictJson(await raw('legacyProject')),
    control: parseStrictJson(await raw('control')),
    checkpoint: parseStrictJson(await raw('checkpoint')),
  };
}

function version2(project, overrides = {}) {
  const nextRevision = project.directory_revision + 1;
  return {
    ...project,
    schema_version: 'csg.project.v2',
    directory_revision: nextRevision,
    active_run_ref: {
      schema_version: 'csg.active-run-ref.v1',
      project_id: project.project_id,
      binding_id: project.binding_id,
      binding_generation: project.binding_generation,
      directory_revision: nextRevision,
      resolution: 'CURRENT_CANONICAL_CONTROL_POINTER_V1',
      control_locator: structuredClone(project.control_locator),
      ...overrides.activeRunRef,
    },
  };
}

function sourceFor({ descriptorRaw, projectRaw, controlRaw, checkpointRaw, controlSha = CONTROL_SHA, directorySha = DIR_SHA, driftControl = false, driftDirectory = false }) {
  let controlReads = 0;
  let directoryReads = 0;
  return {
    async getRefOid({ repositoryId, ref }) {
      if (repositoryId === 1352411536 && ref === 'refs/heads/governance/project-directory') {
        directoryReads++;
        return driftDirectory && directoryReads > 1 ? '1111111111111111111111111111111111111111' : directorySha;
      }
      if (repositoryId === 1352411536 && ref === 'refs/heads/v45/factory-control') {
        controlReads++;
        return driftControl && controlReads > 1 ? '2222222222222222222222222222222222222222' : controlSha;
      }
      throw new Error('UNKNOWN_REF_LOOKUP');
    },
    async readAtCommit({ repositoryId, commitSha, path: artifactPath }) {
      if (repositoryId !== 1352411536) throw new Error('UNKNOWN_REPOSITORY');
      if (commitSha === directorySha && artifactPath === 'directory/descriptor.json') return descriptorRaw;
      if (commitSha === directorySha && artifactPath === `directory/projects/${PROJECT_ID}.json`) return projectRaw;
      if (commitSha === controlSha && artifactPath === 'governance/csg/current.json') return controlRaw;
      if (commitSha === controlSha && artifactPath === 'governance/csg/checkpoints/000190.json') return checkpointRaw;
      throw new Error(`UNEXPECTED_PINNED_PATH:${artifactPath}`);
    },
  };
}

function syntheticValidSnapshot(project, { wrongPointerDigest = false, driftControl = false, driftDirectory = false } = {}) {
  const syntheticDirectorySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const syntheticControlSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const checkpointPath = 'governance/csg/checkpoints/000001.json';
  const checkpoint = {
    schema_version: 'csg.checkpoint.v1',
    project_id: project.project_id,
    checkpoint_seq: 1,
    transition_id: 'LOCAL-SYNTHETIC-TRANSITION-001',
    previous_checkpoint_ref: null,
    migration_anchor: null,
    event: { type: 'ATOMIC_STARTED', reason_code: 'LOCAL_SYNTHETIC_FIXTURE', subject_id: 'LOCAL-SYNTHETIC-UNIT' },
    mission_anchor: { ref: 'LOCAL_SYNTHETIC_MISSION', revision: 'LOCAL-ONLY', declared_hash: `sha256:${'1'.repeat(64)}`, canonicalization_version: 'LOCAL_SYNTHETIC' },
    policy_anchor: { ref: 'LOCAL_SYNTHETIC_POLICY', revision: 'LOCAL-ONLY', declared_hash: `sha256:${'2'.repeat(64)}`, canonicalization_version: 'LOCAL_SYNTHETIC' },
    controller_contract: 'LOCAL_SYNTHETIC_ONLY',
    verifier_digest: `sha256:${'3'.repeat(64)}`,
    lifecycle: 'ACTIVE',
    owner: null,
    run_ref: { kind: 'EXTERNAL_IMMUTABLE', provider: 'GitHub', repository_id_or_resource_id: '1352411536', revision: 'LOCAL-SYNTHETIC-OID', path: 'runs/LOCAL-SYNTHETIC-0001/run.json', digest: `sha256:${'4'.repeat(64)}` },
    task_id: 'LOCAL-SYNTHETIC-TASK-001',
    attempt_id: 'LOCAL-SYNTHETIC-ATTEMPT-001',
    attempt_epoch: 1,
    atomic: { state: 'IN_PROGRESS', unit_id: 'LOCAL-SYNTHETIC-UNIT' },
    last_accepted: null,
    remote_wip: null,
    active_job_refs: [],
    unresolved_effect_refs: [],
    blockers: [],
    last_verified_gate: null,
    next_legal_transition: { action: 'LOCAL_SYNTHETIC_READ_ONLY', unit_id: null, requires: [], forbidden: [] },
    stop_requested: false,
    barrier: 'ACTIVE_UNIT',
    evidence_refs: [],
    recorded_at: '2026-09-24T00:00:00Z',
    payload_digest: '',
  };
  checkpoint.payload_digest = checkpointPayloadDigest(checkpoint);
  const pointer = {
    schema_version: 'csg.pointer.v1',
    project_id: project.project_id,
    binding_id: project.binding_id,
    binding_generation: project.binding_generation,
    checkpoint_seq: checkpoint.checkpoint_seq,
    checkpoint_path: checkpointPath,
    checkpoint_digest: wrongPointerDigest ? `sha256:${'0'.repeat(64)}` : checkpoint.payload_digest,
    previous_control_oid: { algorithm: 'sha1', hex: '0'.repeat(40) },
    transition_id: checkpoint.transition_id,
    reader_compatibility: { min_schema: 'csg.checkpoint.v1', max_schema: 'csg.checkpoint.v1' },
  };
  const descriptor = {
    schema_version: 'csg.directory-root.v1',
    descriptor_version: 2,
    authority_mode: 'CANONICAL_EXACT_IDENTITY',
    repository_id: 1352411536,
    repository_full_name: 'PT-Original-Point/ptysd-vnext42-governance-sandbox',
    root_ref: 'refs/heads/governance/project-directory',
    project_path_template: 'directory/projects/{project_id}.json',
    alias_path_template: 'directory/aliases/{normalized_name_sha256}.json',
    normalization_version: 'PYTHON_UNICODE_NFKC_CASEFOLD_COLLAPSE_WS_V1',
    lookup_mode: 'EXACT_ALIAS_HASH_NO_REPOSITORY_SCAN',
    binding_generation: 2,
    source_legacy_directory_revision: 3,
    write_policy: 'SINGLE_WRITER_GUARDED_CAS_NO_DUAL_WRITE',
    legacy_postgres_mode: 'READ_ONLY_AFTER_CUTOVER',
    current_control_locator: structuredClone(project.control_locator),
    updated_at: '2026-09-16T15:35:30Z',
  };
  const source = {
    directoryReads: 0,
    controlReads: 0,
    async getRefOid({ repositoryId, ref }) {
      if (repositoryId === 1352411536 && ref === 'refs/heads/governance/project-directory') {
        this.directoryReads++;
        return driftDirectory && this.directoryReads > 1 ? 'dddddddddddddddddddddddddddddddddddddddd' : syntheticDirectorySha;
      }
      if (repositoryId === 1352411536 && ref === 'refs/heads/v45/factory-control') {
        this.controlReads++;
        return driftControl && this.controlReads > 1 ? 'cccccccccccccccccccccccccccccccccccccccc' : syntheticControlSha;
      }
      throw new Error('UNKNOWN_REF_LOOKUP');
    },
    async readAtCommit({ repositoryId, commitSha, path: artifactPath }) {
      if (repositoryId !== 1352411536) throw new Error('UNKNOWN_REPOSITORY');
      if (commitSha === syntheticDirectorySha && artifactPath === 'directory/descriptor.json') return JSON.stringify(descriptor);
      if (commitSha === syntheticDirectorySha && artifactPath === `directory/projects/${PROJECT_ID}.json`) return JSON.stringify(project);
      if (commitSha === syntheticControlSha && artifactPath === 'governance/csg/current.json') return JSON.stringify(pointer);
      if (commitSha === syntheticControlSha && artifactPath === checkpointPath) return JSON.stringify(checkpoint);
      throw new Error(`UNEXPECTED_PINNED_PATH:${artifactPath}`);
    },
  };
  return { source, checkpoint, pointer, syntheticDirectorySha, syntheticControlSha };
}

function code(error) { return error?.code ?? error?.message; }

test('legacy Directory v1 stays readable and does not acquire an active-run identity', async () => {
  const base = await baseInputs();
  const legacyRead = validateProjectRecord(base.legacyProject, base.descriptor, PROJECT_ID);
  assert.equal(legacyRead.schema_version, 'csg.project.v1');
  assert.equal(legacyRead.directory_revision, 4);
  const source = sourceFor({ descriptorRaw: JSON.stringify(base.descriptor), projectRaw: JSON.stringify(base.legacyProject) });
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'ACTIVE_RUN_REF_MISSING');
  assert.equal(Object.hasOwn(base.legacyProject, 'active_run_ref'), false);
  assert.equal(Object.hasOwn(base.legacyProject, 'active_run_id'), false);
});

test('fresh-session continuation resolves only from Directory v2 through the current pointer and checkpoint', async () => {
  const base = await baseInputs();
  const nextProject = version2(base.legacyProject);
  const synthetic = syntheticValidSnapshot(nextProject);

  // LOCAL_SYNTHETIC only: a new source object has no cached state; identity comes from pinned reads.
  const result = await resolveDirectoryActiveRun({ projectId: PROJECT_ID, source: synthetic.source });
  assert.equal(result.classification, 'LOCAL_READ_ONLY_RESOLUTION');
  assert.equal(result.dispatch_authority, false);
  assert.equal(result.directory.commit_sha, synthetic.syntheticDirectorySha);
  assert.equal(result.canonical_control.commit_sha, synthetic.syntheticControlSha);
  assert.equal(result.canonical_control.checkpoint_seq, 1);
  assert.equal(result.current_checkpoint.task_id, 'LOCAL-SYNTHETIC-TASK-001');
  assert.equal(result.current_checkpoint.attempt_id, 'LOCAL-SYNTHETIC-ATTEMPT-001');
  assert.equal(result.current_checkpoint.attempt_epoch, 1);
  assert.equal(result.current_checkpoint.run_ref.path, 'runs/LOCAL-SYNTHETIC-0001/run.json');
  assert.deepEqual(result.current_checkpoint.unresolved_effect_refs, []);
  assert.equal(Object.hasOwn(result, 'active_run_id'), false);
  assert.equal(Object.hasOwn(result.current_checkpoint, 'active_run_id'), false);
});

test('the exact current Directory v1 record has no active-run reference and fails closed', async () => {
  const base = await baseInputs();
  const source = sourceFor({
    descriptorRaw: await raw('directoryDescriptor'),
    projectRaw: await raw('legacyProject'),
    controlRaw: await raw('control'),
    checkpointRaw: await raw('checkpoint'),
  });
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'ACTIVE_RUN_REF_MISSING');
  assert.equal(base.legacyProject.schema_version, 'csg.project.v1');
  assert.equal(Object.hasOwn(base.legacyProject, 'active_run_ref'), false);
});

test('exact CP190 resolves read-only with only an explicit local Directory v2 overlay', async () => {
  const base = await baseInputs();
  const profile = parseStrictJson(await raw('legacyProfile'));
  const raw190 = await raw('checkpoint');
  assert.equal(base.checkpoint.authorization_mode.mode, 'DURABLE_AUTHORIZATION_ENVELOPE');
  assert.equal(checkpointPayloadDigest(base.checkpoint), base.control.checkpoint_digest);
  assert.equal(gitBlobSha1(raw190), profile.qualification.checkpoint_git_blob_oid);
  assert.equal(rawSha256(raw190), profile.qualification.checkpoint_raw_sha256);
  assert.equal(profile.profile_name, LEGACY_CHECKPOINT_PROFILE.name);
  assert.equal(profile.profile_version, LEGACY_CHECKPOINT_PROFILE.version);
  assert.deepEqual(profile.legacy_field.exact_allowed_shape_and_values, base.checkpoint.authorization_mode);
  assert.equal(profile.legacy_field.canonical_sha256, LEGACY_CHECKPOINT_PROFILE.authorizationModeCanonicalSha256);
  assert.equal(profile.qualification.checkpoint_git_blob_oid, LEGACY_CHECKPOINT_PROFILE.checkpointGitBlobOid);
  assert.equal(profile.qualification.checkpoint_raw_sha256, LEGACY_CHECKPOINT_PROFILE.checkpointRawSha256);
  const source = sourceFor({
    descriptorRaw: await raw('directoryDescriptor'),
    projectRaw: await raw('legacyProject'),
    controlRaw: await raw('control'),
    checkpointRaw: await raw('checkpoint'),
  });
  const result = await resolveDirectoryActiveRun({
    projectId: PROJECT_ID,
    source,
    directoryProjectOverlay: version2(base.legacyProject),
  });
  assert.equal(result.classification, 'LOCAL_NONCANONICAL_DIRECTORY_OVERLAY_RESOLUTION');
  assert.equal(result.dispatch_authority, false);
  assert.equal(result.directory.commit_sha, DIR_SHA);
  assert.equal(result.directory.persisted_project_schema_version, 'csg.project.v1');
  assert.equal(result.directory.local_overlay_used, true);
  assert.equal(result.canonical_control.commit_sha, CONTROL_SHA);
  assert.equal(result.canonical_control.checkpoint_seq, 190);
  assert.equal(result.current_checkpoint.schema_profile, LEGACY_CHECKPOINT_PROFILE.name);
  assert.equal(result.current_checkpoint.payload_digest, base.checkpoint.payload_digest);
  assert.equal(result.current_checkpoint.attempt_epoch, base.checkpoint.attempt_epoch);
  assert.equal(Object.hasOwn(result, 'active_run_id'), false);
});

test('exact CP190 plus an arbitrary unknown top-level key fails closed', async () => {
  const base = await baseInputs();
  const mutated = { ...base.checkpoint, unqualified_extra: true };
  const source = sourceFor({
    descriptorRaw: await raw('directoryDescriptor'),
    projectRaw: await raw('legacyProject'),
    controlRaw: await raw('control'),
    checkpointRaw: JSON.stringify(mutated),
  });
  await assert.rejects(
    resolveDirectoryActiveRun({ projectId: PROJECT_ID, source, directoryProjectOverlay: version2(base.legacyProject) }),
    (error) => code(error) === 'INVALID_CHECKPOINT_KEYS',
  );
});

test('strict current schema accepts exact CP191 from the pinned PR297 head', async () => {
  const raw191 = await raw('pr297Checkpoint');
  const cp191 = parseStrictJson(raw191);
  const validatorSource = await raw('csgSchema');
  const schemaList = validatorSource.match(/['"]csg\.checkpoint\.v1['"]:\[([^\]]+)\]/);
  assert.ok(schemaList, 'pinned base validator exposes an exact checkpoint v1 key set');
  const pinnedKeys = [...schemaList[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  const profile = parseStrictJson(await raw('legacyProfile'));
  assert.deepEqual(Object.keys(cp191).sort(), pinnedKeys);
  assert.equal(gitBlobSha1(raw191), '0180e5eb9c65342675f4e4dd743c5a1a04430da1');
  assert.equal(rawSha256(raw191), 'ecc7865c8c1c6679c6e774722fb1c368a332975e9f568fbc18a799880b17ecee');
  assert.deepEqual(profile.current_schema.strict_checkpoint_keys.sort(), pinnedKeys);
  assert.equal(Object.hasOwn(cp191, 'authorization_mode'), false);
  assert.equal(validateCurrentCheckpointSchema(cp191), cp191);
  assert.equal(checkpointPayloadDigest(cp191), cp191.payload_digest);
  const pointer191 = parseStrictJson(await raw('pr297Control'));
  assert.equal(pointer191.checkpoint_seq, cp191.checkpoint_seq);
  assert.equal(pointer191.checkpoint_path, 'governance/csg/checkpoints/000191.json');
  assert.equal(pointer191.checkpoint_digest, cp191.payload_digest);
});

test('newer checkpoint carrying legacy authorization_mode is rejected by the strict current schema', async () => {
  const base = await baseInputs();
  const cp191 = parseStrictJson(await raw('pr297Checkpoint'));
  const newCheckpoint = { ...cp191, authorization_mode: base.checkpoint.authorization_mode };
  assert.throws(() => validateCurrentCheckpointSchema(newCheckpoint), (error) => code(error) === 'INVALID_CHECKPOINT_KEYS');
});

test('CP190 legacy profile rejects a different historical control revision', async () => {
  const base = await baseInputs();
  const source = sourceFor({
    descriptorRaw: await raw('directoryDescriptor'),
    projectRaw: await raw('legacyProject'),
    controlRaw: await raw('control'),
    checkpointRaw: await raw('checkpoint'),
    controlSha: '1111111111111111111111111111111111111111',
  });
  await assert.rejects(
    resolveDirectoryActiveRun({ projectId: PROJECT_ID, source, directoryProjectOverlay: version2(base.legacyProject) }),
    (error) => code(error) === 'UNQUALIFIED_LEGACY_CHECKPOINT_REVISION',
  );
});

test('CP190 legacy profile rejects changed bytes even when the parsed object is unchanged', async () => {
  const base = await baseInputs();
  const source = sourceFor({
    descriptorRaw: await raw('directoryDescriptor'),
    projectRaw: await raw('legacyProject'),
    controlRaw: await raw('control'),
    checkpointRaw: `${await raw('checkpoint')} `,
  });
  await assert.rejects(
    resolveDirectoryActiveRun({ projectId: PROJECT_ID, source, directoryProjectOverlay: version2(base.legacyProject) }),
    (error) => code(error) === 'UNQUALIFIED_LEGACY_CHECKPOINT_REVISION',
  );
});

test('unknown project schema fails closed', async () => {
  const base = await baseInputs();
  const project = { ...base.legacyProject, schema_version: 'csg.project.v99' };
  const source = sourceFor({ descriptorRaw: JSON.stringify(base.descriptor), projectRaw: JSON.stringify(project) });
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'UNKNOWN_PROJECT_SCHEMA');
});

test('unknown active-run-ref version fails closed', async () => {
  const base = await baseInputs();
  const project = version2(base.legacyProject, { activeRunRef: { schema_version: 'csg.active-run-ref.v99' } });
  const source = sourceFor({ descriptorRaw: JSON.stringify(base.descriptor), projectRaw: JSON.stringify(project) });
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'UNKNOWN_ACTIVE_RUN_REF_SCHEMA');
});

test('unknown fields such as active_run_id are rejected rather than adopted', async () => {
  const base = await baseInputs();
  const project = { ...version2(base.legacyProject), active_run_id: 'SHOULD_NOT_BE_USED' };
  const source = sourceFor({ descriptorRaw: JSON.stringify(base.descriptor), projectRaw: JSON.stringify(project) });
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'INVALID_PROJECT_V2_KEYS');
});

test('reference identity and locator must exactly match the bound Directory record', async () => {
  const base = await baseInputs();
  const project = version2(base.legacyProject, {
    activeRunRef: { control_locator: { ...base.legacyProject.control_locator, ref: 'refs/heads/other-control' } },
  });
  const source = sourceFor({ descriptorRaw: JSON.stringify(base.descriptor), projectRaw: JSON.stringify(project) });
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'ACTIVE_RUN_REF_LOCATOR_MISMATCH');
});

test('pointer and checkpoint digest pair must match', async () => {
  const base = await baseInputs();
  const project = version2(base.legacyProject);
  const source = syntheticValidSnapshot(project, { wrongPointerDigest: true }).source;
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'CHECKPOINT_DIGEST_MISMATCH');
});

test('branch movement during the read window fails closed', async () => {
  const base = await baseInputs();
  const project = version2(base.legacyProject);
  const source = syntheticValidSnapshot(project, { driftControl: true }).source;
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'CONTROL_REF_MOVED_DURING_RESOLUTION');
});

test('Directory movement during the read window fails closed', async () => {
  const base = await baseInputs();
  const project = version2(base.legacyProject);
  const source = syntheticValidSnapshot(project, { driftDirectory: true }).source;
  await assert.rejects(resolveDirectoryActiveRun({ projectId: PROJECT_ID, source }), (error) => code(error) === 'DIRECTORY_REF_MOVED_DURING_RESOLUTION');
});

test('strict JSON rejects duplicate keys before they can mask a changed identity', () => {
  assert.throws(() => parseStrictJson('{"project_id":"A","project_id":"B"}'), /DUPLICATE_JSON_KEY:project_id/);
  assert.throws(() => parseStrictJson('{"schema_version":"csg.checkpoint.v1",'), /JSON_/);
});

test('candidate JSON Schemas are version-pinned and reject additional fields', async () => {
  const projectSchema = parseStrictJson(await readFile(path.join(ROOT, SCHEMAS.projectV2), 'utf8'));
  const refSchema = parseStrictJson(await readFile(path.join(ROOT, SCHEMAS.activeRunRefV1), 'utf8'));
  assert.equal(projectSchema.properties.schema_version.const, 'csg.project.v2');
  assert.equal(projectSchema.additionalProperties, false);
  assert.equal(projectSchema.properties.active_run_ref.anyOf[1].$ref, 'active-run-ref.v1.schema.json');
  assert.equal(refSchema.properties.schema_version.const, 'csg.active-run-ref.v1');
  assert.equal(refSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(refSchema.properties, 'active_run_id'), false);
  assert.equal(Object.hasOwn(refSchema.properties, 'run_id'), false);
});
