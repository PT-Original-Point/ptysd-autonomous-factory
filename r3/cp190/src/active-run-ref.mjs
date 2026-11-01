import { createHash } from 'node:crypto';

export const EXPECTED_DIRECTORY = Object.freeze({
  repositoryId: 1352411536,
  ref: 'refs/heads/governance/project-directory',
  descriptorPath: 'directory/descriptor.json',
});

const PROJECT_V1_KEYS = [
  'schema_version', 'project_id', 'canonical_name', 'aliases', 'normalization_version',
  'binding_id', 'registration_state', 'directory_revision', 'binding_generation',
  'control_locator', 'runtime_type', 'bootstrap_anchor', 'authorization_ref',
  'data_classification', 'previous_binding_ref', 'created_at', 'updated_at',
];
const PROJECT_V2_KEYS = [...PROJECT_V1_KEYS, 'active_run_ref'];
const DESCRIPTOR_KEYS = [
  'schema_version', 'descriptor_version', 'authority_mode', 'repository_id',
  'repository_full_name', 'root_ref', 'project_path_template', 'alias_path_template',
  'normalization_version', 'lookup_mode', 'binding_generation',
  'source_legacy_directory_revision', 'write_policy', 'legacy_postgres_mode',
  'current_control_locator', 'updated_at',
];
const LOCATOR_KEYS = ['provider', 'repository_id', 'ref', 'current_path'];
const ACTIVE_RUN_REF_KEYS = [
  'schema_version', 'project_id', 'binding_id', 'binding_generation',
  'directory_revision', 'resolution', 'control_locator',
];
const POINTER_KEYS = [
  'schema_version', 'project_id', 'binding_id', 'binding_generation',
  'checkpoint_seq', 'checkpoint_path', 'checkpoint_digest',
  'previous_control_oid', 'transition_id', 'reader_compatibility',
];
const CHECKPOINT_KEYS = [
  'schema_version', 'project_id', 'checkpoint_seq', 'transition_id',
  'previous_checkpoint_ref', 'migration_anchor', 'event', 'mission_anchor',
  'policy_anchor', 'controller_contract', 'verifier_digest', 'lifecycle',
  'owner', 'run_ref', 'task_id', 'attempt_id', 'attempt_epoch', 'atomic',
  'last_accepted', 'remote_wip', 'active_job_refs', 'unresolved_effect_refs',
  'blockers', 'last_verified_gate', 'next_legal_transition', 'stop_requested',
  'barrier', 'evidence_refs', 'recorded_at', 'payload_digest',
];
const LEGACY_CHECKPOINT_KEYS = [...CHECKPOINT_KEYS, 'authorization_mode'];
export const LEGACY_CHECKPOINT_PROFILE = Object.freeze({
  name: 'CSG_CHECKPOINT_V1_LEGACY_AUTHORIZATION_MODE_PROFILE',
  version: 1,
  repositoryId: 1352411536,
  controlRef: 'refs/heads/v45/factory-control',
  controlCommitSha: '209e0ad9040a08965a49109e18f783cfd9c7c7f4',
  checkpointPath: 'governance/csg/checkpoints/000190.json',
  checkpointGitBlobOid: '8991abd3e19757698b393ccd4b09fcad5f230651',
  checkpointRawSha256: '2591b20875405c4711397dff8b31d9d13ab77f10452c43d239ea567d40cdff8a',
  projectId: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
  checkpointSeq: 190,
  transitionId: 'GOV-HARDENING-P5-TUNNEL-CLI-CAPABILITY-PROBE-190',
  payloadDigest: 'sha256:7925c06ea87b9cd98cdd8b45fb8fe0766a99abd6cb520a76890749afce02dd2e',
  authorizationModeCanonicalSha256: 'sha256:ec0936da9d3ad196a165cd87fd920edbf7583682e0bfa840c2532907048e5f07',
});
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys, code = 'ILLEGAL_OR_MISSING_KEY') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('OBJECT_REQUIRED');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(code);
}

function requireId(value, code = 'INVALID_ID') {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(code);
  return value;
}

function requireInteger(value, code = 'INVALID_SAFE_INTEGER') {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function requireDigest(value, code = 'INVALID_DIGEST') {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(code);
  return value;
}

function requireRepoPath(value, code = 'INVALID_RELATIVE_PATH') {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') ||
      value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) fail(code);
  return value;
}

// Parse JSON while rejecting duplicate object keys before JSON.parse could erase them.
export function parseStrictJson(text) {
  if (typeof text !== 'string') fail('JSON_TEXT_REQUIRED');
  let index = 0;
  const whitespace = () => { while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index++; };
  const parseString = () => {
    if (text[index] !== '"') fail('JSON_STRING_REQUIRED');
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (text[index] === '"') {
        index++;
        try { return JSON.parse(text.slice(start, index)); } catch { fail('INVALID_JSON_STRING'); }
      }
      if (code < 0x20) fail('INVALID_JSON_STRING');
      if (text[index] === '\\') {
        index++;
        if (index >= text.length) fail('INVALID_JSON_STRING');
        if (text[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail('INVALID_JSON_STRING');
          index += 5;
        } else {
          if (!/["\\/bfnrt]/.test(text[index])) fail('INVALID_JSON_STRING');
          index++;
        }
      } else index++;
    }
    fail('UNTERMINATED_JSON_STRING');
  };
  const parseValue = (depth = 0) => {
    if (depth > 128) fail('JSON_TOO_DEEP');
    whitespace();
    const ch = text[index];
    if (ch === '"') return parseString();
    if (ch === '{') {
      index++;
      whitespace();
      const object = {};
      const seen = new Set();
      if (text[index] === '}') { index++; return object; }
      while (true) {
        whitespace();
        const key = parseString();
        if (seen.has(key)) fail(`DUPLICATE_JSON_KEY:${key}`);
        seen.add(key);
        whitespace();
        if (text[index++] !== ':') fail('JSON_COLON_REQUIRED');
        const value = parseValue(depth + 1);
        Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[index] === '}') { index++; return object; }
        if (text[index++] !== ',') fail('JSON_COMMA_REQUIRED');
      }
    }
    if (ch === '[') {
      index++;
      whitespace();
      const array = [];
      if (text[index] === ']') { index++; return array; }
      while (true) {
        array.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === ']') { index++; return array; }
        if (text[index++] !== ',') fail('JSON_COMMA_REQUIRED');
      }
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, index)) { index += token.length; return value; }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) fail('UNSAFE_JSON_NUMBER');
      return parsed;
    }
    fail('INVALID_JSON_TOKEN');
  };
  const value = parseValue();
  whitespace();
  if (index !== text.length) fail('JSON_TRAILING_DATA');
  return value;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('UNSAFE_CANONICAL_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') fail('NON_JSON_VALUE');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function checkpointPayloadDigest(checkpoint) {
  const copy = structuredClone(checkpoint);
  delete copy.payload_digest;
  return `sha256:${createHash('sha256').update(canonical(copy), 'utf8').digest('hex')}`;
}

function canonicalValueDigest(value) {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function gitBlobSha1(text) {
  const header = `blob ${Buffer.byteLength(text, 'utf8')}\0`;
  return createHash('sha1').update(header, 'utf8').update(text, 'utf8').digest('hex');
}

export function validateCurrentCheckpointSchema(checkpoint) {
  exactKeys(checkpoint, CHECKPOINT_KEYS, 'INVALID_CHECKPOINT_KEYS');
  if (checkpoint.schema_version !== 'csg.checkpoint.v1') fail('UNKNOWN_CHECKPOINT_SCHEMA');
  const digest = requireDigest(checkpoint.payload_digest, 'INVALID_CHECKPOINT_PAYLOAD_DIGEST');
  if (checkpointPayloadDigest(checkpoint) !== digest) fail('CHECKPOINT_DIGEST_MISMATCH');
  return checkpoint;
}

function validateLocator(value) {
  exactKeys(value, LOCATOR_KEYS, 'INVALID_CONTROL_LOCATOR_KEYS');
  if (value.provider !== 'github' || !Number.isSafeInteger(value.repository_id) || value.repository_id < 1) fail('INVALID_CONTROL_LOCATOR');
  if (typeof value.ref !== 'string' || !value.ref.startsWith('refs/heads/')) fail('INVALID_CONTROL_REF');
  requireRepoPath(value.current_path, 'INVALID_CONTROL_PATH');
  return value;
}

function sameLocator(a, b) {
  return a.provider === b.provider && a.repository_id === b.repository_id && a.ref === b.ref && a.current_path === b.current_path;
}

function validateDescriptor(descriptor) {
  exactKeys(descriptor, DESCRIPTOR_KEYS, 'INVALID_DIRECTORY_DESCRIPTOR_KEYS');
  if (descriptor.schema_version !== 'csg.directory-root.v1' || descriptor.descriptor_version !== 2) fail('UNKNOWN_DIRECTORY_SCHEMA');
  if (descriptor.repository_id !== EXPECTED_DIRECTORY.repositoryId || descriptor.root_ref !== EXPECTED_DIRECTORY.ref) fail('UNTRUSTED_DIRECTORY_ROOT');
  if (descriptor.project_path_template !== 'directory/projects/{project_id}.json' ||
      descriptor.alias_path_template !== 'directory/aliases/{normalized_name_sha256}.json' ||
      descriptor.lookup_mode !== 'EXACT_ALIAS_HASH_NO_REPOSITORY_SCAN') fail('UNKNOWN_DIRECTORY_LOOKUP_CONTRACT');
  if (descriptor.binding_generation !== 2 || descriptor.write_policy !== 'SINGLE_WRITER_GUARDED_CAS_NO_DUAL_WRITE' ||
      descriptor.legacy_postgres_mode !== 'READ_ONLY_AFTER_CUTOVER') fail('UNKNOWN_DIRECTORY_GOVERNANCE_POLICY');
  validateLocator(descriptor.current_control_locator);
  if (descriptor.current_control_locator.repository_id !== descriptor.repository_id) fail('DIRECTORY_CONTROL_REPOSITORY_MISMATCH');
  return descriptor;
}

function validateExternalRef(value, code = 'INVALID_EXTERNAL_REF') {
  exactKeys(value, ['kind', 'provider', 'repository_id_or_resource_id', 'revision', 'path', 'digest'], code);
  if (value.kind !== 'EXTERNAL_IMMUTABLE' || typeof value.provider !== 'string' || !value.provider ||
      typeof value.repository_id_or_resource_id !== 'string' || !value.repository_id_or_resource_id ||
      typeof value.revision !== 'string' || !value.revision) fail(code);
  requireRepoPath(value.path, code);
  requireDigest(value.digest, code);
  return value;
}

export function validateProjectRecord(project, descriptor, requestedProjectId) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) fail('PROJECT_RECORD_REQUIRED');
  if (project.schema_version === 'csg.project.v1') exactKeys(project, PROJECT_V1_KEYS, 'INVALID_PROJECT_V1_KEYS');
  else if (project.schema_version === 'csg.project.v2') exactKeys(project, PROJECT_V2_KEYS, 'INVALID_PROJECT_V2_KEYS');
  else fail('UNKNOWN_PROJECT_SCHEMA');
  if (project.project_id !== requestedProjectId) fail('PROJECT_ID_MISMATCH');
  requireId(project.project_id);
  requireId(project.binding_id, 'INVALID_BINDING_ID');
  requireInteger(project.directory_revision, 'INVALID_DIRECTORY_REVISION');
  requireInteger(project.binding_generation, 'INVALID_BINDING_GENERATION');
  if (project.binding_generation !== descriptor.binding_generation) fail('BINDING_GENERATION_MISMATCH');
  if (project.registration_state !== 'BOUND') fail('PROJECT_NOT_BOUND');
  if (project.runtime_type !== 'GITHUB_ACTIONS_BOUNDED') fail('UNSUPPORTED_RUNTIME_TYPE');
  if (!Array.isArray(project.aliases) || project.aliases.length > 32) fail('INVALID_PROJECT_ALIASES');
  for (const alias of project.aliases) exactKeys(alias, ['display_name', 'normalized_name'], 'INVALID_PROJECT_ALIAS');
  validateLocator(project.control_locator);
  if (!sameLocator(project.control_locator, descriptor.current_control_locator)) fail('PROJECT_CONTROL_LOCATOR_MISMATCH');
  if (project.bootstrap_anchor !== null) validateExternalRef(project.bootstrap_anchor, 'INVALID_BOOTSTRAP_ANCHOR');
  if (!project.bootstrap_anchor) fail('BOUND_PROJECT_REQUIRES_BOOTSTRAP');
  validateExternalRef(project.authorization_ref, 'INVALID_AUTHORIZATION_REF');
  if (!['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'].includes(project.data_classification)) fail('INVALID_DATA_CLASSIFICATION');
  if (project.previous_binding_ref !== null) validateExternalRef(project.previous_binding_ref, 'INVALID_PREVIOUS_BINDING_REF');
  if (typeof project.created_at !== 'string' || typeof project.updated_at !== 'string') fail('INVALID_PROJECT_TIMESTAMPS');
  if (project.schema_version === 'csg.project.v1') return project;
  const ref = project.active_run_ref;
  if (ref === null) return project;
  exactKeys(ref, ACTIVE_RUN_REF_KEYS, 'INVALID_ACTIVE_RUN_REF_KEYS');
  if (ref.schema_version !== 'csg.active-run-ref.v1') fail('UNKNOWN_ACTIVE_RUN_REF_SCHEMA');
  if (ref.resolution !== 'CURRENT_CANONICAL_CONTROL_POINTER_V1') fail('UNKNOWN_ACTIVE_RUN_REF_RESOLUTION');
  if (ref.project_id !== project.project_id || ref.binding_id !== project.binding_id ||
      ref.binding_generation !== project.binding_generation || ref.directory_revision !== project.directory_revision) fail('ACTIVE_RUN_REF_IDENTITY_MISMATCH');
  validateLocator(ref.control_locator);
  if (!sameLocator(ref.control_locator, project.control_locator)) fail('ACTIVE_RUN_REF_LOCATOR_MISMATCH');
  return project;
}

function validatePointer(pointer, project) {
  exactKeys(pointer, POINTER_KEYS, 'INVALID_POINTER_KEYS');
  if (pointer.schema_version !== 'csg.pointer.v1') fail('UNKNOWN_POINTER_SCHEMA');
  if (pointer.project_id !== project.project_id || pointer.binding_id !== project.binding_id ||
      pointer.binding_generation !== project.binding_generation) fail('POINTER_BINDING_MISMATCH');
  requireInteger(pointer.checkpoint_seq, 'INVALID_CHECKPOINT_SEQ');
  requireRepoPath(pointer.checkpoint_path, 'INVALID_CHECKPOINT_PATH');
  requireDigest(pointer.checkpoint_digest, 'INVALID_CHECKPOINT_DIGEST');
  requireId(pointer.transition_id, 'INVALID_TRANSITION_ID');
  exactKeys(pointer.reader_compatibility, ['min_schema', 'max_schema'], 'INVALID_READER_COMPATIBILITY');
  if (pointer.reader_compatibility.min_schema !== 'csg.checkpoint.v1' ||
      pointer.reader_compatibility.max_schema !== 'csg.checkpoint.v1') fail('UNSUPPORTED_CHECKPOINT_READER_RANGE');
  return pointer;
}

function qualifiesLegacyCheckpoint(checkpoint, pointer, context) {
  if (!context || typeof context.rawText !== 'string' ||
      context.repositoryId !== LEGACY_CHECKPOINT_PROFILE.repositoryId ||
      context.controlRef !== LEGACY_CHECKPOINT_PROFILE.controlRef ||
      context.controlCommitSha !== LEGACY_CHECKPOINT_PROFILE.controlCommitSha ||
      context.checkpointPath !== LEGACY_CHECKPOINT_PROFILE.checkpointPath ||
      pointer.checkpoint_path !== LEGACY_CHECKPOINT_PROFILE.checkpointPath ||
      pointer.checkpoint_seq !== LEGACY_CHECKPOINT_PROFILE.checkpointSeq ||
      pointer.checkpoint_digest !== LEGACY_CHECKPOINT_PROFILE.payloadDigest ||
      checkpoint.project_id !== LEGACY_CHECKPOINT_PROFILE.projectId ||
      checkpoint.checkpoint_seq !== LEGACY_CHECKPOINT_PROFILE.checkpointSeq ||
      checkpoint.transition_id !== LEGACY_CHECKPOINT_PROFILE.transitionId ||
      checkpoint.payload_digest !== LEGACY_CHECKPOINT_PROFILE.payloadDigest) return false;

  const rawSha256 = createHash('sha256').update(context.rawText, 'utf8').digest('hex');
  if (rawSha256 !== LEGACY_CHECKPOINT_PROFILE.checkpointRawSha256 ||
      gitBlobSha1(context.rawText) !== LEGACY_CHECKPOINT_PROFILE.checkpointGitBlobOid) return false;
  if (canonicalValueDigest(checkpoint.authorization_mode) !== LEGACY_CHECKPOINT_PROFILE.authorizationModeCanonicalSha256) return false;
  return true;
}

function validateCheckpoint(checkpoint, pointer, project, sourceContext) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) fail('OBJECT_REQUIRED');
  if (Object.hasOwn(checkpoint, 'authorization_mode')) {
    exactKeys(checkpoint, LEGACY_CHECKPOINT_KEYS, 'INVALID_CHECKPOINT_KEYS');
    if (!qualifiesLegacyCheckpoint(checkpoint, pointer, sourceContext)) fail('UNQUALIFIED_LEGACY_CHECKPOINT_REVISION');
  } else {
    validateCurrentCheckpointSchema(checkpoint);
  }
  if (checkpoint.schema_version !== 'csg.checkpoint.v1') fail('UNKNOWN_CHECKPOINT_SCHEMA');
  if (checkpoint.project_id !== project.project_id || checkpoint.checkpoint_seq !== pointer.checkpoint_seq ||
      checkpoint.transition_id !== pointer.transition_id) fail('CHECKPOINT_POINTER_IDENTITY_MISMATCH');
  const digest = requireDigest(checkpoint.payload_digest, 'INVALID_CHECKPOINT_PAYLOAD_DIGEST');
  if (digest !== pointer.checkpoint_digest || checkpointPayloadDigest(checkpoint) !== digest) fail('CHECKPOINT_DIGEST_MISMATCH');
  if (!Array.isArray(checkpoint.active_job_refs) || checkpoint.active_job_refs.length > 1) fail('ACTIVE_JOB_BOUND');
  if (!Array.isArray(checkpoint.unresolved_effect_refs) || checkpoint.unresolved_effect_refs.length > 1) fail('UNRESOLVED_EFFECT_BOUND');
  for (const ref of checkpoint.unresolved_effect_refs) {
    if (ref?.kind === 'EXTERNAL_IMMUTABLE') validateExternalRef(ref, 'INVALID_UNRESOLVED_EFFECT_REF');
    else if (ref?.kind === 'BUNDLE_OBJECT') {
      exactKeys(ref, ['kind', 'path', 'digest'], 'INVALID_UNRESOLVED_EFFECT_REF');
      requireRepoPath(ref.path, 'INVALID_UNRESOLVED_EFFECT_REF');
      requireDigest(ref.digest, 'INVALID_UNRESOLVED_EFFECT_REF');
    } else fail('INVALID_UNRESOLVED_EFFECT_REF');
  }
  if (checkpoint.run_ref === null) fail('ACTIVE_RUN_REF_HAS_NO_CANONICAL_RUN_REF');
  validateExternalRef(checkpoint.run_ref, 'INVALID_CANONICAL_RUN_REF');
  requireId(checkpoint.task_id, 'ACTIVE_ATTEMPT_TASK_MISSING');
  requireId(checkpoint.attempt_id, 'ACTIVE_ATTEMPT_ID_MISSING');
  requireInteger(checkpoint.attempt_epoch, 'ACTIVE_ATTEMPT_EPOCH_MISSING');
  if (!['ACTIVE', 'PAUSED', 'TERMINAL', 'ARCHIVED'].includes(checkpoint.lifecycle)) fail('INVALID_CHECKPOINT_LIFECYCLE');
  if (typeof checkpoint.stop_requested !== 'boolean' || !Array.isArray(checkpoint.blockers)) fail('INVALID_CHECKPOINT_STATE');
  return checkpoint;
}

function validateLocalDirectoryProjectOverlay(persistedProject, overlay, descriptor, requestedProjectId) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay) ||
      persistedProject.schema_version !== 'csg.project.v1' || overlay.schema_version !== 'csg.project.v2' ||
      Object.hasOwn(persistedProject, 'active_run_ref')) fail('UNQUALIFIED_DIRECTORY_PROJECT_OVERLAY');

  const persistedBase = structuredClone(persistedProject);
  delete persistedBase.schema_version;
  delete persistedBase.directory_revision;
  const overlayBase = structuredClone(overlay);
  delete overlayBase.schema_version;
  delete overlayBase.directory_revision;
  delete overlayBase.active_run_ref;
  if (canonical(persistedBase) !== canonical(overlayBase)) fail('DIRECTORY_OVERLAY_BASE_MISMATCH');
  if (overlay.directory_revision !== persistedProject.directory_revision + 1) fail('DIRECTORY_OVERLAY_REVISION_MISMATCH');
  return validateProjectRecord(overlay, descriptor, requestedProjectId);
}

function commitSha(value) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) fail('INVALID_COMMIT_SHA');
  return value;
}

async function readTextAt(source, repositoryId, sha, path) {
  const result = await source.readAtCommit({ repositoryId, commitSha: sha, path });
  if (typeof result !== 'string') fail('PINNED_READ_DID_NOT_RETURN_TEXT');
  return result;
}

/**
 * Resolve the current continuation identity through Directory -> active_run_ref ->
 * canonical control -> pointer-selected checkpoint. This is read-only and grants no permit.
 */
export async function resolveDirectoryActiveRun({ projectId, source, directoryProjectOverlay }) {
  requireId(projectId, 'INVALID_REQUESTED_PROJECT_ID');
  if (!source || typeof source.getRefOid !== 'function' || typeof source.readAtCommit !== 'function') fail('PINNED_READ_SOURCE_REQUIRED');

  const directorySha = commitSha(await source.getRefOid({ repositoryId: EXPECTED_DIRECTORY.repositoryId, ref: EXPECTED_DIRECTORY.ref }));
  const descriptor = validateDescriptor(parseStrictJson(await readTextAt(source, EXPECTED_DIRECTORY.repositoryId, directorySha, EXPECTED_DIRECTORY.descriptorPath)));
  const projectPath = descriptor.project_path_template.replace('{project_id}', projectId);
  requireRepoPath(projectPath, 'INVALID_DIRECTORY_PROJECT_PATH');
  const persistedProject = validateProjectRecord(
    parseStrictJson(await readTextAt(source, descriptor.repository_id, directorySha, projectPath)),
    descriptor,
    projectId,
  );
  const overlayUsed = directoryProjectOverlay !== undefined;
  const project = overlayUsed
    ? validateLocalDirectoryProjectOverlay(persistedProject, directoryProjectOverlay, descriptor, projectId)
    : persistedProject;
  if (project.schema_version === 'csg.project.v1' || project.active_run_ref === null) fail('ACTIVE_RUN_REF_MISSING');

  const activeRef = project.active_run_ref;
  const controlLocator = activeRef.control_locator;
  const controlSha = commitSha(await source.getRefOid({ repositoryId: controlLocator.repository_id, ref: controlLocator.ref }));
  const pointer = validatePointer(
    parseStrictJson(await readTextAt(source, controlLocator.repository_id, controlSha, controlLocator.current_path)),
    project,
  );
  const checkpointRaw = await readTextAt(source, controlLocator.repository_id, controlSha, pointer.checkpoint_path);
  const checkpoint = validateCheckpoint(parseStrictJson(checkpointRaw), pointer, project, {
    repositoryId: controlLocator.repository_id,
    controlRef: controlLocator.ref,
    controlCommitSha: controlSha,
    checkpointPath: pointer.checkpoint_path,
    rawText: checkpointRaw,
  });

  const [directoryShaAfter, controlShaAfter] = await Promise.all([
    source.getRefOid({ repositoryId: EXPECTED_DIRECTORY.repositoryId, ref: EXPECTED_DIRECTORY.ref }),
    source.getRefOid({ repositoryId: controlLocator.repository_id, ref: controlLocator.ref }),
  ]);
  if (commitSha(directoryShaAfter) !== directorySha) fail('DIRECTORY_REF_MOVED_DURING_RESOLUTION');
  if (commitSha(controlShaAfter) !== controlSha) fail('CONTROL_REF_MOVED_DURING_RESOLUTION');

  return {
    classification: overlayUsed ? 'LOCAL_NONCANONICAL_DIRECTORY_OVERLAY_RESOLUTION' : 'LOCAL_READ_ONLY_RESOLUTION',
    dispatch_authority: false,
    directory: {
      commit_sha: directorySha,
      persisted_project_schema_version: persistedProject.schema_version,
      local_overlay_used: overlayUsed,
      project_id: project.project_id,
      directory_revision: project.directory_revision,
      binding_id: project.binding_id,
      binding_generation: project.binding_generation,
    },
    active_run_ref: structuredClone(activeRef),
    canonical_control: {
      commit_sha: controlSha,
      schema_version: pointer.schema_version,
      checkpoint_seq: pointer.checkpoint_seq,
      checkpoint_path: pointer.checkpoint_path,
      checkpoint_digest: pointer.checkpoint_digest,
    },
    current_checkpoint: {
      schema_profile: Object.hasOwn(checkpoint, 'authorization_mode')
        ? LEGACY_CHECKPOINT_PROFILE.name
        : 'CSG_CHECKPOINT_V1_CURRENT_STRICT',
      schema_version: checkpoint.schema_version,
      checkpoint_seq: checkpoint.checkpoint_seq,
      payload_digest: checkpoint.payload_digest,
      run_ref: structuredClone(checkpoint.run_ref),
      task_id: checkpoint.task_id,
      attempt_id: checkpoint.attempt_id,
      attempt_epoch: checkpoint.attempt_epoch,
      lifecycle: checkpoint.lifecycle,
      barrier: checkpoint.barrier,
      stop_requested: checkpoint.stop_requested,
      active_job_refs: structuredClone(checkpoint.active_job_refs),
      unresolved_effect_refs: structuredClone(checkpoint.unresolved_effect_refs),
      blockers: structuredClone(checkpoint.blockers),
    },
  };
}
