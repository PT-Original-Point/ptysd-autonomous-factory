import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { summarizeV2AuthJson, summarizeV2AuthProviderJson, summarizeV2Models, readV2ProviderAuth,
  runV2Readiness, summarizeAntigravityCreditSetting, summarizeAntigravityV2Models,
  runAntigravityV2Readiness, summarizeAntigravityUsage, inspectAntigravityZeroInferenceEnvelope, summarizeAntigravityToolPolicy,
  readAntigravityProjectBinding, resolveAntigravityProjectId,
  antigravityV2ReadinessExecutionFailure, readAntigravityV2RunEvidence,
  runAntigravityMetadata, ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS,
  classifyAntigravityFileToolReason, ANTIGRAVITY_FILE_TOOL_NAMES,
  isAntigravityFileTool, summarizeAntigravityFileToolFailureReasons }
  from '../native-bridge/v2-readiness.mjs';

test('auth JSON excludes provider identities, keys and account details', () => {
  const secret = 'S3cr3t-DO-NOT-LEAK';
  const summary = summarizeV2AuthJson(JSON.stringify([{ provider: 'openai', token: secret, email: 'no@example.com' }]));
  assert.deepEqual(summary, { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 1 });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('example.com'), false);
  assert.deepEqual(summarizeV2AuthJson('[]'), { status: 'NO_SAVED_ACCOUNT_RECORDS', saved_account_count: 0 });
  assert.equal(summarizeV2AuthJson('not-json').status,'AUTH_JSON_UNREADABLE');
  assert.equal(summarizeV2AuthJson('{"provider":"a"}').status,'AUTH_JSON_SCHEMA_UNKNOWN');
});
test('auth metadata reports exact account count above the former 10000 cap', () => {
  const summary = summarizeV2AuthJson(JSON.stringify(Array(10001).fill(null)));
  assert.deepEqual(summary, { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 10001 });
});
test('provider auth treats an empty supported list as known absence, not unknown metadata', () => {
  for (const raw of ['[]', '{}', '{"accounts":[]}', '{"integrations":[]}'])
    assert.deepEqual(summarizeV2AuthProviderJson(raw, 'opencode'),
      { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"opencode"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_RECORD_PRESENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"openai"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"token":"PRIVATE"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' });
  for (const raw of ['null', '"text"', '{"other":[]}'])
    assert.deepEqual(summarizeV2AuthProviderJson(raw, 'opencode'),
      { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' });
});
test('provider auth command classifies an empty object without exposing command data', () => {
  let invocation;
  const result = readV2ProviderAuth('C:\\bin\\opencode.exe', 'opencode', 'C:\\workspace',
    (_bin, args) => { invocation = args; return '{}'; }, {});
  assert.deepEqual(invocation, ['auth', 'list', '--format', 'json']);
  assert.deepEqual(result, { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.equal(JSON.stringify(result).includes('token'), false);
});
test('model catalog reports count/hash only; not available-to-use or actually free', () => {
  const summary = summarizeV2Models('opencode/muse-spark-1.3-free\r\nopenrouter/anthropic/a\nnot a model\nopencode/muse-spark-1.3-free\n');
  assert.equal(summary.catalog_count,2);
  assert.equal(summary.candidate_free_name_count,1);
  assert.match(summary.catalog_sha256,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(summary).includes('muse-spark'));
  assert.equal(summarizeV2Models('unparseable').status,'CATALOG_IDS_UNRECOGNIZED');
  assert.equal(summarizeV2Models('x'.repeat(1024*1024+2)).status, 'MODEL_LIST_OVERSIZED_OR_INVALID');
});
test('bounded official V2 metadata commands invoke no model, login, shell or mutation', () => {
  const calls=[];
  const env={ USERPROFILE:'C:\\Users\\x', OPENCODE_CONFIG_CONTENT:'UNTRUSTED' };
  const run=(bin,args,opts)=>{
    calls.push({bin,args,opts});
    if(args[0]==='auth')return '[{"provider":"openai","token":"HIDDEN"}]';
    if(args[0]==='models')return 'opencode/spark-free\n';
    throw Error('Unexpected command');
  };
  const result=runV2Readiness('C:\\bin\\opencode.exe','C:\\state',run,env);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>c.args),[['auth','list','--format','json'],['models']]);
  assert.equal(calls[0].opts.timeout,12000);
  assert.equal(calls[0].opts.env.OPENCODE_CONFIG_CONTENT,undefined);
  assert.equal(calls[0].opts.env.USERPROFILE,env.USERPROFILE);
  assert.equal(result.inference_executed,false);
  assert.equal(result.credential_values_collected,false);
  assert.ok(!JSON.stringify(result).includes('HIDDEN'));
});
test('non-JSON and command failures remain explicitly unknown, never auto-approved', () => {
  const r=runV2Readiness('/bin/opencode','/tmp',()=>{throw Error('FAIL')});
  assert.deepEqual(r.issues,['AUTH_LIST_COMMAND_FAILED','MODELS_COMMAND_FAILED']);
  assert.equal(r.auth.saved_account_count,null);
  assert.equal(r.models.catalog_count,null);
  assert.equal(r.inference_executed,false);
});


test('Antigravity metadata parser recognizes only the pinned model ID, not its display label', () => {
  const summary=summarizeAntigravityV2Models('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
  assert.equal(summary.status,'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT');
  assert.equal(summary.catalog_count,2);
  assert.equal(summary.pinned_model_cataloged,true);
  assert.match(summary.catalog_sha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(summary).includes('Flash (High)'),false);
});

const fixedNow = '2026-11-01T12:00:00Z';
const validAntigravityUsage = JSON.stringify({
  status: 'SUCCESS',
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              remaining_fraction: 0.95,
              reset_time: '2026-11-08T12:00:00Z',
            },
            {
              id: 'gemini-5h',
              remaining_fraction: 0.99,
              reset_time: '2026-11-01T17:00:00Z',
            },
          ],
        },
      ],
    },
  },
});

const testProjectId = 'b8fbf647-6c41-4932-9d0a-8a7af257a27a';

function writeAntigravityProject(profile, projectId, workspace, resources = null) {
  const projectDir = join(profile, '.gemini', 'config', 'projects');
  mkdirSync(projectDir, { recursive: true });
  const projectResources = resources ?? [{ folderUri: pathToFileURL(workspace).href }];
  const config = { id: projectId, projectResources: { resources: projectResources } };
  writeFileSync(join(projectDir, `${projectId}.json`), JSON.stringify(config));
}

test('Antigravity project binding accepts one registered workspace and its isolated descendants', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-project-binding-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-workspace-'));
  const otherWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-other-workspace-'));
  const candidateWorkspace = join(workspace, '.pty-native-executor', 'candidate-workspaces',
    '00000000-0000-4000-8000-000000000001');
  try {
    writeAntigravityProject(profile, testProjectId, workspace);
    assert.equal(readAntigravityProjectBinding(testProjectId, workspace, { USERPROFILE: profile }),
      'PROJECT_WORKSPACE_MATCHED');
    mkdirSync(candidateWorkspace, { recursive: true });
    assert.equal(readAntigravityProjectBinding(testProjectId, candidateWorkspace, { USERPROFILE: profile }),
      'PROJECT_WORKSPACE_MATCHED', 'an attempt workspace nested under the sole registered project stays in scope');
    writeAntigravityProject(profile, testProjectId, workspace,
      [{ gitFolder: { folderUri: pathToFileURL(workspace).href } }]);
    assert.equal(readAntigravityProjectBinding(testProjectId, workspace, { USERPROFILE: profile }),
      'PROJECT_WORKSPACE_MATCHED', 'legacy/native gitFolder resource records remain readable');
    assert.equal(readAntigravityProjectBinding(testProjectId, otherWorkspace, { USERPROFILE: profile }),
      'PROJECT_WORKSPACE_MISMATCH');
    assert.equal(readAntigravityProjectBinding('not-a-project-id', workspace, { USERPROFILE: profile }),
      'PROJECT_SCOPE_UNKNOWN');
    writeAntigravityProject(profile, testProjectId, workspace, [
      { gitFolder: { folderUri: pathToFileURL(workspace).href } },
      { gitFolder: { folderUri: pathToFileURL(otherWorkspace).href } },
    ]);
    assert.equal(readAntigravityProjectBinding(testProjectId, workspace, { USERPROFILE: profile }),
      'PROJECT_WORKSPACE_MISMATCH', 'a project spanning multiple workspaces is not an isolated W2 scope');
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
  }
});

test('Antigravity project discovery uses one native workspace root and fails closed outside it', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-project-discovery-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-discovery-workspace-'));
  const otherWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-discovery-other-'));
  const staleWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-discovery-stale-'));
  const env = { USERPROFILE: profile };
  const attemptWorkspace = join(workspace, '.pty-native-executor', 'candidate-workspaces',
    '00000000-0000-4000-8000-000000000001');
  const matchingId = 'b8fbf647-6c41-4932-9d0a-8a7af257a27a';
  const otherId = 'c8fbf647-6c41-4932-9d0a-8a7af257a27a';
  const secondMatchingId = 'd8fbf647-6c41-4932-9d0a-8a7af257a27a';
  try {
    writeAntigravityProject(profile, matchingId, workspace);
    writeAntigravityProject(profile, otherId, otherWorkspace);
    writeAntigravityProject(profile, 'a8fbf647-6c41-4932-9d0a-8a7af257a27a', staleWorkspace);
    rmSync(staleWorkspace, { recursive: true, force: true });
    const unique = resolveAntigravityProjectId(workspace, env);
    assert.deepEqual(unique, { projectId: matchingId, projectScopeEvidence: 'PROJECT_WORKSPACE_MATCHED' });
    mkdirSync(attemptWorkspace, { recursive: true });
    assert.deepEqual(resolveAntigravityProjectId(attemptWorkspace, env),
      { projectId: matchingId, projectScopeEvidence: 'PROJECT_WORKSPACE_MATCHED' },
      'a disposable nested attempt resolves to its sole registered project');
    rmSync(join(profile, '.gemini', 'config', 'projects', `${matchingId}.json`));
    assert.deepEqual(resolveAntigravityProjectId(workspace, env),
      { projectId: null, projectScopeEvidence: 'PROJECT_WORKSPACE_MISMATCH' });
    writeAntigravityProject(profile, matchingId, workspace);
    assert.deepEqual(resolveAntigravityProjectId(workspace, env, 'not-a-uuid'),
      { projectId: null, projectScopeEvidence: 'PROJECT_SCOPE_UNKNOWN' },
      'an invalid explicit ID must not fall back to a discovered one');
    assert.deepEqual(resolveAntigravityProjectId(workspace, env, otherId),
      { projectId: null, projectScopeEvidence: 'PROJECT_WORKSPACE_MISMATCH' },
      'a valid but mismatched explicit ID must not fall back');

    writeAntigravityProject(profile, secondMatchingId, workspace);
    assert.deepEqual(resolveAntigravityProjectId(workspace, env),
      { projectId: null, projectScopeEvidence: 'PROJECT_WORKSPACE_AMBIGUOUS' });
    rmSync(join(profile, '.gemini', 'config', 'projects', `${secondMatchingId}.json`));

    writeFileSync(join(profile, '.gemini', 'config', 'projects',
      'e8fbf647-6c41-4932-9d0a-8a7af257a27a.json'), '{malformed');
    assert.deepEqual(resolveAntigravityProjectId(workspace, env),
      { projectId: null, projectScopeEvidence: 'PROJECT_SCOPE_UNKNOWN' });
    rmSync(join(profile, '.gemini', 'config', 'projects',
      'e8fbf647-6c41-4932-9d0a-8a7af257a27a.json'));
    const directoryCandidate = join(profile, '.gemini', 'config', 'projects',
      'f8fbf647-6c41-4932-9d0a-8a7af257a27a.json');
    mkdirSync(directoryCandidate);
    assert.deepEqual(resolveAntigravityProjectId(workspace, env),
      { projectId: null, projectScopeEvidence: 'PROJECT_SCOPE_UNKNOWN' },
      'a non-file UUID candidate cannot be trusted as project configuration');
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
    rmSync(staleWorkspace, { recursive: true, force: true });
  }
});

test('Antigravity project discovery rejects symlinked project records', t => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-project-symlink-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-symlink-workspace-'));
  const projectDir = join(profile, '.gemini', 'config', 'projects');
  const external = join(profile, 'external-project.json');
  const link = join(projectDir, 'f8fbf647-6c41-4932-9d0a-8a7af257a27a.json');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(external, JSON.stringify({ id: 'f8fbf647-6c41-4932-9d0a-8a7af257a27a',
    projectResources: { resources: [{ folderUri: pathToFileURL(workspace).href }] } }));
  try {
    try { symlinkSync(external, link, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`Windows symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.deepEqual(resolveAntigravityProjectId(workspace, { USERPROFILE: profile }),
      { projectId: null, projectScopeEvidence: 'PROJECT_SCOPE_UNKNOWN' });
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Antigravity project resolver rejects Windows junctions used as projects directory', t => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-project-junction-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-junction-workspace-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'pty-agy-junction-external-'));
  const configDir = join(profile, '.gemini', 'config');
  const projectsDir = join(configDir, 'projects');
  const theId = testProjectId;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(externalDir, `${theId}.json`), JSON.stringify({
    id: theId,
    projectResources: { resources: [{ folderUri: pathToFileURL(workspace).href }] },
  }));
  try {
    try {
      symlinkSync(externalDir, projectsDir, 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`Windows junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.deepEqual(resolveAntigravityProjectId(workspace, { USERPROFILE: profile }),
      { projectId: null, projectScopeEvidence: 'PROJECT_SCOPE_UNKNOWN' });
    assert.equal(readAntigravityProjectBinding(theId, workspace, { USERPROFILE: profile }),
      'PROJECT_SCOPE_UNKNOWN');
  } finally {
    try { rmSync(projectsDir, { force: true, recursive: false }); } catch {}
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test('Antigravity W2 readiness uses documented CLI settings and never probes interactive slash commands', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-scoped-readiness-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-scoped-workspace-'));
  const calls = [];
  const help = '--project --add-dir --print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const projectScopedHelp = '--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const required = ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ useG1Credits: false,
    permissions: { deny: required } }));
  const runner = (_bin, args, options) => {
    calls.push({ args, options });
    const rest = args[0] === `--project=${testProjectId}` ? args.slice(1) : args;
    if (rest[0] === '--version') return '1.4.2';
    if (rest[0] === '--help')
      return args[0] === `--project=${testProjectId}` ? projectScopedHelp : help;
    if (rest.includes('--print=/config') || rest.includes('--print=/permissions'))
      throw new Error('Potentially model-invoking or interactive command must not run');
    if (rest[0] === 'models') return 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
    if (rest[0] === '--print' && rest[1] === '/usage') return validAntigravityUsage;
    throw new Error('Unexpected scoped metadata command');
  };
  try {
    writeAntigravityProject(profile, testProjectId, workspace, null, required);
    const result = runAntigravityV2Readiness(process.execPath, workspace, runner,
      { USERPROFILE: profile, PATH: 'clean', GITHUB_TOKEN: 'MUST_NOT_REACH_CLI' }, () => true, testProjectId);
    assert.equal(result.project_scope_evidence, 'PROJECT_WORKSPACE_MATCHED');
    assert.equal(result.effective_config_evidence, 'DOCUMENTED_CLI_SETTINGS_NO_G1_OVERRIDE');
    assert.equal(result.credit_fallback_setting, 'CREDIT_FALLBACK_DISABLED');
    assert.equal(result.tool_policy_evidence, 'W2_NONFILE_ACTIONS_DENIED');
    assert.equal(result.tool_policy_source, 'DOCUMENTED_GLOBAL_CLI_SETTINGS_JSON');
    assert.equal(result.authentication_evidence, 'AUTHENTICATED_QUOTA_READ');
    assert.equal(result.inference_executed, false);
    assert.equal(result.project_flag_supported, true,
      'global CLI help is authoritative even when project-scoped help omits global flags');
    assert.equal(antigravityV2ReadinessExecutionFailure(result, fixedNow), null);
    assert.deepEqual(calls.map(call => call.args), [
      [`--project=${testProjectId}`, '--version'],
      ['--help'],
      [`--project=${testProjectId}`, 'models'],
      [`--project=${testProjectId}`, '--print', '/usage', '--output-format', 'json'],
    ]);
    assert.ok(calls.every(call => call.options.windowsHide === true && call.options.shell === false));
    assert.ok(calls.every(call => call.options.env.GITHUB_TOKEN === undefined));
    assert.equal(calls.some(call => call.args.some(arg =>
      arg === '--print=/config' || arg === '--print=/permissions')), false);

    writeFileSync(settingsPath, JSON.stringify({ useG1Credits: true,
      permissions: { deny: required } }));
    calls.length = 0;
    const g1Enabled = runAntigravityV2Readiness(process.execPath, workspace, runner,
      { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId);
    assert.equal(g1Enabled.credit_fallback_setting, 'CREDIT_FALLBACK_ENABLED');
    assert.equal(g1Enabled.effective_config_evidence, 'EFFECTIVE_CONFIG_UNKNOWN');
    assert.ok(g1Enabled.issues.includes('ANTIGRAVITY_EFFECTIVE_CONFIG_READBACK_UNAVAILABLE'));
    assert.equal(antigravityV2ReadinessExecutionFailure(g1Enabled),
      'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');

    // Project-file values are not substituted for the official global CLI
    // permission settings when the documented file is absent.
    rmSync(settingsPath);
    calls.length = 0;
    const missingGlobalPolicy = runAntigravityV2Readiness(process.execPath, workspace, runner,
      { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId);
    assert.equal(missingGlobalPolicy.credit_fallback_setting, 'CREDIT_FALLBACK_DISABLED_BY_DEFAULT');
    assert.equal(missingGlobalPolicy.effective_config_evidence, 'DOCUMENTED_CLI_SETTINGS_NO_G1_OVERRIDE');
    assert.equal(missingGlobalPolicy.tool_policy_evidence, 'W2_NONFILE_ACTION_DENY_INCOMPLETE');
    assert.equal(missingGlobalPolicy.tool_policy_source, 'DOCUMENTED_GLOBAL_CLI_SETTINGS_JSON');
    assert.ok(missingGlobalPolicy.issues.includes('ANTIGRAVITY_PROJECT_TOOL_POLICY_UNVERIFIED'));
    assert.equal(calls.some(call => call.args.some(arg =>
      arg === '--print=/config' || arg === '--print=/permissions')), false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Antigravity readiness binds the project ID to its registered root while querying from the isolated candidate cwd', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-candidate-readiness-profile-'));
  const registeredRoot = mkdtempSync(join(tmpdir(), 'pty-agy-registered-root-'));
  const candidateRoot = mkdtempSync(join(tmpdir(), 'pty-agy-isolated-candidate-'));
  const calls = [];
  const help = '--project --add-dir --print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const projectScopedHelp = '--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const required = ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ permissions: { deny: required } }));
  const runner = (_bin, args, options) => {
    calls.push({ args, cwd: options.cwd });
    const rest = args[0] === `--project=${testProjectId}` ? args.slice(1) : args;
    if (rest[0] === '--version') return '1.4.7';
    if (rest[0] === '--help') return args[0] === `--project=${testProjectId}` ? projectScopedHelp : help;
    if (rest[0] === 'models') return 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
    if (rest[0] === '--print' && rest[1] === '/usage') return validAntigravityUsage;
    throw new Error('Unexpected metadata command');
  };
  try {
    writeAntigravityProject(profile, testProjectId, registeredRoot);
    const result = runAntigravityV2Readiness(process.execPath, candidateRoot, runner,
      { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId, registeredRoot);
    assert.equal(result.project_scope_evidence, 'PROJECT_WORKSPACE_MATCHED');
    assert.equal(result.status, 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH');
    assert.equal(antigravityV2ReadinessExecutionFailure(result, fixedNow), null);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => call.cwd === candidateRoot),
      'metadata commands keep the exact isolated candidate as cwd after validating the registered project root');
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(registeredRoot, { recursive: true, force: true });
    rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test('Antigravity W2 does not query or execute a project with a mismatched workspace binding', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-mismatch-profile-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-mismatch-workspace-'));
  const otherWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-mismatch-other-'));
  let calls = 0;
  try {
    writeAntigravityProject(profile, testProjectId, otherWorkspace);
    const result = runAntigravityV2Readiness(process.execPath, workspace,
      () => { calls++; throw new Error('CLI_MUST_NOT_RUN_ON_SCOPE_MISMATCH'); },
      { USERPROFILE: profile }, () => true, testProjectId);
    assert.equal(result.status, 'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(result.project_scope_evidence, 'PROJECT_WORKSPACE_MISMATCH');
    assert.equal(result.inference_executed, 'UNKNOWN');
    assert.equal(antigravityV2ReadinessExecutionFailure(result), 'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(calls, 0);
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
  }
});

test('Antigravity credit-setting summary uses documented default and keeps cost unknown', () => {
  assert.equal(summarizeAntigravityCreditSetting('{"useG1Credits":false}'), 'CREDIT_FALLBACK_DISABLED');
  assert.equal(summarizeAntigravityCreditSetting('{"useG1Credits":true}'), 'CREDIT_FALLBACK_ENABLED');
  assert.equal(summarizeAntigravityCreditSetting('{"permissions":{}}'), 'CREDIT_FALLBACK_DISABLED_BY_DEFAULT');
  assert.equal(summarizeAntigravityCreditSetting('{"useG1Credits":"false"}'), 'SETTING_INVALID');
  assert.equal(summarizeAntigravityCreditSetting('{'), 'SETTINGS_JSON_INVALID');
  assert.equal(summarizeAntigravityCreditSetting('x'.repeat(64 * 1024 + 1)), 'SETTINGS_INVALID_OR_OVERSIZED');
});

test('Antigravity CLI policy requires Deny rules for commands, network, browser and MCP', () => {
  const required = ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
  assert.equal(summarizeAntigravityToolPolicy(JSON.stringify({ permissions: {
    deny: required, allow: [...required, 'write_file(src/)', 'read_file(src/)', 'command(git)'],
  } })), 'W2_NONFILE_ACTIONS_DENIED', 'Deny precedence defeats matching Allows');
  for (const omitted of required) assert.equal(summarizeAntigravityToolPolicy(JSON.stringify({
    permissions: { deny: required.filter(rule => rule !== omitted) },
  })), 'W2_NONFILE_ACTION_DENY_INCOMPLETE', `missing ${omitted} fails closed`);
  assert.equal(summarizeAntigravityToolPolicy(JSON.stringify({ permissions: {
    deny: [], allow: ['command(*)', 'execute_url(*)', 'mcp(*)'],
  } })), 'W2_NONFILE_ACTION_DENY_INCOMPLETE');
  assert.equal(summarizeAntigravityToolPolicy('{'), 'TOOL_POLICY_UNKNOWN');
});

test('Antigravity usage parser keeps only validated aggregate Gemini quota rows', () => {
  const envelope = {
    status: 'SUCCESS',
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', remaining_fraction: 0.95, reset_time: '2026-10-23T22:50:38Z' },
              { id: 'gemini-5h', remaining_fraction: 0.99, reset_time: '2026-10-18T05:46:39Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: 'claude-weekly', remaining_fraction: 1.0, reset_time: '2026-10-25T00:58:04Z' },
            ],
          },
        ],
      },
    },
  };
  const rawEnvelope = JSON.stringify(envelope);
  const result = summarizeAntigravityUsage(rawEnvelope);
  assert.deepEqual(result, { status: 'GEMINI_AGGREGATE_QUOTA_READ',
    source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
    weekly_reset_at: '2026-10-23T22:50:38.000Z', five_hour_remaining_percent: 99,
    five_hour_reset_at: '2026-10-18T05:46:39.000Z' });
  assert.equal(JSON.stringify(result).includes('Claude'), false);
  assert.equal(JSON.stringify(result).includes(rawEnvelope), false);
});

test('Antigravity usage parser fails closed on missing, malformed, duplicate, invalid or oversized rows', () => {
  const goodWeekly = 'Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-23T22:50:38Z';
  const goodFiveHour = 'Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T05:46:39Z';
  const unknown = () => ({ status: 'GEMINI_AGGREGATE_QUOTA_UNKNOWN', source: 'GEMINI_MODELS_AGGREGATE',
    weekly_remaining_percent: null, weekly_reset_at: null,
    five_hour_remaining_percent: null, five_hour_reset_at: null });
  for (const raw of [
    goodWeekly,
    `${goodWeekly}\nGemini Models\tFive Hour Remaining\t99%\t2026-10-18T05:46:39Z`,
    `${goodWeekly}\n${goodFiveHour}\nGemini Models\tWeekly Limit Remaining\tNaN%\t2026-10-23T22:50:38Z`,
    `${goodWeekly}\n${goodFiveHour}\n${goodWeekly}`,
    `${goodWeekly.replace('95%', '101%')}\n${goodFiveHour}`,
    `${goodWeekly.replace('95%', '-1%')}\n${goodFiveHour}`,
    `${goodWeekly.replace('2026-10-23T22:50:38Z', 'not-a-time')}\n${goodFiveHour}`,
    'x'.repeat(32 * 1024 + 1),
  ]) assert.deepEqual(summarizeAntigravityUsage(raw), unknown());
  assert.deepEqual(summarizeAntigravityUsage(null), unknown());
});

function makeCanonicalZeroInferenceEnvelope(overrides = {}) {
  return {
    status: 'SUCCESS',
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                remaining_fraction: 0.95,
                reset_time: '2026-11-08T12:00:00Z',
              },
              {
                id: 'gemini-5h',
                remaining_fraction: 0.99,
                reset_time: '2026-11-01T17:00:00Z',
              },
            ],
          },
        ],
      },
    },
    ...overrides,
  };
}

test('positive: inspectAntigravityZeroInferenceEnvelope and summarizeAntigravityUsage accept valid zero-inference envelope', () => {
  const env = makeCanonicalZeroInferenceEnvelope();
  const raw = JSON.stringify(env);
  const inspection = inspectAntigravityZeroInferenceEnvelope(raw);
  assert.equal(inspection.validZeroInference, true);
  assert.equal(inspection.positiveActivity, false);

  const quota = summarizeAntigravityUsage(raw);
  assert.equal(quota.status, 'GEMINI_AGGREGATE_QUOTA_READ');
  assert.equal(quota.weekly_remaining_percent, 95);
  assert.equal(quota.weekly_reset_at, '2026-11-08T12:00:00.000Z');
  assert.equal(quota.five_hour_remaining_percent, 99);
  assert.equal(quota.five_hour_reset_at, '2026-11-01T17:00:00.000Z');
});

test('positive: readiness probe establishes authenticated quota readiness from zero-turn all-zero-counter envelope', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-pos-zero-probe-'));
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    useG1Credits: false,
    permissions: { deny: ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
  }));
  const help = '--project --add-dir --print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const raw = JSON.stringify(makeCanonicalZeroInferenceEnvelope());
  const runner = (_bin, args) => {
    const rest = args[0] === `--project=${testProjectId}` ? args.slice(1) : args;
    if (rest[0] === '--version') return '1.4.2';
    if (rest[0] === '--help') return help;
    if (rest[0] === 'models') return 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
    if (rest[0] === '--print' && rest[1] === '/usage') return raw;
    throw new Error('Unexpected command');
  };
  try {
    writeAntigravityProject(profile, testProjectId, process.cwd());
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId);
    assert.equal(result.status, 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH');
    assert.equal(result.inference_executed, false);
    assert.equal(result.authentication_checked, true);
    assert.equal(result.authentication_evidence, 'AUTHENTICATED_QUOTA_READ');
    assert.equal(result.gemini_aggregate_quota.status, 'GEMINI_AGGREGATE_QUOTA_READ');
    assert.equal(antigravityV2ReadinessExecutionFailure(result, fixedNow), null);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('negative: rejects missing usage counters or missing usage object', () => {
  const counters = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
  for (const missingCounter of counters) {
    const env = makeCanonicalZeroInferenceEnvelope();
    delete env.usage[missingCounter];
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }

  for (const missingUsage of [undefined, null]) {
    const env = makeCanonicalZeroInferenceEnvelope();
    if (missingUsage === undefined) delete env.usage;
    else env.usage = null;
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }
});

test('negative: rejects nonzero usage counters and reports positive inference activity', () => {
  const counters = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
  for (const counter of counters) {
    for (const val of [1, 5, 100]) {
      const env = makeCanonicalZeroInferenceEnvelope();
      env.usage[counter] = val;
      const raw = JSON.stringify(env);
      const inspection = inspectAntigravityZeroInferenceEnvelope(raw);
      assert.equal(inspection.validZeroInference, false, `counter ${counter}=${val} must not be zero-inference`);
      assert.equal(inspection.positiveActivity, true, `counter ${counter}=${val} must be positive activity`);
      assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
    }
  }
});

test('negative: rejects positive turn counts and reports positive inference activity', () => {
  for (const turns of [1, 2, 5, 10]) {
    const env = makeCanonicalZeroInferenceEnvelope({ num_turns: turns });
    const raw = JSON.stringify(env);
    const inspection = inspectAntigravityZeroInferenceEnvelope(raw);
    assert.equal(inspection.validZeroInference, false, `turns=${turns} must not be zero-inference`);
    assert.equal(inspection.positiveActivity, true, `turns=${turns} must be positive activity`);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }
});

test('negative: rejects wrong command names or missing command object', () => {
  for (const wrongCommand of ['credits', '/usage', 'help', '', 'USAGE', 'Usage']) {
    const env = makeCanonicalZeroInferenceEnvelope();
    env.command.name = wrongCommand;
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }

  for (const badCmd of [null, undefined, {}, []]) {
    const env = makeCanonicalZeroInferenceEnvelope({ command: badCmd });
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }
});

test('negative: rejects failed outer status, error envelopes, and command errors', () => {
  for (const badStatus of ['ERROR', 'FAILED', 'UNKNOWN', '', 'success', 'Success', null, undefined]) {
    const env = makeCanonicalZeroInferenceEnvelope({ status: badStatus });
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }

  const envWithFalseSuccess = makeCanonicalZeroInferenceEnvelope({ success: false });
  assert.equal(inspectAntigravityZeroInferenceEnvelope(JSON.stringify(envWithFalseSuccess)).validZeroInference, false)
  assert.equal(summarizeAntigravityUsage(JSON.stringify(envWithFalseSuccess)).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  const envWithError = makeCanonicalZeroInferenceEnvelope({ error: { code: 'FAIL' } });
  assert.equal(inspectAntigravityZeroInferenceEnvelope(JSON.stringify(envWithError)).validZeroInference, false);
  assert.equal(summarizeAntigravityUsage(JSON.stringify(envWithError)).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');

  const envWithCmdError = makeCanonicalZeroInferenceEnvelope();
  envWithCmdError.command.error = 'DENIED';
  assert.equal(inspectAntigravityZeroInferenceEnvelope(JSON.stringify(envWithCmdError)).validZeroInference, false);
  assert.equal(summarizeAntigravityUsage(JSON.stringify(envWithCmdError)).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');

  const envWithCmdStatusFail = makeCanonicalZeroInferenceEnvelope();
  envWithCmdStatusFail.command.status = 'ERROR';
  assert.equal(inspectAntigravityZeroInferenceEnvelope(JSON.stringify(envWithCmdStatusFail)).validZeroInference, false);
  assert.equal(summarizeAntigravityUsage(JSON.stringify(envWithCmdStatusFail)).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
});

test('negative: rejects malformed types, non-finite values, and negative values', () => {
  const malformedTurns = ['0', true, false, null, undefined, -1, -5, NaN, Infinity, -Infinity, {}, []];
  for (const badTurn of malformedTurns) {
    const env = makeCanonicalZeroInferenceEnvelope({ num_turns: badTurn });
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false,
      `num_turns=${String(badTurn)} must fail`);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }

  const malformedCounters = ['0', true, false, null, undefined, -1, -10, NaN, Infinity, -Infinity, {}, []];
  const counters = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
  for (const counter of counters) {
    for (const badVal of malformedCounters) {
      const env = makeCanonicalZeroInferenceEnvelope();
      env.usage[counter] = badVal;
      const raw = JSON.stringify(env);
      assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false,
        `${counter}=${String(badVal)} must fail`);
      assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
    }
  }

  for (const badUsage of ['none', 123, true, [], [0, 0, 0, 0, 0]]) {
    const env = makeCanonicalZeroInferenceEnvelope({ usage: badUsage });
    const raw = JSON.stringify(env);
    assert.equal(inspectAntigravityZeroInferenceEnvelope(raw).validZeroInference, false);
    assert.equal(summarizeAntigravityUsage(raw).status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  }
});

test('negative: readiness gate refuses every invalid/unknown case and leaks no credentials or account IDs', () => {
  const secretKey = 'CRITICAL-SECRETS-API-KEY-VALUE-DO-NOT-LEAK';
  const privateAccount = 'account-user-id-987654321';
  const privateEmail = 'secret-agent@internal.domain';

  const testCases = [
    { label: 'missing input_tokens', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.usage.input_tokens; return e; } },
    { label: 'missing output_tokens', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.usage.output_tokens; return e; } },
    { label: 'missing thinking_tokens', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.usage.thinking_tokens; return e; } },
    { label: 'missing cache_read_tokens', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.usage.cache_read_tokens; return e; } },
    { label: 'missing total_tokens', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.usage.total_tokens; return e; } },
    { label: 'missing usage object', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.usage; return e; } },
    { label: 'nonzero input_tokens', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10 } }), expectedInference: true },
    { label: 'nonzero output_tokens', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: 0, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 5 } }), expectedInference: true },
    { label: 'nonzero thinking_tokens', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 20, cache_read_tokens: 0, total_tokens: 20 } }), expectedInference: true },
    { label: 'nonzero cache_read_tokens', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 15, total_tokens: 15 } }), expectedInference: true },
    { label: 'nonzero total_tokens', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 50 } }), expectedInference: true },
    { label: 'positive turn count 1', env: () => makeCanonicalZeroInferenceEnvelope({ num_turns: 1 }), expectedInference: true },
    { label: 'positive turn count 5', env: () => makeCanonicalZeroInferenceEnvelope({ num_turns: 5 }), expectedInference: true },
    { label: 'wrong command credits', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); e.command.name = 'credits'; return e; } },
    { label: 'wrong command /usage', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); e.command.name = '/usage'; return e; } },
    { label: 'failed status ERROR', env: () => makeCanonicalZeroInferenceEnvelope({ status: 'ERROR' }) },
    { label: 'failed status FAILED', env: () => makeCanonicalZeroInferenceEnvelope({ status: 'FAILED' }) },
    { label: 'missing status', env: () => { const e = makeCanonicalZeroInferenceEnvelope(); delete e.status; return e; } },
    { label: 'string turn count', env: () => makeCanonicalZeroInferenceEnvelope({ num_turns: '0' }) },
    { label: 'boolean turn count', env: () => makeCanonicalZeroInferenceEnvelope({ num_turns: false }) },
    { label: 'negative turn count', env: () => makeCanonicalZeroInferenceEnvelope({ num_turns: -1 }) },
    { label: 'string token counter', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: '0', output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } }) },
    { label: 'negative token counter', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: -5, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } }) },
    { label: 'non-finite NaN counter', env: () => makeCanonicalZeroInferenceEnvelope({ usage: { input_tokens: NaN, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } }) },
    { label: 'quota-shaped raw text table', rawPayload: 'Gemini Models\tWeekly Limit Remaining\t95%\t2026-11-08T12:00:00Z\nGemini Models\tFive Hour Limit Remaining\t99%\t2026-11-01T17:00:00Z\n' },
    { label: 'payload containing secrets', env: () => ({ ...makeCanonicalZeroInferenceEnvelope({ num_turns: 1 }), secret_key: secretKey, account_id: privateAccount, email: privateEmail }), expectedInference: true },
  ];

  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-neg-refusal-'));
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    useG1Credits: false,
    permissions: { deny: ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
  }));
  const help = '--project --add-dir --print --output-format stream-json --model --effort --sandbox --mode accept-edits';

  try {
    writeAntigravityProject(profile, testProjectId, process.cwd());
    for (const tc of testCases) {
      const payload = tc.rawPayload ?? JSON.stringify(tc.env());
      const runner = (_bin, args) => {
        const rest = args[0] === `--project=${testProjectId}` ? args.slice(1) : args;
        if (rest[0] === '--version') return '1.4.2';
        if (rest[0] === '--help') return help;
        if (rest[0] === 'models') return 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
        if (rest[0] === '--print' && rest[1] === '/usage') return payload;
        throw new Error('Unexpected command');
      };
      const inspected = inspectAntigravityZeroInferenceEnvelope(payload);
      const inspectedJson = JSON.stringify(inspected);
      assert.equal(inspectedJson.includes(secretKey), false, `${tc.label} inspection must not leak secretKey`);
      assert.equal(inspectedJson.includes(privateAccount), false, `${tc.label} inspection must not leak privateAccount`);
      assert.equal(inspectedJson.includes(privateEmail), false, `${tc.label} inspection must not leak privateEmail`);

      const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
        { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId);

      assert.equal(result.authentication_checked, false, `${tc.label} must not verify auth`);
      assert.notEqual(result.authentication_evidence, 'AUTHENTICATED_QUOTA_READ', `${tc.label} must not have AUTHENTICATED_QUOTA_READ`);
      assert.notEqual(result.status, 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH', `${tc.label} must not qualify status`);

      if (tc.expectedInference === true) {
        assert.equal(result.inference_executed, true, `${tc.label} must report positive inference as true`);
      } else {
        assert.equal(result.inference_executed, 'UNKNOWN', `${tc.label} must report insufficient evidence as UNKNOWN`);
      }

      const failure = antigravityV2ReadinessExecutionFailure(result, fixedNow);
      assert.notEqual(failure, null, `${tc.label} execution gate must refuse`);
      assert.equal(failure, 'ANTIGRAVITY_CLI_NOT_QUALIFIED', `${tc.label} must fail with safe code`);

      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(secretKey), false, `${tc.label} must not leak secretKey`);
      assert.equal(serialized.includes(privateAccount), false, `${tc.label} must not leak privateAccount`);
      assert.equal(serialized.includes(privateEmail), false, `${tc.label} must not leak privateEmail`);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Antigravity metadata readiness requires explicit no-G1 setting and leaves auth to the Worker gate', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    project_scope_evidence: 'PROJECT_WORKSPACE_MATCHED',
    effective_config_evidence: 'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: true,
    authentication_evidence: 'AUTHENTICATED_QUOTA_READ', tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    inference_executed: false, credential_values_collected: false,
    model_catalog: { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true,
      catalog_count: 2, catalog_sha256: createHash('sha256').update('gemini-3.8-flash-high').digest('hex') },
    entitlement: 'UNKNOWN', cost: 'UNKNOWN',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      weekly_reset_at: '2026-11-08T12:00:00Z', five_hour_remaining_percent: 99, five_hour_reset_at: '2026-11-01T17:00:00Z' } };
  assert.equal(antigravityV2ReadinessExecutionFailure(ready, fixedNow), null);
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'CREDIT_FALLBACK_DISABLED_BY_DEFAULT'}, fixedNow),
  null);
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'CREDIT_FALLBACK_ENABLED'}),
  'ANTIGRAVITY_CREDIT_OVERAGE_NOT_DISABLED');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'SETTINGS_READ_ERROR'}),
  'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready, authentication_evidence:'LOGIN_REQUIRED'}),
    'ANTIGRAVITY_AUTH_NOT_LOGGED_IN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready, authentication_checked:false,
    authentication_evidence:'AUTHENTICATED_QUOTA_READ'}), 'ANTIGRAVITY_CLI_AUTH_NOT_VERIFIED');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    tool_policy_evidence:'W2_NONFILE_ACTION_DENY_INCOMPLETE'}), 'ANTIGRAVITY_NONFILE_TOOL_POLICY_UNVERIFIED');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'CREDIT_FALLBACK_DISABLED_BY_DEFAULT', authentication_evidence:'LOGIN_REQUIRED',
    issues:['ANTIGRAVITY_AUTH_NOT_LOGGED_IN']}), 'ANTIGRAVITY_AUTH_NOT_LOGGED_IN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    gemini_aggregate_quota:{...ready.gemini_aggregate_quota,five_hour_remaining_percent:0}}),
  'ANTIGRAVITY_QUOTA_EMPTY');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    gemini_aggregate_quota:{...ready.gemini_aggregate_quota,weekly_remaining_percent:null}}),
  'ANTIGRAVITY_AGGREGATE_QUOTA_UNKNOWN');
});

test('Antigravity execution failure rejects absent, malformed, mismatched, and false model_catalog', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    project_scope_evidence: 'PROJECT_WORKSPACE_MATCHED',
    effective_config_evidence: 'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: true,
    authentication_evidence: 'AUTHENTICATED_QUOTA_READ', tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    inference_executed: false, credential_values_collected: false,
    model_catalog: { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true,
      catalog_count: 2, catalog_sha256: createHash('sha256').update('gemini-3.8-flash-high').digest('hex') },
    entitlement: 'UNKNOWN', cost: 'UNKNOWN',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      weekly_reset_at: '2026-11-08T12:00:00Z', five_hour_remaining_percent: 99, five_hour_reset_at: '2026-11-01T17:00:00Z' } };

  assert.equal(antigravityV2ReadinessExecutionFailure(ready, fixedNow), null);

  // 1. Absent model_catalog
  assert.equal(antigravityV2ReadinessExecutionFailure({ ...ready, model_catalog: null }),
    'ANTIGRAVITY_CLI_NOT_QUALIFIED');
  assert.equal(antigravityV2ReadinessExecutionFailure({ ...ready, model_catalog: undefined }),
    'ANTIGRAVITY_CLI_NOT_QUALIFIED');
  const { model_catalog: _omittedCatalog, ...withoutCatalog } = ready;
  assert.equal(antigravityV2ReadinessExecutionFailure(withoutCatalog),
    'ANTIGRAVITY_CLI_NOT_QUALIFIED');

  // 2. Malformed model_catalog
  for (const malformed of [
    'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT',
    123,
    true,
    false,
    [],
    ['gemini-3.8-flash-high'],
    {},
    { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT' },
    { pinned_model_cataloged: true },
    { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true, catalog_count: -1 },
    { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true, catalog_count: 0 },
    { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true, catalog_count: '2' },
    { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true, catalog_sha256: 'invalid-sha' },
    { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true, catalog_sha256: 123 },
  ]) {
    assert.equal(antigravityV2ReadinessExecutionFailure({ ...ready, model_catalog: malformed }),
      'ANTIGRAVITY_CLI_NOT_QUALIFIED',
      `malformed model_catalog ${JSON.stringify(malformed)} must fail qualification`);
  }

  // 3. Mismatched status
  for (const mismatchedStatus of [
    'PINNED_MODEL_NOT_CATALOGED',
    'MODEL_LIST_UNAVAILABLE',
    'MODEL_CATALOG_UNRECOGNIZED',
    'MODEL_LIST_OVERSIZED_OR_INVALID',
    'PUBLIC_CATALOG_IDS_PARSED_NOT_USABLE_PROOF',
    'UNKNOWN_STATUS',
  ]) {
    assert.equal(antigravityV2ReadinessExecutionFailure({
      ...ready,
      model_catalog: { ...ready.model_catalog, status: mismatchedStatus },
    }), 'ANTIGRAVITY_CLI_NOT_QUALIFIED', `mismatched status ${mismatchedStatus} must fail qualification`);
  }

  // 4. False or non-boolean pinned_model_cataloged
  for (const invalidPinned of [false, 'true', 1, 0, null, undefined]) {
    assert.equal(antigravityV2ReadinessExecutionFailure({
      ...ready,
      model_catalog: { ...ready.model_catalog, pinned_model_cataloged: invalidPinned },
    }), 'ANTIGRAVITY_CLI_NOT_QUALIFIED', `non-true pinned_model_cataloged (${invalidPinned}) must fail qualification`);
  }
});

test('Antigravity execution failure requires inference_executed and credential_values_collected to be exactly false', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    project_scope_evidence: 'PROJECT_WORKSPACE_MATCHED',
    effective_config_evidence: 'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: true,
    authentication_evidence: 'AUTHENTICATED_QUOTA_READ', tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    inference_executed: false, credential_values_collected: false,
    model_catalog: { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true,
      catalog_count: 2, catalog_sha256: createHash('sha256').update('gemini-3.8-flash-high').digest('hex') },
    entitlement: 'UNKNOWN', cost: 'UNKNOWN',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      weekly_reset_at: '2026-11-08T12:00:00Z', five_hour_remaining_percent: 99, five_hour_reset_at: '2026-11-01T17:00:00Z' } };

  // Negative cases for inference_executed
  for (const nonFalse of [true, 'false', null, undefined, 0, 1, {}, []]) {
    assert.equal(antigravityV2ReadinessExecutionFailure({ ...ready, inference_executed: nonFalse }),
      'ANTIGRAVITY_CLI_NOT_QUALIFIED',
      `inference_executed: ${JSON.stringify(nonFalse)} must fail qualification`);
  }
  const { inference_executed: _omittedInference, ...withoutInference } = ready;
  assert.equal(antigravityV2ReadinessExecutionFailure(withoutInference),
    'ANTIGRAVITY_CLI_NOT_QUALIFIED', 'omitted inference_executed must fail qualification');

  // Negative cases for credential_values_collected
  for (const nonFalse of [true, 'false', null, undefined, 0, 1, {}, []]) {
    assert.equal(antigravityV2ReadinessExecutionFailure({ ...ready, credential_values_collected: nonFalse }),
      'ANTIGRAVITY_CLI_NOT_QUALIFIED',
      `credential_values_collected: ${JSON.stringify(nonFalse)} must fail qualification`);
  }
  const { credential_values_collected: _omittedCreds, ...withoutCreds } = ready;
  assert.equal(antigravityV2ReadinessExecutionFailure(withoutCreds),
    'ANTIGRAVITY_CLI_NOT_QUALIFIED', 'omitted credential_values_collected must fail qualification');

  // Both non-false
  assert.equal(antigravityV2ReadinessExecutionFailure({
    ...ready,
    inference_executed: true,
    credential_values_collected: true,
  }), 'ANTIGRAVITY_CLI_NOT_QUALIFIED');
});

test('Antigravity preflight keeps entitlement and cost UNKNOWN and leaks no raw details', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    project_scope_evidence: 'PROJECT_WORKSPACE_MATCHED',
    effective_config_evidence: 'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: true,
    authentication_evidence: 'AUTHENTICATED_QUOTA_READ', tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    inference_executed: false, credential_values_collected: false,
    model_catalog: { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true,
      catalog_count: 2, catalog_sha256: createHash('sha256').update('gemini-3.8-flash-high').digest('hex') },
    entitlement: 'UNKNOWN', cost: 'UNKNOWN',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      weekly_reset_at: '2026-11-08T12:00:00Z', five_hour_remaining_percent: 99, five_hour_reset_at: '2026-11-01T17:00:00Z' } };

  // Positive readback passes with no execution failure
  assert.equal(antigravityV2ReadinessExecutionFailure(ready, fixedNow), null);
  assert.equal(ready.entitlement, 'UNKNOWN');
  assert.equal(ready.cost, 'UNKNOWN');
  assert.equal(ready.inference_executed, false);
  assert.equal(ready.credential_values_collected, false);

  // Return value is strictly an existing safe reason code, never exposing internals
  const failureReason = antigravityV2ReadinessExecutionFailure({ ...ready, model_catalog: null });
  assert.equal(failureReason, 'ANTIGRAVITY_CLI_NOT_QUALIFIED');
  assert.equal(typeof failureReason, 'string');
  assert.ok(/^[A-Z0-9_]+$/.test(failureReason), 'failure reason must be an existing safe code format');
});

test('Antigravity execution failure requires fresh, canonical UTC quota reset windows strictly in the future', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    project_scope_evidence: 'PROJECT_WORKSPACE_MATCHED',
    effective_config_evidence: 'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: true,
    authentication_evidence: 'AUTHENTICATED_QUOTA_READ', tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    inference_executed: false, credential_values_collected: false,
    model_catalog: { status: 'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT', pinned_model_cataloged: true,
      catalog_count: 2, catalog_sha256: createHash('sha256').update('gemini-3.8-flash-high').digest('hex') },
    entitlement: 'UNKNOWN', cost: 'UNKNOWN',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      weekly_reset_at: '2026-11-08T12:00:00Z', five_hour_remaining_percent: 99,
      five_hour_reset_at: '2026-11-01T17:00:00Z' } };

  // 1. Positive coverage: both reset windows strictly in the future under fixedNow
  assert.equal(antigravityV2ReadinessExecutionFailure(ready, fixedNow), null);
  assert.equal(ready.entitlement, 'UNKNOWN');
  assert.equal(ready.cost, 'UNKNOWN');

  // Positive coverage: canonical millisecond timestamps (.000Z and arbitrary ms)
  const readyMs = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: '2026-11-08T12:00:00.000Z',
      five_hour_reset_at: '2026-11-01T17:00:00.123Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(readyMs, fixedNow), null);

  // Positive coverage: supported deterministic clock input forms
  assert.equal(antigravityV2ReadinessExecutionFailure(ready, new Date(fixedNow)), null);
  assert.equal(antigravityV2ReadinessExecutionFailure(ready, Date.parse(fixedNow)), null);

  // 2. Negative coverage: weekly reset in the past
  const pastWeekly = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: '2026-10-31T12:00:00Z',
      five_hour_reset_at: '2026-11-01T17:00:00Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(pastWeekly, fixedNow),
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  // 3. Negative coverage: five-hour reset in the past
  const pastFiveHour = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: '2026-11-08T12:00:00Z',
      five_hour_reset_at: '2026-11-01T11:59:59Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(pastFiveHour, fixedNow),
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  // Both resets in the past (reproduced October defect on 2026-11-01)
  const pastBoth = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: '2026-10-23T22:50:38Z',
      five_hour_reset_at: '2026-10-18T05:46:39Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(pastBoth, fixedNow),
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  // 4. Negative coverage: reset exactly equal to now (equality is expired)
  const equalWeekly = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: fixedNow,
      five_hour_reset_at: '2026-11-01T17:00:00Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(equalWeekly, fixedNow),
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  const equalFiveHour = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: '2026-11-08T12:00:00Z',
      five_hour_reset_at: fixedNow,
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(equalFiveHour, fixedNow),
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  const equalBoth = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_reset_at: fixedNow,
      five_hour_reset_at: fixedNow,
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(equalBoth, fixedNow),
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  // 5. Negative coverage: missing reset
  for (const missingWeekly of [null, undefined, '']) {
    const r = {
      ...ready,
      gemini_aggregate_quota: {
        ...ready.gemini_aggregate_quota,
        weekly_reset_at: missingWeekly,
        five_hour_reset_at: '2026-11-01T17:00:00Z',
      },
    };
    assert.equal(antigravityV2ReadinessExecutionFailure(r, fixedNow),
      'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');
  }

  for (const missingFiveHour of [null, undefined, '']) {
    const r = {
      ...ready,
      gemini_aggregate_quota: {
        ...ready.gemini_aggregate_quota,
        weekly_reset_at: '2026-11-08T12:00:00Z',
        five_hour_reset_at: missingFiveHour,
      },
    };
    assert.equal(antigravityV2ReadinessExecutionFailure(r, fixedNow),
      'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');
  }

  const { weekly_reset_at: _w, ...quotaWithoutWeekly } = ready.gemini_aggregate_quota;
  assert.equal(antigravityV2ReadinessExecutionFailure({
    ...ready, gemini_aggregate_quota: quotaWithoutWeekly,
  }, fixedNow), 'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');

  // 6. Negative coverage: malformed, impossible, or non-canonical timestamps
  for (const malformed of [
    '2026-02-30T12:00:00Z',
    '2026-04-31T12:00:00Z',
    '2026-13-01T12:00:00Z',
    '2026-11-01T24:00:00Z',
    '2026-11-01T12:60:00Z',
    '2026-11-08T12:00:00+00:00',
    '2026-11-08T07:00:00-05:00',
    '2026-11-08t12:00:00z',
    '2026-11-08T12:00:00z',
    '2026-11-08T12:00:00.1Z',
    '2026-11-08T12:00:00.12Z',
    '2026-11-08T12:00:00.1234Z',
    '2026/11/08T12:00:00Z',
    'not-a-timestamp',
    1762516800000,
    true,
    {},
    [],
  ]) {
    const badWeekly = {
      ...ready,
      gemini_aggregate_quota: {
        ...ready.gemini_aggregate_quota,
        weekly_reset_at: malformed,
        five_hour_reset_at: '2026-11-01T17:00:00Z',
      },
    };
    assert.equal(antigravityV2ReadinessExecutionFailure(badWeekly, fixedNow),
      'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID',
      `malformed weekly timestamp ${JSON.stringify(malformed)} must fail closed`);

    const badFiveHour = {
      ...ready,
      gemini_aggregate_quota: {
        ...ready.gemini_aggregate_quota,
        weekly_reset_at: '2026-11-08T12:00:00Z',
        five_hour_reset_at: malformed,
      },
    };
    assert.equal(antigravityV2ReadinessExecutionFailure(badFiveHour, fixedNow),
      'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID',
      `malformed five-hour timestamp ${JSON.stringify(malformed)} must fail closed`);
  }

  // 7. Negative coverage: invalid clock inputs fail closed
  for (const badClock of [
    'invalid-clock-string',
    '2026-13-40T99:99:99Z',
    '2026-02-30T12:00:00Z',
    '2026-11-01T12:00:00',
    '2026-11-01T12:00:00+00:00',
    '1',
    null,
    NaN,
    0,
    -1,
    -1000,
    Infinity,
    -Infinity,
    false,
    true,
    {},
    [],
    new Date('invalid-date'),
  ]) {
    assert.equal(antigravityV2ReadinessExecutionFailure(ready, badClock),
      'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID',
      `invalid clock input ${String(badClock)} must fail closed`);
  }

  // 8. Gate precedence: empty quota and unknown quota take precedence over freshness
  const emptyWithExpired = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_remaining_percent: 0,
      weekly_reset_at: '2026-10-23T22:50:38Z',
      five_hour_reset_at: '2026-10-18T05:46:39Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(emptyWithExpired, fixedNow),
    'ANTIGRAVITY_QUOTA_EMPTY');

  const emptyFiveHourWithExpired = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      five_hour_remaining_percent: 0,
      weekly_reset_at: '2026-10-23T22:50:38Z',
      five_hour_reset_at: '2026-10-18T05:46:39Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(emptyFiveHourWithExpired, fixedNow),
    'ANTIGRAVITY_QUOTA_EMPTY');

  const unknownQuotaWithExpired = {
    ...ready,
    gemini_aggregate_quota: {
      ...ready.gemini_aggregate_quota,
      weekly_remaining_percent: null,
      weekly_reset_at: '2026-10-23T22:50:38Z',
      five_hour_reset_at: '2026-10-18T05:46:39Z',
    },
  };
  assert.equal(antigravityV2ReadinessExecutionFailure(unknownQuotaWithExpired, fixedNow),
    'ANTIGRAVITY_AGGREGATE_QUOTA_UNKNOWN');
});

test('Antigravity readiness fails qualification when pinned model is absent from model catalog', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-missing-model-'));
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    useG1Credits: false,
    permissions: { deny: ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
  }));
  const help = '--project --add-dir --print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner = (_bin, args) => {
    const rest = args[0] === `--project=${testProjectId}` ? args.slice(1) : args;
    if (rest[0] === '--version') return '1.4.2';
    if (rest[0] === '--help') return help;
    if (rest[0] === 'models') return 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n';
    if (rest[0] === '--print' && rest[1] === '/usage') return validAntigravityUsage;
    throw new Error('Unexpected command');
  };
  try {
    writeAntigravityProject(profile, testProjectId, process.cwd());
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId);
    assert.equal(result.model_catalog.status, 'PINNED_MODEL_NOT_CATALOGED');
    assert.equal(result.model_catalog.pinned_model_cataloged, false);
    assert.equal(result.inference_executed, false);
    assert.equal(result.credential_values_collected, false);
    assert.equal(result.entitlement, 'UNKNOWN');
    assert.equal(result.cost, 'UNKNOWN');
    assert.equal(antigravityV2ReadinessExecutionFailure(result), 'ANTIGRAVITY_CLI_NOT_QUALIFIED');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Antigravity readiness reads only the bounded credit flag and keeps cost UNKNOWN', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-settings-'));
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  const secret = 'DO-NOT-LEAK-API-KEY';
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ useG1Credits: false, apiKey: secret,
    permissions: { deny: ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'],
      allow: ['command(git)', 'write_file(src/)', 'read_file(src/)'] } }));
  const help = '--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner = (_bin, args) => args[0] === '--version' ? '1.4.1' :
    args[0] === '--help' ? help : args[0] === 'models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' :
      args[0] === '--print' ? validAntigravityUsage :
      (() => { throw new Error('Unexpected command'); })();
  try {
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile }, () => true);
    assert.equal(result.credit_fallback_setting, 'CREDIT_FALLBACK_DISABLED');
    assert.equal(result.tool_policy_evidence, 'W2_NONFILE_ACTIONS_DENIED');
    assert.equal(antigravityV2ReadinessExecutionFailure(result), 'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(result.cost, 'UNKNOWN');
    assert.equal(result.entitlement, 'UNKNOWN');
    assert.equal(result.inference_executed, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(profile), false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Antigravity absent settings file applies documented no-G1 default but keeps tools and auth unverified', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-default-settings-'));
  const help = '--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner = (_bin, args) => args[0] === '--version' ? '1.4.1' :
    args[0] === '--help' ? help : args[0] === 'models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' :
      args[0] === '--print' ? validAntigravityUsage :
      (() => { throw new Error('Unexpected command'); })();
  try {
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile }, () => true);
    assert.equal(result.credit_fallback_setting, 'CREDIT_FALLBACK_DISABLED_BY_DEFAULT');
    assert.equal(result.tool_policy_evidence, 'W2_NONFILE_ACTION_DENY_INCOMPLETE');
    assert.equal(antigravityV2ReadinessExecutionFailure(result), 'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(antigravityV2ReadinessExecutionFailure({...result, authentication_checked:true,
      authentication_evidence:'AUTHENTICATED_QUOTA_READ', tool_policy_evidence:'W2_NONFILE_ACTIONS_DENIED', issues:[]}),
    'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED', 'global settings cannot prove an isolated project scope');
    assert.equal(result.cost, 'UNKNOWN');
    assert.equal(result.entitlement, 'UNKNOWN');
    assert.equal(result.inference_executed, false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Antigravity missing USERPROFILE is not mistaken for an absent settings file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-agy-missing-profile-'));
  const profile = join(root, 'not-created');
  const help = '--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner = (_bin, args) => args[0] === '--version' ? '1.4.1' :
    args[0] === '--help' ? help : args[0] === 'models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' :
      args[0] === '--print' ? validAntigravityUsage :
      (() => { throw new Error('Unexpected command'); })();
  try {
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile }, () => true);
    assert.equal(result.credit_fallback_setting, 'PROFILE_UNAVAILABLE');
    assert.equal(result.tool_policy_evidence, 'TOOL_POLICY_UNKNOWN');
    assert.equal(antigravityV2ReadinessExecutionFailure(result), 'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Antigravity readiness qualifies the pinned model and CLI auth through no-inference metadata', () => {
  const profile=mkdtempSync(join(tmpdir(),'pty-agy-metadata-only-'));
  const settingsDir=join(profile,'.gemini','antigravity-cli');
  mkdirSync(settingsDir,{recursive:true});
  writeFileSync(join(settingsDir,'settings.json'),JSON.stringify({useG1Credits:false}));
  const calls=[];
  // Captured from the installed CLI; readiness must confirm the per-run mode override.
  const help=`Usage of agy.exe:
  --print Run a single prompt non-interactively
  --model Model for the current CLI session
  --effort Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --mode Execution mode (default|accept-edits|plan)
  --output-format Output format (text, json, stream-json)
  --input-format Input format (text, stream-json)
  --add-dir Add a directory to the workspace (repeatable)
  --sandbox Run with terminal sandbox restrictions enabled`;
  const models='Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
  const runner=(bin,args,options)=>{
    calls.push({bin,args,options});
    if(args[0]==='--version') return '1.4.1';
    if(args[0]==='--help') return { stdout:'', stderr:help };
    if(args[0]==='models') return { stdout:models, stderr:'' };
    if(args[0]==='--print') return { stdout:validAntigravityUsage, stderr:'' };
    throw new Error('Unexpected command');
  };
  try {
    const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,
      {PATH:'clean',USERPROFILE:profile,OPENCODE_API_KEY:'SECRET'},()=>true);
    assert.equal(r.status,'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH');
    assert.equal(r.version,'1.4.1');
    assert.equal(r.model,'gemini-3.8-flash-high');
    assert.equal(r.headless_print_supported,true);
    assert.equal(r.stream_json_supported,true);
    assert.equal(r.model_flag_supported,true);
    assert.equal(r.effort_flag_supported,true);
    assert.equal(r.add_dir_flag_supported,true);
    assert.equal(r.sandbox_flag_supported,true);
    assert.equal(r.mode_flag_supported,true);
    assert.equal(r.inference_executed,false);
    assert.equal(r.signature_verified,true);
    assert.equal(r.authentication_checked,true);
    assert.equal(r.authentication_evidence,'AUTHENTICATED_QUOTA_READ');
    assert.equal(r.issues.includes('ANTIGRAVITY_AUTH_STATUS_UNVERIFIED'),false);
    assert.equal(r.gemini_aggregate_quota.status,'GEMINI_AGGREGATE_QUOTA_READ');
    assert.equal(r.gemini_aggregate_quota.weekly_remaining_percent,95);
    assert.equal(r.gemini_aggregate_quota.five_hour_remaining_percent,99);
    assert.equal(r.entitlement,'UNKNOWN');
    assert.equal(r.cost,'UNKNOWN');
    assert.equal(r.write_scope,'UNKNOWN');
    assert.deepEqual(calls.map(c=>c.args),[['--version'],['--help'],['models'],
      ['--print','/usage','--output-format','json']]);
    assert.ok(calls.every(c=>c.options.shell===false && c.options.windowsHide===true));
    assert.ok(calls.slice(0,3).every(c=>c.options.timeout===12000));
    assert.equal(calls[3].options.timeout,15000);
    assert.equal(calls[3].options.maxBuffer,32*1024);
    assert.ok(calls.every(c=>c.options.env.AGY_CLI_DISABLE_AUTO_UPDATE==='true'));
    assert.ok(calls.every(c=>c.options.env.OPENCODE_API_KEY===undefined));
  } finally { rmSync(profile,{recursive:true,force:true}); }
});

test('Antigravity readiness preserves explicit login failure even when quota text is present', () => {
  const profile=mkdtempSync(join(tmpdir(),'pty-agy-login-required-'));
  const settingsDir=join(profile,'.gemini','antigravity-cli');
  mkdirSync(settingsDir,{recursive:true});
  writeFileSync(join(settingsDir,'settings.json'),JSON.stringify({useG1Credits:false}));
  const help='--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.2' : args[0]==='--help'
    ? help : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : {stdout:validAntigravityUsage,stderr:'You are not logged into Antigravity.'};
  try {
    const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{USERPROFILE:profile},()=>true);
    assert.equal(r.gemini_aggregate_quota.status,'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
    assert.equal(r.authentication_checked,false);
    assert.equal(r.authentication_evidence,'LOGIN_REQUIRED');
    assert.ok(r.issues.includes('ANTIGRAVITY_AUTH_NOT_LOGGED_IN'));
    assert.equal(antigravityV2ReadinessExecutionFailure(r),'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(r.inference_executed,'UNKNOWN');
  } finally { rmSync(profile,{recursive:true,force:true}); }
});

test('Antigravity metadata runner preserves only coarse auth evidence from a real nonzero child', () => {
  const privateMarker='private-marker@example.invalid';
  const script=`process.stderr.write('You are not logged into Antigravity: ${privateMarker}'); process.exit(7);`;
  let error;
  try {
    runAntigravityMetadata(process.execPath,['-e',script],{
      cwd:process.cwd(),env:process.env,windowsHide:true,timeout:5000,
      maxBuffer:32*1024,stdio:['ignore','pipe','pipe']});
  } catch (caught) { error=caught; }
  assert.ok(error instanceof Error);
  assert.equal(error.code,'ANTIGRAVITY_METADATA_COMMAND_FAILED');
  assert.equal(error.exitCode,7);
  assert.equal(error.authenticationEvidence,'LOGIN_REQUIRED');
  assert.equal(error.stdout,undefined);
  assert.equal(error.stderr,undefined);
  assert.equal(JSON.stringify(error).includes(privateMarker),false);
  assert.equal(`${error.message}\n${error.stack}`.includes(privateMarker),false);
});

test('Antigravity readiness classifies real nonzero auth output without exposing account details', () => {
  const privateMarker='private-marker@example.invalid';
  const script=`process.stderr.write('You are not logged into Antigravity: ${privateMarker}'); process.exit(7);`;
  const help='--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner=(bin,args,options)=>args[0]==='--version' ? '1.4.2' : args[0]==='--help'
    ? help : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : runAntigravityMetadata(process.execPath,['-e',script],options);
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,process.env,()=>true);
  assert.equal(r.authentication_evidence,'LOGIN_REQUIRED');
  assert.ok(r.issues.includes('ANTIGRAVITY_AUTH_NOT_LOGGED_IN'));
  assert.equal(r.issues.includes('ANTIGRAVITY_USAGE_COMMAND_FAILED'),false);
  assert.equal(r.inference_executed,'UNKNOWN');
  assert.equal(JSON.stringify(r).includes(privateMarker),false);
});

test('Antigravity readiness leaves non-auth usage exit failures unverified', () => {
  const script="process.stderr.write('temporary metadata failure'); process.exit(8);";
  const help='--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner=(_bin,args,options)=>args[0]==='--version' ? '1.4.2' : args[0]==='--help'
    ? help : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : runAntigravityMetadata(process.execPath,['-e',script],options);
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,process.env,()=>true);
  assert.equal(r.authentication_evidence,'UNVERIFIED');
  assert.ok(r.issues.includes('ANTIGRAVITY_USAGE_COMMAND_FAILED'));
  assert.equal(r.issues.includes('ANTIGRAVITY_AUTH_NOT_LOGGED_IN'),false);
  assert.equal(r.inference_executed,'UNKNOWN');
});

test('Antigravity nonzero usage exit cannot authenticate or read quota even with valid stdout', () => {
  const script=`process.stdout.write(${JSON.stringify(validAntigravityUsage)}); process.stderr.write('temporary metadata failure'); process.exit(8);`;
  const help='--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner=(_bin,args,options)=>args[0]==='--version' ? '1.4.2' : args[0]==='--help'
    ? help : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : runAntigravityMetadata(process.execPath,['-e',script],options);
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,process.env,()=>true);
  assert.equal(r.authentication_checked,false);
  assert.notEqual(r.authentication_evidence,'AUTHENTICATED_QUOTA_READ');
  assert.equal(r.authentication_evidence,'UNVERIFIED');
  assert.notEqual(r.gemini_aggregate_quota?.status,'GEMINI_AGGREGATE_QUOTA_READ');
  assert.equal(r.gemini_aggregate_quota?.status,'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
  assert.equal(r.gemini_aggregate_quota?.weekly_remaining_percent,null);
  assert.equal(r.gemini_aggregate_quota?.five_hour_remaining_percent,null);
  assert.ok(r.issues.includes('ANTIGRAVITY_USAGE_COMMAND_FAILED'));
  assert.equal(r.issues.includes('ANTIGRAVITY_AUTH_NOT_LOGGED_IN'),false);
  assert.equal(r.inference_executed,'UNKNOWN');
  assert.notEqual(antigravityV2ReadinessExecutionFailure(r),null);
});

test('Antigravity readiness requires add-dir but does not invent a model or effort option absent from real CLI help', () => {
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.1' : args[0]==='--help'
    ? '--print --output-format stream-json --sandbox'
    : 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{},()=>true);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.equal(r.model_flag_supported,false);
  assert.equal(r.effort_flag_supported,false);
  assert.equal(r.add_dir_flag_supported,false);
  assert.equal(r.mode_flag_supported,false);
  assert.ok(r.issues.includes('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED'));
  assert.equal(r.inference_executed,'UNKNOWN');
  assert.equal(r.authentication_checked,false);
  assert.equal(r.entitlement,'UNKNOWN');
  assert.equal(r.cost,'UNKNOWN');
});

test('Antigravity exact High model does not require the unrelated generic effort flag', () => {
  const profile=mkdtempSync(join(tmpdir(),'pty-agy-no-effort-'));
  const settingsDir=join(profile,'.gemini','antigravity-cli');
  mkdirSync(settingsDir,{recursive:true});
  writeFileSync(join(settingsDir,'settings.json'),JSON.stringify({useG1Credits:false}));
  const help='--print --output-format stream-json --model --add-dir --sandbox --mode accept-edits';
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.2' : args[0]==='--help'
    ? help : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : args[0]==='--print' ? validAntigravityUsage
        : (()=>{throw new Error('Unexpected command');})();
  try {
    const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,
      {USERPROFILE:profile},()=>true);
    assert.equal(r.model,'gemini-3.8-flash-high');
    assert.equal(r.effort_flag_supported,false);
    assert.equal(r.status,'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH');
    assert.equal(r.issues.includes('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED'),false);
    assert.equal(r.inference_executed,false);
  } finally { rmSync(profile,{recursive:true,force:true}); }
});

test('Antigravity readiness requires the advertised accept-edits mode, not only a generic --mode flag', () => {
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.1' : args[0]==='--help'
    ? '--print --output-format stream-json --model --effort --sandbox --mode (default|plan)'
    : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)' :
      'Gemini Models Weekly Limit Remaining 95% 2026-10-19T00:00:00Z\n' +
      'Gemini Models Five Hour Limit Remaining 98% 2026-10-18T12:00:00Z';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{},()=>true);
  assert.equal(r.mode_flag_supported,true);
  assert.equal(r.accept_edits_mode_supported,false);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.ok(r.issues.includes('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED'));
  assert.equal(r.inference_executed,'UNKNOWN');
});

test('Antigravity metadata commands never start before Google Authenticode verification', () => {
  let calls=0;
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),
    ()=>{calls++;return ''},{PATH:'clean'},()=>false);
  assert.equal(r.status,'ANTIGRAVITY_GOOGLE_SIGNATURE_NOT_VERIFIED');
  assert.equal(r.signature_verified,false);
  assert.equal(r.inference_executed,'UNKNOWN');
  assert.equal(calls,0);
});

test('Antigravity readiness rejects a relative executable without launching commands', () => {
  let calls=0;
  const r=runAntigravityV2Readiness('agy.exe','C:\\workspace',()=>{calls++;return ''});
  assert.equal(calls,0);
  assert.equal(r.status,'READINESS_UNKNOWN');
  assert.deepEqual(r.issues,['ABSOLUTE_EXECUTABLE_AND_CWD_REQUIRED']);
  assert.equal(r.inference_executed,'UNKNOWN');
});

test('Antigravity metadata failures stay UNKNOWN and do not expose command errors', () => {
  const secret='credential-shaped-provider-output';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),
    ()=>{throw new Error(secret)},{},()=>true);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.deepEqual(r.issues,['VERSION_COMMAND_FAILED','HELP_COMMAND_FAILED','MODELS_COMMAND_FAILED',
    'ANTIGRAVITY_USAGE_COMMAND_FAILED']);
  assert.equal(r.entitlement,'UNKNOWN');
  assert.equal(r.cost,'UNKNOWN');
  assert.equal(JSON.stringify(r).includes(secret),false);
});

test('Antigravity stream evidence binds one session, exact model and cwd without returning response bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-stream-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const cwd = 'C:\\Users\\worker\\candidate';
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'ACTIVE', step_type: 'agent_response', text_delta: 'working' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state: 'ACTIVE', step_type: 'tool', tool_name: 'replace_file_content' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state: 'DONE', step_type: 'tool', tool_name: 'replace_file_content',
      tool_info: { output: 'PRIVATE_TOOL_OUTPUT' } } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 2,
      state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 2,
      state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
      tool_info: { error: { code: 'COMMAND_DENIED', message: 'PRIVATE_COMMAND_ERROR' } } } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 3,
      state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'DONE', step_type: 'agent_response', text_delta: 'done' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 4,
      state: 'DONE', step_type: 'checkpoint', usage: { input_tokens: 7, output_tokens: 3,
        thinking_tokens: 2, cache_read_tokens: 11, total_tokens: 10 } } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS',
      response: 'PRIVATE_MODEL_RESPONSE', usage: { input_tokens: 100, output_tokens: 20,
        thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 120 } } },
  ];
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.equal(result.session_id, session);
    assert.equal(result.cli_status, 'SUCCESS');
    assert.equal(result.permission_mode_evidence, 'ACCEPT_EDITS_CONFIRMED');
    assert.equal(result.model_invoked, true);
    assert.equal(result.model_activity_evidence, 'OBSERVED');
    assert.equal(result.tool_execution_count, 3);
    assert.equal(result.tool_execution_failed_count, 1);
    assert.equal(result.tool_execution_incomplete_count, 1);
    assert.equal(result.forbidden_tool_execution_evidence, 'NOT_OBSERVED');
    assert.equal(result.file_change_tool_completed_count, 1);
    assert.equal(result.file_change_tool_incomplete_count, 0);
    assert.deepEqual(result.token_usage, { input_tokens: 100, output_tokens: 20,
      thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 120 },
    'the cumulative terminal usage replaces per-step totals instead of double-counting them');
    assert.equal(result.stdout_bytes, bytes.length);
    assert.equal(JSON.stringify(result).includes('PRIVATE_MODEL_RESPONSE'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TOOL_OUTPUT'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_COMMAND_ERROR'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity stream evidence classifies file tool targets and recognizes multi_replace_file_content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-target-roots-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const registeredRoot = 'C:\\Users\\worker\\registered-project';
  const candidateRoot = `${registeredRoot}\\.attempts\\candidate`;
  const outsideRoot = 'C:\\Users\\worker\\outside-project';
  const toolStep = (stepIndex, state, toolName, targetKey, target) => ({
    event: 'step_update', step_update: { conversation_id: session, step_index: stepIndex,
      state, step_type: 'tool', tool_name: toolName,
      tool_info: { name: toolName, parameters: { [targetKey]: target } } },
  });
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd: candidateRoot, tools: [], permission_mode: 'accept-edits' } },
    toolStep(1, 'ACTIVE', 'multi_replace_file_content', 'TargetFile', `${registeredRoot}\\native-bridge\\worker.mjs`),
    toolStep(1, 'DONE', 'multi_replace_file_content', 'TargetFile', `${registeredRoot}\\native-bridge\\worker.mjs`),
    toolStep(2, 'ACTIVE', 'write_to_file', 'TargetFile', `${candidateRoot}\\src\\worker.mjs`),
    toolStep(2, 'DONE', 'write_to_file', 'TargetFile', `${candidateRoot}\\src\\worker.mjs`),
    toolStep(3, 'ACTIVE', 'edit_file', 'Path', `${outsideRoot}\\outside.mjs`),
    toolStep(3, 'DONE', 'edit_file', 'Path', `${outsideRoot}\\outside.mjs`),
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 } } },
  ];
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), candidateRoot, registeredRoot);
    assert.equal(result.valid, true);
    assert.equal(result.file_change_tool_completed_count, 3);
    assert.deepEqual(result.file_change_target_evidence, {
      status: 'MIXED_ROOTS', tool_count: 3, target_count: 3,
      candidate_root_count: 1, registered_root_count: 1,
      outside_or_unknown_root_count: 1, relative_or_unknown_root_count: 0,
      unidentified_tool_count: 0,
    });
    assert.equal(JSON.stringify(result).includes(registeredRoot), false,
      'the returned evidence classifies roots without disclosing filesystem paths');
    assert.equal(JSON.stringify(result).includes('native-bridge\\worker.mjs'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity target evidence counts multiple unique same-root targets with normalized aliases once each', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-same-root-targets-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const registeredRoot = 'C:\\Users\\worker\\registered-project';
  const candidateRoot = `${registeredRoot}\\.attempts\\candidate`;
  const firstCandidateTarget = `${candidateRoot}\\src\\one.mjs`;
  const secondCandidateTarget = `${candidateRoot}\\src\\two.mjs`;
  const toolStep = (state, parameters) => ({
    event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state, step_type: 'tool', tool_name: 'multi_replace_file_content',
      tool_info: { name: 'multi_replace_file_content', parameters } },
  });
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd: candidateRoot, tools: [], permission_mode: 'accept-edits' } },
    toolStep('ACTIVE', {
      TargetFile: [firstCandidateTarget, secondCandidateTarget],
      Path: [
        firstCandidateTarget.toUpperCase().replaceAll('\\', '/'),
        `${candidateRoot}\\src\\.\\one.mjs`,
      ],
      FilePath: [
        secondCandidateTarget.replaceAll('\\', '/'),
        secondCandidateTarget.toUpperCase(),
      ],
    }),
    toolStep('DONE', {
      TargetFile: [
        firstCandidateTarget,
        secondCandidateTarget.replaceAll('\\', '/'),
      ],
      absolute_path: [
        `${candidateRoot}\\src\\one.mjs`.replaceAll('\\', '/'),
      ],
    }),
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 } } },
  ];
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), candidateRoot, registeredRoot);
    assert.equal(result.valid, true);
    assert.equal(result.tool_execution_count, 1);
    assert.equal(result.file_change_tool_completed_count, 1);
    assert.deepEqual(result.file_change_target_evidence, {
      status: 'CANDIDATE_ROOT_ONLY', tool_count: 1, target_count: 2,
      candidate_root_count: 2, registered_root_count: 0,
      outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 0,
      unidentified_tool_count: 0,
    });
    const categorySum = result.file_change_target_evidence.candidate_root_count +
      result.file_change_target_evidence.registered_root_count +
      result.file_change_target_evidence.outside_or_unknown_root_count +
      result.file_change_target_evidence.relative_or_unknown_root_count;
    assert.equal(result.file_change_target_evidence.target_count, categorySum);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(candidateRoot), false,
      'the returned evidence classifies same-root target multiplicity without disclosing filesystem paths');
    assert.equal(serialized.includes(registeredRoot), false);
    assert.equal(serialized.includes('one.mjs'), false);
    assert.equal(serialized.includes('two.mjs'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity target evidence preserves MIXED_ROOTS and matches category sum for mixed candidate and registered roots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-mixed-roots-multiplicity-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const registeredRoot = 'C:\\Users\\worker\\registered-project';
  const candidateRoot = `${registeredRoot}\\.attempts\\candidate`;
  const candidateTargetA = `${candidateRoot}\\src\\alpha.mjs`;
  const candidateTargetB = `${candidateRoot}\\src\\beta.mjs`;
  const registeredTarget = `${registeredRoot}\\native-bridge\\worker.mjs`;
  const toolStep = (state, parameters) => ({
    event: 'step_update', step_update: { conversation_id: session, step_index: 2,
      state, step_type: 'tool', tool_name: 'multi_replace_file_content',
      tool_info: { name: 'multi_replace_file_content', parameters } },
  });
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd: candidateRoot, tools: [], permission_mode: 'accept-edits' } },
    toolStep('ACTIVE', {
      TargetFile: [candidateTargetA, candidateTargetB],
      Path: registeredTarget,
    }),
    toolStep('DONE', {
      TargetFile: [candidateTargetA, candidateTargetB],
      Path: registeredTarget,
    }),
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 } } },
  ];
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), candidateRoot, registeredRoot);
    assert.equal(result.valid, true);
    assert.equal(result.tool_execution_count, 1);
    assert.equal(result.file_change_tool_completed_count, 1);
    assert.equal(result.file_change_target_evidence.status, 'MIXED_ROOTS');
    const categorySum = result.file_change_target_evidence.candidate_root_count +
      result.file_change_target_evidence.registered_root_count +
      result.file_change_target_evidence.outside_or_unknown_root_count +
      result.file_change_target_evidence.relative_or_unknown_root_count;
    assert.equal(result.file_change_target_evidence.target_count, categorySum);
    assert.equal(result.file_change_target_evidence.target_count, 3);
    assert.deepEqual(result.file_change_target_evidence, {
      status: 'MIXED_ROOTS', tool_count: 1, target_count: 3,
      candidate_root_count: 2, registered_root_count: 1,
      outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 0,
      unidentified_tool_count: 0,
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(candidateRoot), false,
      'the returned evidence classifies mixed roots without disclosing filesystem paths');
    assert.equal(serialized.includes(registeredRoot), false);
    assert.equal(serialized.includes('alpha.mjs'), false);
    assert.equal(serialized.includes('beta.mjs'), false);
    assert.equal(serialized.includes('worker.mjs'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity target evidence deduplicates repeated ACTIVE and DONE updates and retains final root classification', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-target-identities-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const registeredRoot = 'C:\\Users\\worker\\registered-project';
  const candidateRoot = `${registeredRoot}\\.attempts\\candidate`;
  const firstCandidateTarget = `${candidateRoot}\\src\\one.mjs`;
  const secondCandidateTarget = `${candidateRoot}\\src\\two.mjs`;
  const registeredTarget = `${registeredRoot}\\native-bridge\\worker.mjs`;
  const toolStep = (state, parameters) => ({
    event: 'step_update', step_update: { conversation_id: session, step_index: 4,
      state, step_type: 'tool', tool_name: 'multi_replace_file_content',
      tool_info: { name: 'multi_replace_file_content', parameters } },
  });
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd: candidateRoot, tools: [], permission_mode: 'accept-edits' } },
    toolStep('ACTIVE', { TargetFile: [firstCandidateTarget, secondCandidateTarget],
      Path: firstCandidateTarget.toUpperCase().replaceAll('\\', '/'),
      FilePath: ['relative\\unknown.mjs'] }),
    toolStep('DONE', { TargetFile: [secondCandidateTarget.replaceAll('\\', '/'), registeredTarget],
      absolute_path: ['relative/./unknown.mjs'] }),
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 } } },
  ];
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), candidateRoot, registeredRoot);
    assert.equal(result.valid, true);
    assert.equal(result.tool_execution_count, 1);
    assert.equal(result.file_change_tool_completed_count, 1);
    assert.deepEqual(result.file_change_target_evidence, {
      status: 'MIXED_ROOTS', tool_count: 1, target_count: 4,
      candidate_root_count: 2, registered_root_count: 1,
      outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 1,
      unidentified_tool_count: 0,
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(registeredRoot), false,
      'the returned evidence classifies target identities without disclosing filesystem paths');
    assert.equal(serialized.includes('one.mjs'), false);
    assert.equal(serialized.includes('two.mjs'), false);
    assert.equal(serialized.includes('unknown.mjs'), false);
    assert.equal(result.file_change_target_evidence.target_count,
      result.file_change_target_evidence.candidate_root_count +
      result.file_change_target_evidence.registered_root_count +
      result.file_change_target_evidence.outside_or_unknown_root_count +
      result.file_change_target_evidence.relative_or_unknown_root_count);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('incomplete Antigravity streams preserve deduplicated per-step usage without claiming a terminal result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-partial-usage-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const cwd = 'C:\\Users\\worker\\candidate';
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state: 'ACTIVE', step_type: 'agent_response', usage: { input_tokens: 100,
        output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 10, total_tokens: 100 } } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state: 'DONE', step_type: 'agent_response', text_delta: 'PRIVATE_PARTIAL_RESPONSE',
      usage: { input_tokens: 10, output_tokens: 3, thinking_tokens: 1,
        cache_read_tokens: 2, total_tokens: 13 } } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 3,
      state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 5,
        output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 7, total_tokens: 7 } } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 2,
      state: 'DONE', step_type: 'checkpoint', usage: { input_tokens: 2,
        output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 5, total_tokens: 6 } } },
  ];
  try {
    const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    writeFileSync(stdoutPath, bytes);
    const result = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'ANTIGRAVITY_JSONL_INCOMPLETE');
    assert.equal(result.session_id, session);
    assert.equal(result.model_invoked, true);
    assert.equal(result.provider_usage_evidence, 'OBSERVED');
    assert.equal(result.model_activity_evidence, 'OBSERVED');
    assert.equal(result.run_disposition, 'UNKNOWN');
    assert.equal(result.task_acceptance, 'UNKNOWN');
    assert.deepEqual(result.token_usage, { input_tokens: 17, output_tokens: 9,
      thinking_tokens: 3, cache_read_tokens: 14, total_tokens: 26 });
    assert.equal(result.stdout_bytes, bytes.length);
    assert.equal(JSON.stringify(result).includes('PRIVATE_PARTIAL_RESPONSE'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity terminal zero usage cannot erase positive per-step evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-usage-conflict-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const cwd = 'C:\\Users\\worker\\candidate';
  const usage = { input_tokens: 9, output_tokens: 1, thinking_tokens: 0,
    cache_read_tokens: 0, total_tokens: 10 };
  const zeroUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
    cache_read_tokens: 0, total_tokens: 0 };
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'ACTIVE', step_type: 'agent_response', usage } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'DONE', step_type: 'agent_response', usage: zeroUsage } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS',
      response: '', usage: zeroUsage } },
  ];
  try {
    writeFileSync(stdoutPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    const result = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'ANTIGRAVITY_TERMINAL_USAGE_CONFLICT');
    assert.equal(result.model_invoked, true);
    assert.equal(result.provider_usage_evidence, 'OBSERVED');
    assert.equal(result.model_activity_evidence, 'OBSERVED');
    assert.equal(result.run_disposition, 'CLI_SUCCESS_REQUIRES_SEMANTIC_REVIEW');
    assert.equal(result.task_acceptance, 'UNKNOWN');
    assert.equal(result.token_usage, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity cache or aggregate tokens are positive provider usage evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-aggregate-usage-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const cwd = 'C:\\Users\\worker\\candidate';
  const usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
    cache_read_tokens: 12, total_tokens: 12 };
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS',
      response: '', usage } },
  ];
  try {
    writeFileSync(stdoutPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    const result = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(result.valid, true);
    assert.equal(result.model_invoked, true);
    assert.equal(result.provider_usage_evidence, 'OBSERVED');
    assert.deepEqual(result.token_usage, usage);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity stream classifies all documented CLI statuses without claiming task acceptance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-status-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const cwd = 'C:\\Users\\worker\\candidate';
  const dispositions = {
    SUCCESS: 'CLI_SUCCESS_REQUIRES_SEMANTIC_REVIEW',
    ERROR: 'CLI_ERROR_EFFECTS_UNKNOWN',
    CANCELED: 'CLI_CANCELED_EFFECTS_UNKNOWN',
    INTERRUPTED: 'CLI_INTERRUPTED_EFFECTS_UNKNOWN',
    INVALID: 'CLI_INVALID_EFFECTS_UNKNOWN',
    WAITING: 'CLI_WAITING_FOR_INPUT_EFFECTS_UNKNOWN',
    RUNNING: 'CLI_STILL_RUNNING_DO_NOT_REDISPATCH',
  };
  try {
    for (const [status, disposition] of Object.entries(dispositions)) {
      const events = [
        { event: 'init', conversation_id: session,
          init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
        { event: 'result', result: { conversation_id: session, status, response: '',
          usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
            cache_read_tokens: 0, total_tokens: 0 } } },
      ];
      writeFileSync(stdoutPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
      const result = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
      assert.equal(result.valid, true, `${status} is a recognized CLI status`);
      assert.equal(result.cli_status, status);
      assert.equal(result.run_disposition, disposition);
      assert.equal(result.external_effects, 'UNKNOWN');
      assert.equal(result.source_diff_evidence, 'NOT_INSPECTED');
      assert.equal(result.task_acceptance, 'UNKNOWN');
      assert.equal(result.model_invoked, false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity stream evidence fails closed on wrong model, cwd, capture hash and malformed NDJSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-stream-invalid-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const makeStream = (model = 'gemini-3.8-flash-high', permissionMode = 'accept-edits') => [
    { event: 'init', conversation_id: session,
      init: { model, cwd: 'C:\\Users\\worker\\candidate', tools: [],
        ...(permissionMode === null ? {} : { permission_mode: permissionMode }) } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0,
        cache_read_tokens: 0, total_tokens: 2 } } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  try {
    const good = Buffer.from(makeStream());
    writeFileSync(stdoutPath, good);
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).valid, true);
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'relative\\candidate')).reason, 'ANTIGRAVITY_EXPECTED_CWD_INVALID');
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, '0'.repeat(64),
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_CAPTURE_HASH_MISMATCH');
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\other\\candidate')).reason, 'ANTIGRAVITY_WORKSPACE_CWD_MISMATCH');
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\other\\candidate')).workspace_cwd_evidence.status, 'MISMATCH');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-medium'));
    const wrongModel = await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate');
    assert.equal(wrongModel.reason, 'ANTIGRAVITY_JSONL_INVALID');
    assert.equal(wrongModel.workspace_cwd_evidence.status, 'MATCHED',
      'invalid model evidence must not erase independently observed workspace identity');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-high', 'auto'));
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_PERMISSION_MODE_UNRECOGNIZED');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-high', null));
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_PERMISSION_MODE_UNRECOGNIZED');
    writeFileSync(stdoutPath, '{not-json}\n');
    const malformedWithoutTool = await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate');
    assert.equal(malformedWithoutTool.reason, 'ANTIGRAVITY_JSONL_INVALID');
    assert.equal(malformedWithoutTool.forbidden_tool_execution_evidence, 'UNKNOWN');
    const observedBeforeTruncation = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd: 'C:\\Users\\worker\\candidate',
          tools: [], permission_mode: 'request-review' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'DONE', step_type: 'tool', tool_name: 'browser/click',
        tool_info: { url: 'https://private.invalid/' } } },
      '{truncated',
    ].map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n';
    const malformedBytes = Buffer.from(observedBeforeTruncation);
    writeFileSync(stdoutPath, malformedBytes);
    const malformedSha = createHash('sha256').update(malformedBytes).digest('hex');
    const invalidAfterForbiddenTool = await readAntigravityV2RunEvidence(stdoutPath, malformedSha,
      'C:\\Users\\worker\\candidate');
    assert.equal(invalidAfterForbiddenTool.reason, 'ANTIGRAVITY_JSONL_INVALID');
    assert.equal(invalidAfterForbiddenTool.forbidden_tool_execution_evidence, 'OBSERVED');
    assert.equal(invalidAfterForbiddenTool.session_id, session);
    assert.equal(invalidAfterForbiddenTool.session_started, true);
    assert.equal(invalidAfterForbiddenTool.stdout_sha256, malformedSha);
    assert.equal(invalidAfterForbiddenTool.stdout_bytes, malformedBytes.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity headless request-review is distinct from accept-edits and zero-usage stays unverified', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-request-review-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const cwd = 'C:\\Users\\worker\\candidate';
  const session = 'f4c8b3b8-ceda-4013-9a57-17145fa54231';
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'DONE', step_type: 'user_input' } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
        cache_read_tokens: 0, total_tokens: 0 } } },
  ];
  writeFileSync(stdoutPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(result.valid, true);
    assert.equal(result.permission_mode_evidence, 'REQUEST_REVIEW_CONFIRMED');
    assert.equal(result.model_invoked, false);
    assert.equal(result.model_activity_evidence, 'NO_ACTIVITY_OBSERVED');
    assert.equal(result.tool_execution_evidence, 'NO_TOOL_CALLS_OBSERVED');
    assert.equal(result.file_change_tool_evidence, 'NO_FILE_CHANGE_TOOL_OBSERVED');
    assert.equal(result.session_id, session);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity ERROR tool events preserve failed-write evidence without claiming a change', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-write-error-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = 'd4f5f344-422a-48fd-b54f-42a7715c422e';
  const cwd = 'C:\\Users\\worker\\candidate';
  const init = { event: 'init', conversation_id: session,
    init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'request-review' } };
  const activeWrite = { event: 'step_update', step_update: { conversation_id: session,
    step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'replace_file_content' } };
  const failedWrite = { event: 'step_update', step_update: { conversation_id: session,
    step_index: 0, state: 'ERROR', step_type: 'tool', tool_name: 'replace_file_content',
    tool_info: { error: { code: 'WRITE_DENIED' } } } };
  const terminal = { event: 'result', result: { conversation_id: session, status: 'ERROR', response: '',
    usage: { input_tokens: 10, output_tokens: 3, thinking_tokens: 2,
      cache_read_tokens: 0, total_tokens: 15 } } };
  const writeStream = events => Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  try {
    const completeBytes = writeStream([init, activeWrite, failedWrite, terminal]);
    writeFileSync(stdoutPath, completeBytes);
    const complete = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(completeBytes).digest('hex'), cwd);
    assert.equal(complete.valid, true);
    assert.equal(complete.cli_status, 'ERROR');
    assert.equal(complete.file_change_tool_evidence, 'OBSERVED');
    assert.equal(complete.file_change_tool_completed_count, 0);
    assert.equal(complete.file_change_tool_failed_count, 1);
    assert.equal(complete.file_change_tool_incomplete_count, 0);
    assert.equal(complete.task_acceptance, 'UNKNOWN');
    assert.equal(complete.external_effects, 'UNKNOWN');

    const truncatedBytes = Buffer.from(`${JSON.stringify(init)}\n${JSON.stringify(failedWrite)}\n{truncated\n`);
    writeFileSync(stdoutPath, truncatedBytes);
    const truncated = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(truncatedBytes).digest('hex'), cwd);
    assert.equal(truncated.valid, false);
    assert.equal(truncated.reason, 'ANTIGRAVITY_JSONL_INVALID');
    assert.equal(truncated.session_id, session);
    assert.equal(truncated.file_change_tool_evidence, 'OBSERVED');
    assert.equal(truncated.file_change_tool_completed_count, 0);
    assert.equal(truncated.file_change_tool_failed_count, 1);
    assert.equal(truncated.file_change_tool_incomplete_count, 0);
    assert.equal(truncated.task_acceptance, 'UNKNOWN');
    assert.equal(truncated.external_effects, 'UNKNOWN');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Synthetic, redacted stream readers for the `edit_file` telemetry regression.
// No model call, network access, or real user data is involved.
function writeAntigravityStdout(directory, events) {
  const stdoutPath = join(directory, 'stdout.jsonl');
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  return { stdoutPath, bytes };
}

// Exact 31-tool-event shape: 28 read_file (25 DONE, 3 ERROR) + 2 write_file
// DONE + 1 edit_file DONE, wrapped in the init/result framing a real capture has.
function editFileTelemetryStream() {
  const session = '31e0c0de-0000-4000-8000-000000000031';
  const cwd = 'C:\\Users\\worker\\candidate';
  const events = [{ event: 'init', conversation_id: session,
    init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } }];
  let step = 0;
  const pushTool = (tool_name, state, tool_info) => events.push({ event: 'step_update',
    step_update: { conversation_id: session, step_index: step++, state, step_type: 'tool',
      tool_name, ...(tool_info ? { tool_info } : {}) } });
  for (let i = 0; i < 25; i += 1) pushTool('read_file', 'DONE');
  for (let i = 0; i < 3; i += 1) pushTool('read_file', 'ERROR', { error: { code: 'ENOENT' } });
  pushTool('write_file', 'DONE');
  pushTool('write_file', 'DONE');
  pushTool('edit_file', 'DONE');
  events.push({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0,
      cache_read_tokens: 0, total_tokens: 120 } } });
  return { session, cwd, events };
}

test('Antigravity edit_file is a completed file change in both stream evidence paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-edit-file-'));
  try {
    const { session, cwd, events } = editFileTelemetryStream();
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.equal(result.session_id, session);
    assert.equal(result.tool_execution_count, 31);
    assert.equal(result.tool_execution_failed_count, 3);
    assert.equal(result.tool_execution_incomplete_count, 0);
    assert.equal(result.file_change_tool_evidence, 'OBSERVED');
    assert.equal(result.file_change_tool_completed_count, 3);
    assert.equal(result.file_change_tool_failed_count, 0,
      'ENOENT read failures must not be attributed to successful writes');
    assert.equal(result.file_change_tool_incomplete_count, 0);
    // Tool success is evidence only; it is never a captured diff or acceptance.
    assert.equal(result.source_diff_evidence, 'NOT_INSPECTED');
    assert.equal(result.task_acceptance, 'UNKNOWN');
    assert.equal(result.external_effects, 'UNKNOWN');

    // The invalid-capture classification path recomputes the same tool counts.
    const invalid = await readAntigravityV2RunEvidence(stdoutPath, '0'.repeat(64), cwd);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.reason, 'ANTIGRAVITY_CAPTURE_HASH_MISMATCH');
    for (const key of ['tool_execution_count', 'tool_execution_failed_count',
      'tool_execution_incomplete_count', 'file_change_tool_completed_count',
      'file_change_tool_failed_count', 'file_change_tool_incomplete_count'])
      assert.equal(invalid[key], result[key], `${key} must agree across both parser paths`);
    assert.equal(invalid.file_change_tool_evidence, 'OBSERVED');
    assert.equal(invalid.task_acceptance, 'UNKNOWN');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity failed or unfinished edit_file stays distinct from completed writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-edit-file-negative-'));
  const session = '31e0c0de-0000-4000-8000-000000000032';
  const cwd = 'C:\\Users\\worker\\candidate';
  const init = { event: 'init', conversation_id: session,
    init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } };
  const terminal = { event: 'result', result: { conversation_id: session, status: 'SUCCESS',
    response: '', usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0,
      cache_read_tokens: 0, total_tokens: 2 } } };
  try {
    const { stdoutPath } = writeAntigravityStdout(directory, [
      init,
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ACTIVE', step_type: 'tool', tool_name: 'edit_file' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: { error: { code: 'EDIT_DENIED' } } } },
      terminal,
    ]);
    const failed = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(failed.valid, true);
    assert.equal(failed.tool_execution_failed_count, 1);
    assert.equal(failed.file_change_tool_evidence, 'OBSERVED');
    assert.equal(failed.file_change_tool_completed_count, 0);
    assert.equal(failed.file_change_tool_failed_count, 1);
    assert.equal(failed.file_change_tool_incomplete_count, 0);
    assert.equal(failed.task_acceptance, 'UNKNOWN');

    writeAntigravityStdout(directory, [
      init,
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ACTIVE', step_type: 'tool', tool_name: 'edit_file' } },
      terminal,
    ]);
    const incomplete = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(incomplete.valid, true);
    assert.equal(incomplete.tool_execution_incomplete_count, 1);
    assert.equal(incomplete.file_change_tool_completed_count, 0);
    assert.equal(incomplete.file_change_tool_failed_count, 0);
    assert.equal(incomplete.file_change_tool_incomplete_count, 1);
    assert.equal(incomplete.task_acceptance, 'UNKNOWN');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity rejects a missing or malformed tool status without counting a write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-tool-status-'));
  const session = '31e0c0de-0000-4000-8000-000000000033';
  const cwd = 'C:\\Users\\worker\\candidate';
  const init = { event: 'init', conversation_id: session,
    init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } };
  const terminal = { event: 'result', result: { conversation_id: session, status: 'SUCCESS',
    response: '', usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0,
      cache_read_tokens: 0, total_tokens: 2 } } };
  try {
    for (const toolEvent of [
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        step_type: 'tool', tool_name: 'edit_file' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'FINISHED', step_type: 'tool', tool_name: 'edit_file' } },
    ]) {
      const { stdoutPath } = writeAntigravityStdout(directory, [init, toolEvent, terminal]);
      const parsed = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
      assert.equal(parsed.valid, false);
      assert.equal(parsed.reason, 'ANTIGRAVITY_JSONL_INVALID');
      assert.equal(parsed.file_change_tool_completed_count, 0);
      assert.equal(parsed.file_change_tool_failed_count, 0);
      assert.equal(parsed.file_change_tool_incomplete_count, 0);
      assert.equal(parsed.task_acceptance, 'UNKNOWN');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity read-only stream reports no file change without weakening acceptance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-no-file-change-'));
  try {
    const session = '31e0c0de-0000-4000-8000-000000000034';
    const cwd = 'C:\\Users\\worker\\candidate';
    const { stdoutPath } = writeAntigravityStdout(directory, [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'DONE', step_type: 'tool', tool_name: 'read_file' } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 2, output_tokens: 1, thinking_tokens: 0,
          cache_read_tokens: 0, total_tokens: 3 } } },
    ]);
    const parsed = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.tool_execution_count, 1);
    assert.equal(parsed.file_change_tool_evidence, 'NO_FILE_CHANGE_TOOL_OBSERVED');
    assert.equal(parsed.file_change_tool_completed_count, 0);
    assert.equal(parsed.file_change_tool_failed_count, 0);
    assert.equal(parsed.file_change_tool_incomplete_count, 0);
    assert.equal(parsed.source_diff_evidence, 'NOT_INSPECTED');
    assert.equal(parsed.task_acceptance, 'UNKNOWN');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity readiness requests JSON usage and parses the official envelope without inference', () => {
  const usage = JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Gemini Models',
          buckets: [
            { name: 'Weekly Limit Remaining', remaining_fraction: 0.8941181898117065,
              reset_time: '2026-10-23T22:50:38Z' },
            { name: 'Five Hour Limit Remaining', remaining_fraction: 0.9974105358123779,
              reset_time: '2026-10-23T18:43:08Z' },
          ],
        }],
      },
    },
  });
  const calls = [];
  const help = '--print --output-format (text, json, stream-json) --model --sandbox --mode accept-edits';
  const runner = (_bin, args) => {
    calls.push([...args]);
    if (args[0] === '--version') return '1.4.6';
    if (args[0] === '--help') return help;
    if (args[0] === 'models') return 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
    if (args[0] === '--print' && args[1] === '/usage') return usage;
    throw new Error('Unexpected metadata command');
  };

  const readiness = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
    { USERPROFILE: process.env.USERPROFILE, PATH: 'clean' }, () => true);
  assert.equal(readiness.gemini_aggregate_quota.status, 'GEMINI_AGGREGATE_QUOTA_READ');
  assert.equal(readiness.gemini_aggregate_quota.weekly_remaining_percent, 89);
  assert.equal(readiness.gemini_aggregate_quota.five_hour_remaining_percent, 99);
  assert.equal(readiness.authentication_evidence, 'AUTHENTICATED_QUOTA_READ');
  assert.equal(readiness.inference_executed, false);
  assert.deepEqual(calls[3], ['--print', '/usage', '--output-format', 'json']);
});

test('Antigravity JSON usage readiness rejects mismatched command name or nested command error', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-mismatched-usage-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-mismatched-workspace-'));
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  const required = ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    useG1Credits: false,
    permissions: { deny: required },
  }));
  const help = '--project --add-dir --print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const syntheticMarker = 'synthetic-marker-not-leaked@example.invalid';
  const syntheticAccountId = 'synthetic-account-id-98765';
  const cases = [
    {
      description: 'outer SUCCESS with command.name credits',
      payload: JSON.stringify({
        status: 'SUCCESS',
        account: { id: syntheticAccountId, email: syntheticMarker },
        email: syntheticMarker,
        command: {
          name: 'credits',
          status: 'SUCCESS',
          data: {
            groups: [{
              name: 'Gemini Models',
              buckets: [
                { name: 'Weekly Limit Remaining', remaining_fraction: 0.8941181898117065,
                  reset_time: '2026-10-23T22:50:38Z' },
                { name: 'Five Hour Limit Remaining', remaining_fraction: 0.9974105358123779,
                  reset_time: '2026-10-23T18:43:08Z' },
              ],
            }],
          },
        },
      }),
    },
    {
      description: 'usage command with non-null command.error',
      payload: JSON.stringify({
        status: 'SUCCESS',
        account: { id: syntheticAccountId, email: syntheticMarker },
        email: syntheticMarker,
        command: {
          name: 'usage',
          status: 'SUCCESS',
          error: { code: 'COMMAND_ERROR', message: `nested failure: ${syntheticMarker}` },
          data: {
            groups: [{
              name: 'Gemini Models',
              buckets: [
                { name: 'Weekly Limit Remaining', remaining_fraction: 0.8941181898117065,
                  reset_time: '2026-10-23T22:50:38Z' },
                { name: 'Five Hour Limit Remaining', remaining_fraction: 0.9974105358123779,
                  reset_time: '2026-10-23T18:43:08Z' },
              ],
            }],
          },
        },
      }),
    },
    {
      description: 'usage command with non-success nested command status',
      payload: JSON.stringify({
        status: 'SUCCESS',
        account: { id: syntheticAccountId, email: syntheticMarker },
        email: syntheticMarker,
        command: {
          name: 'usage',
          status: 'ERROR',
          error: { code: 'COMMAND_FAILED', message: `nested failure: ${syntheticMarker}` },
          data: {
            groups: [{
              name: 'Gemini Models',
              buckets: [
                { name: 'Weekly Limit Remaining', remaining_fraction: 0.8941181898117065,
                  reset_time: '2026-10-23T22:50:38Z' },
                { name: 'Five Hour Limit Remaining', remaining_fraction: 0.9974105358123779,
                  reset_time: '2026-10-23T18:43:08Z' },
              ],
            }],
          },
        },
      }),
    },
  ];

  try {
    writeAntigravityProject(profile, testProjectId, workspace);
    for (const testCase of cases) {
      const calls = [];
      const runner = (_bin, args) => {
        calls.push([...args]);
        const rest = args[0] === `--project=${testProjectId}` ? args.slice(1) : args;
        if (rest[0] === '--version') return '1.4.6';
        if (rest[0] === '--help') return help;
        if (rest[0] === 'models') return 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
        if (rest[0] === '--print' && rest[1] === '/usage') return testCase.payload;
        throw new Error(`Unexpected metadata command: ${args.join(' ')}`);
      };

      const readiness = runAntigravityV2Readiness(process.execPath, workspace, runner,
        { USERPROFILE: profile, PATH: 'clean' }, () => true, testProjectId);

      // Quota read & auth evidence not established
      assert.notEqual(readiness.gemini_aggregate_quota?.status, 'GEMINI_AGGREGATE_QUOTA_READ');
      assert.notEqual(readiness.authentication_evidence, 'AUTHENTICATED_QUOTA_READ');

      // Authentication left unchecked/unknown, reports safe usage-output failure classification
      assert.equal(readiness.authentication_checked, false);
      assert.equal(readiness.authentication_evidence, 'UNVERIFIED');
      assert.ok(readiness.issues.includes('ANTIGRAVITY_USAGE_OUTPUT_UNRECOGNIZED'));

      // Unknown inference status prevents readiness even when auth/quota fields are forged.
      assert.equal(readiness.gemini_aggregate_quota?.status, 'GEMINI_AGGREGATE_QUOTA_UNKNOWN');
      assert.equal(readiness.gemini_aggregate_quota?.weekly_remaining_percent, null);
      assert.equal(readiness.gemini_aggregate_quota?.five_hour_remaining_percent, null);
      assert.equal(antigravityV2ReadinessExecutionFailure(readiness), 'ANTIGRAVITY_CLI_NOT_QUALIFIED');
      assert.equal(antigravityV2ReadinessExecutionFailure({
        ...readiness,
        authentication_checked: true,
        authentication_evidence: 'AUTHENTICATED_QUOTA_READ',
        issues: [],
      }), 'ANTIGRAVITY_CLI_NOT_QUALIFIED');

      // Inference status remains unknown, with no synthetic marker exposed
      assert.equal(readiness.inference_executed, 'UNKNOWN');
      assert.equal(JSON.stringify(readiness).includes(syntheticMarker), false);
      assert.equal(JSON.stringify(readiness).includes(syntheticAccountId), false);
      assert.deepEqual(calls[3], [`--project=${testProjectId}`, '--print', '/usage', '--output-format', 'json']);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Antigravity run evidence captures missing read target regression reason', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-read-fail-'));
  const session = '31e0c0de-0000-4000-8000-000000000041';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'read_file',
        tool_info: { error: { code: 'ENOENT', message: 'C:\\Users\\worker\\candidate\\missing.txt: No such file or directory' } } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.deepEqual(result.file_tool_failure_reasons, [ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.READ_TARGET_NOT_FOUND]);
    assert.equal(result.tool_execution_failed_count, 1);
    assert.equal(result.file_change_tool_failed_count, 0);
    assert.equal(result.task_acceptance, 'UNKNOWN');
    assert.equal(result.external_effects, 'UNKNOWN');
    assert.equal(result.source_diff_evidence, 'NOT_INSPECTED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity run evidence captures edit target-text mismatch regression reason', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-edit-mismatch-'));
  const session = '31e0c0de-0000-4000-8000-000000000042';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: {
          parameters: { targetfile: 'C:\\Users\\worker\\candidate\\source.js' },
          error: { code: 'TARGET_MISMATCH', message: 'target content not found in the file' }
        } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.deepEqual(result.file_tool_failure_reasons, [ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.EDIT_TARGET_TEXT_MISMATCH]);
    assert.equal(result.tool_execution_failed_count, 1);
    assert.equal(result.file_change_tool_failed_count, 1);
    assert.equal(result.task_acceptance, 'UNKNOWN');
    assert.equal(result.external_effects, 'UNKNOWN');
    assert.equal(result.source_diff_evidence, 'NOT_INSPECTED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity run evidence captures unrecognized file-tool error fallback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-file-unknown-'));
  const session = '31e0c0de-0000-4000-8000-000000000043';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'write_file',
        tool_info: {
          parameters: { filepath: 'C:\\Users\\worker\\candidate\\out.txt' },
          error: { code: 'EACCES', message: 'EACCES: permission denied, open' }
        } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.deepEqual(result.file_tool_failure_reasons, [ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.FILE_TOOL_ERROR_UNKNOWN]);
    assert.equal(result.tool_execution_failed_count, 1);
    assert.equal(result.file_change_tool_failed_count, 1);
    assert.equal(result.task_acceptance, 'UNKNOWN');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity run evidence reproduces W2 attempt trace with missing read and edit mismatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-w2-trace-'));
  const session = '31e0c0de-0000-4000-8000-000000000044';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'read_file',
        tool_info: { error: { message: 'File not found: missing-header.h' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: {
          parameters: { targetfile: 'C:\\Users\\worker\\candidate\\main.c' },
          error: { message: 'Target must exactly match existing file text' }
        } } },
      { event: 'result', result: { conversation_id: session, status: 'ERROR', response: 'Failed to apply edits',
        usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 120 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.equal(result.cli_status, 'ERROR');
    assert.equal(result.run_disposition, 'CLI_ERROR_EFFECTS_UNKNOWN');
    assert.deepEqual(result.file_tool_failure_reasons, [
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.READ_TARGET_NOT_FOUND,
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.EDIT_TARGET_TEXT_MISMATCH,
    ]);
    assert.equal(result.tool_execution_failed_count, 2);
    assert.equal(result.file_change_tool_failed_count, 1);
    assert.equal(result.task_acceptance, 'UNKNOWN');
    assert.equal(result.external_effects, 'UNKNOWN');
    assert.equal(result.source_diff_evidence, 'NOT_INSPECTED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity run evidence deduplicates failure reasons in encounter order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-dedup-'));
  const session = '31e0c0de-0000-4000-8000-000000000045';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'read_file',
        tool_info: { error: { code: 'ENOENT' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: { error: { code: 'TARGET_MISMATCH' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 2,
        state: 'ERROR', step_type: 'tool', tool_name: 'read_file',
        tool_info: { error: { message: 'File does not exist' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 3,
        state: 'ERROR', step_type: 'tool', tool_name: 'write_file',
        tool_info: { error: { code: 'EIO' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 4,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: { error: { message: 'Target text mismatch' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 5,
        state: 'ERROR', step_type: 'tool', tool_name: 'replace_file_content',
        tool_info: { error: { code: 'UNKNOWN_INTERNAL_ERROR' } } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.deepEqual(result.file_tool_failure_reasons, [
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.READ_TARGET_NOT_FOUND,
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.EDIT_TARGET_TEXT_MISMATCH,
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.FILE_TOOL_ERROR_UNKNOWN,
    ]);
    assert.equal(result.tool_execution_failed_count, 6);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity run evidence strictly excludes raw provider errors, paths, and contents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-privacy-'));
  const session = '31e0c0de-0000-4000-8000-000000000046';
  const cwd = 'C:\\Users\\worker\\candidate';
  const sensitivePath = 'C:\\Users\\alice\\.ssh\\id_rsa';
  const sensitiveSecret = 'ghp_secret_credential_token_9876543210';
  const sensitiveProviderMsg = 'Internal Google Gemini Provider failure code 500 RPC timeout';
  const sensitiveContent = 'PRIVATE_KEY_BODY_DO_NOT_EXPOSE';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'read_file',
        tool_info: {
          parameters: { path: sensitivePath },
          error: { code: 'ENOENT', message: `Cannot find file ${sensitivePath}: ${sensitiveSecret}` }
        } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: {
          parameters: { targetfile: 'C:\\Users\\worker\\candidate\\code.js', target: sensitiveContent },
          error: { code: 'EDIT_DENIED', message: sensitiveProviderMsg }
        } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'response text',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(sensitivePath), false, 'sensitive path must not be in run evidence');
    assert.equal(serialized.includes(sensitiveSecret), false, 'secret token must not be in run evidence');
    assert.equal(serialized.includes(sensitiveProviderMsg), false, 'raw provider error must not be in run evidence');
    assert.equal(serialized.includes(sensitiveContent), false, 'file content must not be in run evidence');
    assert.equal(serialized.includes('response text'), false, 'raw response text must not be in run evidence');

    assert.deepEqual(result.file_tool_failure_reasons, [
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.READ_TARGET_NOT_FOUND,
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.FILE_TOOL_ERROR_UNKNOWN,
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity non-file tool failure and successful tools produce empty failure reasons', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-nonfile-'));
  const session = '31e0c0de-0000-4000-8000-000000000047';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const eventsNonFile = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
        tool_info: { error: { code: 'COMMAND_FAILED', message: 'Process exited with status 1' } } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath: nonFilePath } = writeAntigravityStdout(directory, eventsNonFile);
    const nonFileResult = await readAntigravityV2RunEvidence(nonFilePath, null, cwd);
    assert.equal(nonFileResult.valid, true);
    assert.equal(nonFileResult.tool_execution_failed_count, 1);
    assert.equal(nonFileResult.file_change_tool_failed_count, 0);
    assert.deepEqual(nonFileResult.file_tool_failure_reasons, []);

    const eventsClean = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'DONE', step_type: 'tool', tool_name: 'read_file' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
        state: 'DONE', step_type: 'tool', tool_name: 'write_file',
        tool_info: { parameters: { path: 'C:\\Users\\worker\\candidate\\file.txt' } } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath: cleanPath } = writeAntigravityStdout(directory, eventsClean);
    const cleanResult = await readAntigravityV2RunEvidence(cleanPath, null, cwd);
    assert.equal(cleanResult.valid, true);
    assert.equal(cleanResult.tool_execution_failed_count, 0);
    assert.equal(cleanResult.file_change_tool_completed_count, 1);
    assert.deepEqual(cleanResult.file_tool_failure_reasons, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity file tool failure reasons agree across valid and invalid parser paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-paths-'));
  const session = '31e0c0de-0000-4000-8000-000000000048';
  const cwd = 'C:\\Users\\worker\\candidate';
  try {
    const events = [
      { event: 'init', conversation_id: session,
        init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
        state: 'ERROR', step_type: 'tool', tool_name: 'read_file',
        tool_info: { error: { code: 'ENOENT' } } } },
      { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
        state: 'ERROR', step_type: 'tool', tool_name: 'edit_file',
        tool_info: { error: { code: 'TARGET_MISMATCH' } } } },
      { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 } } },
    ];
    const { stdoutPath, bytes } = writeAntigravityStdout(directory, events);
    const validSha = createHash('sha256').update(bytes).digest('hex');

    const validResult = await readAntigravityV2RunEvidence(stdoutPath, validSha, cwd);
    assert.equal(validResult.valid, true);

    const mismatchResult = await readAntigravityV2RunEvidence(stdoutPath, '0'.repeat(64), cwd);
    assert.equal(mismatchResult.valid, false);
    assert.equal(mismatchResult.reason, 'ANTIGRAVITY_CAPTURE_HASH_MISMATCH');

    const { stdoutPath: truncPath } = writeAntigravityStdout(directory, events.slice(0, 3));
    const truncResult = await readAntigravityV2RunEvidence(truncPath, null, cwd);
    assert.equal(truncResult.valid, false);
    assert.equal(truncResult.reason, 'ANTIGRAVITY_JSONL_INCOMPLETE');

    const expected = [
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.READ_TARGET_NOT_FOUND,
      ANTIGRAVITY_FILE_TOOL_FAILURE_REASONS.EDIT_TARGET_TEXT_MISMATCH,
    ];
    assert.deepEqual(validResult.file_tool_failure_reasons, expected);
    assert.deepEqual(mismatchResult.file_tool_failure_reasons, expected);
    assert.deepEqual(truncResult.file_tool_failure_reasons, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity classifyAntigravityFileToolReason unit classifications and unknown fallbacks', () => {
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { code: 'ENOENT' } }, 'ERROR'),
    'READ_TARGET_NOT_FOUND');
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { code: 'FILE_NOT_FOUND' } }, 'ERROR'),
    'READ_TARGET_NOT_FOUND');
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { message: 'no such file or directory' } }, 'ERROR'),
    'READ_TARGET_NOT_FOUND');
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { message: 'File not found: foo.txt' } }, 'ERROR'),
    'READ_TARGET_NOT_FOUND');
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { message: 'file does not exist' } }, 'ERROR'),
    'READ_TARGET_NOT_FOUND');
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { message: 'cannot find the path specified' } }, 'ERROR'),
    'READ_TARGET_NOT_FOUND');
  assert.equal(classifyAntigravityFileToolReason('read_file', null, 'ERROR', { message: 'missing file' }),
    'READ_TARGET_NOT_FOUND');

  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { code: 'TARGET_MISMATCH' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { code: 'EDIT_TARGET_TEXT_MISMATCH' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { message: 'target content not found in the file' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { message: 'Target must exactly match existing file text' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { message: 'target text mismatch' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('replace_file_content', { error: { message: 'could not find target text' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('replace_file_content', { error: { message: 'string to replace not found' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');
  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { code: 'SEARCH_STRING_NOT_FOUND' } }, 'ERROR'),
    'EDIT_TARGET_TEXT_MISMATCH');

  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { code: 'EACCES', message: 'permission denied' } }, 'ERROR'),
    'FILE_TOOL_ERROR_UNKNOWN');
  assert.equal(classifyAntigravityFileToolReason('read_file', { error: { message: 'arbitrary provider internal error' } }, 'ERROR'),
    'FILE_TOOL_ERROR_UNKNOWN');
  assert.equal(classifyAntigravityFileToolReason('write_file', { error: { code: 'ENOSPC', message: 'no space left on device' } }, 'ERROR'),
    'FILE_TOOL_ERROR_UNKNOWN');
  assert.equal(classifyAntigravityFileToolReason('edit_file', { error: { code: 'EIO', message: 'input/output error' } }, 'ERROR'),
    'FILE_TOOL_ERROR_UNKNOWN');
  assert.equal(classifyAntigravityFileToolReason('edit_file', null, 'ERROR'),
    'FILE_TOOL_ERROR_UNKNOWN');

  assert.equal(classifyAntigravityFileToolReason('run_command', { error: { code: 'ENOENT' } }, 'ERROR'), null);
  assert.equal(classifyAntigravityFileToolReason('run_command', { error: { code: 'TARGET_MISMATCH' } }, 'ERROR'), null);
  assert.equal(classifyAntigravityFileToolReason('browser_navigate', { error: { message: 'not found' } }, 'ERROR'), null);
  assert.equal(classifyAntigravityFileToolReason('unknown_tool', { error: { code: 'ENOENT' } }, 'ERROR'), null);

  assert.equal(classifyAntigravityFileToolReason('read_file', null, 'DONE'), null);
  assert.equal(classifyAntigravityFileToolReason('edit_file', null, 'DONE'), null);
  assert.equal(classifyAntigravityFileToolReason('write_file', null, 'DONE'), null);
});

test('Antigravity summarizeAntigravityFileToolFailureReasons aggregates and deduplicates', () => {
  const tools = new Map([
    [0, { failed: true, failureReason: 'READ_TARGET_NOT_FOUND' }],
    [1, { failed: true, failureReason: 'EDIT_TARGET_TEXT_MISMATCH' }],
    [2, { failed: true, failureReason: 'READ_TARGET_NOT_FOUND' }],
    [3, { failed: false, failureReason: null }],
    [4, { failed: true, failureReason: 'FILE_TOOL_ERROR_UNKNOWN' }],
    [5, { failed: true, failureReason: 'EDIT_TARGET_TEXT_MISMATCH' }],
    [6, { failed: true, failureReason: null }],
  ]);
  assert.deepEqual(summarizeAntigravityFileToolFailureReasons(tools), [
    'READ_TARGET_NOT_FOUND',
    'EDIT_TARGET_TEXT_MISMATCH',
    'FILE_TOOL_ERROR_UNKNOWN',
  ]);
  assert.deepEqual(summarizeAntigravityFileToolFailureReasons(new Map()), []);
  assert.deepEqual(summarizeAntigravityFileToolFailureReasons(null), []);
});
