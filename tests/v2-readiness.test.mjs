import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { summarizeV2AuthJson, summarizeV2AuthProviderJson, summarizeV2Models, readV2ProviderAuth,
  runV2Readiness, summarizeAntigravityCreditSetting, summarizeAntigravityV2Models,
  runAntigravityV2Readiness, summarizeAntigravityUsage, summarizeAntigravityToolPolicy,
  readAntigravityProjectBinding, resolveAntigravityProjectId,
  antigravityV2ReadinessExecutionFailure, readAntigravityV2RunEvidence,
  runAntigravityMetadata }
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

const validAntigravityUsage = 'Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-23T22:50:38Z\n' +
  'Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T05:46:39Z\n';

const testProjectId = 'b8fbf647-6c41-4932-9d0a-8a7af257a27a';

function writeAntigravityProject(profile, projectId, workspace, resources = null) {
  const projectDir = join(profile, '.gemini', 'config', 'projects');
  mkdirSync(projectDir, { recursive: true });
  const projectResources = resources ?? [{ folderUri: pathToFileURL(workspace).href }];
  const config = { id: projectId, projectResources: { resources: projectResources } };
  writeFileSync(join(projectDir, `${projectId}.json`), JSON.stringify(config));
}

test('Antigravity project binding must resolve one exact local workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-project-binding-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-workspace-'));
  const otherWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-other-workspace-'));
  try {
    writeAntigravityProject(profile, testProjectId, workspace);
    assert.equal(readAntigravityProjectBinding(testProjectId, workspace, { USERPROFILE: profile }),
      'PROJECT_WORKSPACE_MATCHED');
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

test('Antigravity project discovery uses one exact native workspace binding and fails closed', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-project-discovery-'));
  const workspace = mkdtempSync(join(tmpdir(), 'pty-agy-discovery-workspace-'));
  const otherWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-discovery-other-'));
  const staleWorkspace = mkdtempSync(join(tmpdir(), 'pty-agy-discovery-stale-'));
  const env = { USERPROFILE: profile };
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
  const help = '--project --print --output-format stream-json --model --effort --sandbox --mode accept-edits';
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
    assert.equal(antigravityV2ReadinessExecutionFailure(result), null);
    assert.deepEqual(calls.map(call => call.args), [
      [`--project=${testProjectId}`, '--version'],
      ['--help'],
      [`--project=${testProjectId}`, 'models'],
      [`--project=${testProjectId}`, '--print', '/usage'],
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
    assert.equal(result.inference_executed, false);
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
  const raw = [
    'Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-23T22:50:38Z',
    'Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T05:46:39Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-25T00:58:04Z',
  ].join('\n');
  const result = summarizeAntigravityUsage(raw);
  assert.deepEqual(result, { status: 'GEMINI_AGGREGATE_QUOTA_READ',
    source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
    weekly_reset_at: '2026-10-23T22:50:38Z', five_hour_remaining_percent: 99,
    five_hour_reset_at: '2026-10-18T05:46:39Z' });
  assert.equal(JSON.stringify(result).includes('Claude'), false);
  assert.equal(JSON.stringify(result).includes(raw), false);
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

test('Antigravity metadata readiness requires explicit no-G1 setting and leaves auth to the Worker gate', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    project_scope_evidence: 'PROJECT_WORKSPACE_MATCHED',
    effective_config_evidence: 'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: true,
    authentication_evidence: 'AUTHENTICATED_QUOTA_READ', tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      five_hour_remaining_percent: 99 } };
  assert.equal(antigravityV2ReadinessExecutionFailure(ready), null);
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'CREDIT_FALLBACK_DISABLED_BY_DEFAULT'}),
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
    assert.deepEqual(calls.map(c=>c.args),[['--version'],['--help'],['models'],['--print','/usage']]);
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
    assert.equal(r.gemini_aggregate_quota.status,'GEMINI_AGGREGATE_QUOTA_READ');
    assert.equal(r.authentication_checked,false);
    assert.equal(r.authentication_evidence,'LOGIN_REQUIRED');
    assert.ok(r.issues.includes('ANTIGRAVITY_AUTH_NOT_LOGGED_IN'));
    assert.equal(antigravityV2ReadinessExecutionFailure(r),'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(r.inference_executed,false);
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
  assert.equal(r.inference_executed,false);
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
  assert.equal(r.inference_executed,false);
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
  assert.equal(r.inference_executed,false);
  assert.notEqual(antigravityV2ReadinessExecutionFailure(r),null);
});

test('Antigravity readiness does not invent a model or effort option absent from real CLI help', () => {
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.1' : args[0]==='--help'
    ? '--print --output-format stream-json --sandbox'
    : 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{},()=>true);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.equal(r.model_flag_supported,false);
  assert.equal(r.effort_flag_supported,false);
  assert.equal(r.mode_flag_supported,false);
  assert.ok(r.issues.includes('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED'));
  assert.equal(r.inference_executed,false);
  assert.equal(r.authentication_checked,false);
  assert.equal(r.entitlement,'UNKNOWN');
  assert.equal(r.cost,'UNKNOWN');
});

test('Antigravity exact High model does not require the unrelated generic effort flag', () => {
  const profile=mkdtempSync(join(tmpdir(),'pty-agy-no-effort-'));
  const settingsDir=join(profile,'.gemini','antigravity-cli');
  mkdirSync(settingsDir,{recursive:true});
  writeFileSync(join(settingsDir,'settings.json'),JSON.stringify({useG1Credits:false}));
  const help='--print --output-format stream-json --model --sandbox --mode accept-edits';
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
  assert.equal(r.inference_executed,false);
});

test('Antigravity metadata commands never start before Google Authenticode verification', () => {
  let calls=0;
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),
    ()=>{calls++;return ''},{PATH:'clean'},()=>false);
  assert.equal(r.status,'ANTIGRAVITY_GOOGLE_SIGNATURE_NOT_VERIFIED');
  assert.equal(r.signature_verified,false);
  assert.equal(r.inference_executed,false);
  assert.equal(calls,0);
});

test('Antigravity readiness rejects a relative executable without launching commands', () => {
  let calls=0;
  const r=runAntigravityV2Readiness('agy.exe','C:\\workspace',()=>{calls++;return ''});
  assert.equal(calls,0);
  assert.equal(r.status,'READINESS_UNKNOWN');
  assert.deepEqual(r.issues,['ABSOLUTE_EXECUTABLE_AND_CWD_REQUIRED']);
  assert.equal(r.inference_executed,false);
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
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'DONE', step_type: 'agent_response', text_delta: 'done' } },
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
    assert.equal(result.tool_execution_count, 2);
    assert.equal(result.forbidden_tool_execution_evidence, 'NOT_OBSERVED');
    assert.equal(result.file_change_tool_completed_count, 1);
    assert.equal(result.file_change_tool_incomplete_count, 0);
    assert.equal(result.token_usage.total_tokens, 120);
    assert.equal(result.stdout_bytes, bytes.length);
    assert.equal(JSON.stringify(result).includes('PRIVATE_MODEL_RESPONSE'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TOOL_OUTPUT'), false);
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
      'C:\\Users\\other\\candidate')).reason, 'ANTIGRAVITY_JSONL_INVALID');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-medium'));
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_JSONL_INVALID');
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
