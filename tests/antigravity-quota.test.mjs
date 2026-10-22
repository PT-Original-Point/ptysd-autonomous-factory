import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAntigravityQuotaSnapshot } from '../native-bridge/antigravity-quota.mjs';

function makeValidUsageEnvelope(overrides = {}) {
  return {
    status: 'SUCCESS',
    conversation_id: 'conv-test-12345',
    response: 'Command /usage executed successfully',
    usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 },
    command: {
      name: '/usage',
      status: 'SUCCESS',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                remaining_fraction: 0.95,
                reset_time: '2026-10-23T22:50:38Z',
              },
              {
                id: 'gemini-5h',
                remaining_fraction: 0.99,
                reset_time: '2026-10-18T05:46:39Z',
              },
            ],
          },
        ],
      },
    },
    ...overrides,
  };
}

function makeValidCreditsEnvelope(overrides = {}) {
  return {
    status: 'SUCCESS',
    conversation_id: 'conv-test-67890',
    response: 'Command /credits executed successfully',
    command: {
      name: '/credits',
      status: 'SUCCESS',
      data: {
        remaining_credits: 1500,
      },
    },
    ...overrides,
  };
}

const DOCUMENTED_NORMALIZED_FIELDS = Object.freeze([
  'g1_credits_remaining',
  'gemini_5h_remaining_fraction',
  'gemini_5h_reset_time',
  'gemini_weekly_remaining_fraction',
  'gemini_weekly_reset_time',
  'schema',
]);

test('positive: parses canonical usage and credits envelopes into normalized snapshot', () => {
  const usage = makeValidUsageEnvelope();
  const credits = makeValidCreditsEnvelope();
  const snapshot = parseAntigravityQuotaSnapshot(usage, credits);

  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.gemini_weekly_remaining_fraction, 0.95);
  assert.equal(snapshot.gemini_weekly_reset_time, '2026-10-23T22:50:38.000Z');
  assert.equal(snapshot.gemini_5h_remaining_fraction, 0.99);
  assert.equal(snapshot.gemini_5h_reset_time, '2026-10-18T05:46:39.000Z');
  assert.equal(snapshot.g1_credits_remaining, 1500);
});

test('positive: ignores extra unrelated groups, buckets, and arbitrary metadata fields', () => {
  const usage = makeValidUsageEnvelope({
    account: { id: 'acct_9999', email: 'operator@internal.domain' },
    provider: 'google',
    extra_root_field: 'arbitrary_metadata',
  });
  usage.command.data.groups.push(
    {
      name: 'Claude Models',
      buckets: [
        { id: 'claude-weekly', remaining_fraction: 0.5, reset_time: '2026-10-25T00:00:00Z' },
      ],
    },
    {
      name: 'Experimental Quotas',
      buckets: [
        { id: 'exp-bucket', remaining_fraction: 0.1, reset_time: '2026-10-26T00:00:00Z' },
      ],
    },
  );
  usage.command.data.groups[0].buckets.push({
    id: 'gemini-experimental',
    remaining_fraction: 0.75,
    reset_time: '2026-10-24T12:00:00Z',
  });
  usage.command.data.groups[0].buckets[0].quota_limit = 100000;
  usage.command.data.groups[0].buckets[0].consumed = 5000;

  const credits = makeValidCreditsEnvelope({
    billing_plan: 'enterprise_tier',
    account_identity: 'user_abcdef',
    payment_status: 'CURRENT',
  });
  credits.command.data.credit_type = 'g1_subscription';
  credits.command.data.last_refill = '2026-10-01T00:00:00Z';

  const snapshot = parseAntigravityQuotaSnapshot(usage, credits);

  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.gemini_weekly_remaining_fraction, 0.95);
  assert.equal(snapshot.gemini_5h_remaining_fraction, 0.99);
  assert.equal(snapshot.g1_credits_remaining, 1500);
});

test('positive: proof that returned snapshot contains strictly only the documented normalized fields', () => {
  const usage = makeValidUsageEnvelope();
  const credits = makeValidCreditsEnvelope();
  const snapshot = parseAntigravityQuotaSnapshot(usage, credits);

  const ownKeys = Object.keys(snapshot).sort();
  assert.deepEqual(ownKeys, [...DOCUMENTED_NORMALIZED_FIELDS].sort());

  const ownPropertyNames = Object.getOwnPropertyNames(snapshot).sort();
  assert.deepEqual(ownPropertyNames, [...DOCUMENTED_NORMALIZED_FIELDS].sort());

  const forbiddenKeys = [
    'conversation_id',
    'response',
    'usage',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'account',
    'groups',
    'buckets',
    'provider',
    'status',
    'command',
    'remaining_credits',
  ];
  for (const key of forbiddenKeys) {
    assert.equal(Object.hasOwn(snapshot, key), false, `Snapshot must not contain field: ${key}`);
  }
});

test('positive: normalizes timestamp formats with offsets and milliseconds to UTC ISO-8601', () => {
  const usage = makeValidUsageEnvelope();
  usage.command.data.groups[0].buckets[0].reset_time = '2026-10-23T18:50:38-04:00';
  usage.command.data.groups[0].buckets[1].reset_time = '2026-10-18T05:46:39.123Z';

  const snapshot = parseAntigravityQuotaSnapshot(usage, makeValidCreditsEnvelope());
  assert.equal(snapshot.gemini_weekly_reset_time, '2026-10-23T22:50:38.000Z');
  assert.equal(snapshot.gemini_5h_reset_time, '2026-10-18T05:46:39.123Z');
});

test('positive: accepts boundary values for fractions and safe integer credits', () => {
  const usageZero = makeValidUsageEnvelope();
  usageZero.command.data.groups[0].buckets[0].remaining_fraction = 0;
  usageZero.command.data.groups[0].buckets[1].remaining_fraction = 1;

  const creditsZero = makeValidCreditsEnvelope();
  creditsZero.command.data.remaining_credits = 0;

  const snapshotZero = parseAntigravityQuotaSnapshot(usageZero, creditsZero);
  assert.equal(snapshotZero.gemini_weekly_remaining_fraction, 0);
  assert.equal(snapshotZero.gemini_5h_remaining_fraction, 1);
  assert.equal(snapshotZero.g1_credits_remaining, 0);

  const creditsMax = makeValidCreditsEnvelope();
  creditsMax.command.data.remaining_credits = Number.MAX_SAFE_INTEGER;
  const snapshotMax = parseAntigravityQuotaSnapshot(usageZero, creditsMax);
  assert.equal(snapshotMax.g1_credits_remaining, Number.MAX_SAFE_INTEGER);
});

test('positive: accepts JSON string inputs and does not mutate input objects', () => {
  const usageObj = makeValidUsageEnvelope();
  const creditsObj = makeValidCreditsEnvelope();
  const usageCopy = JSON.parse(JSON.stringify(usageObj));
  const creditsCopy = JSON.parse(JSON.stringify(creditsObj));

  const snapshotFromObjects = parseAntigravityQuotaSnapshot(usageObj, creditsObj);
  assert.deepEqual(usageObj, usageCopy, 'Usage envelope must not be mutated');
  assert.deepEqual(creditsObj, creditsCopy, 'Credits envelope must not be mutated');

  const snapshotFromStrings = parseAntigravityQuotaSnapshot(
    JSON.stringify(usageObj),
    JSON.stringify(creditsObj),
  );
  assert.deepEqual(snapshotFromStrings, snapshotFromObjects);
});

test('positive: accepts object map representation for groups and buckets', () => {
  const usageMap = {
    status: 'SUCCESS',
    command: {
      name: '/usage',
      status: 'SUCCESS',
      data: {
        groups: {
          'Gemini Models': {
            buckets: {
              'gemini-weekly': {
                remaining_fraction: 0.8,
                reset_time: '2026-10-23T22:50:38Z',
              },
              'gemini-5h': {
                remaining_fraction: 0.65,
                reset_time: '2026-10-18T05:46:39Z',
              },
            },
          },
        },
      },
    },
  };
  const snapshot = parseAntigravityQuotaSnapshot(usageMap, makeValidCreditsEnvelope());
  assert.equal(snapshot.gemini_weekly_remaining_fraction, 0.8);
  assert.equal(snapshot.gemini_5h_remaining_fraction, 0.65);
});

test('negative: rejects non-success usage envelopes with stable short code', () => {
  const badStatuses = ['ERROR', 'FAILED', 'UNAUTHENTICATED', 'UNKNOWN', ''];
  for (const status of badStatuses) {
    const usage = makeValidUsageEnvelope({ status });
    assert.throws(
      () => parseAntigravityQuotaSnapshot(usage, makeValidCreditsEnvelope()),
      err => err.message === 'NON_SUCCESS_ENVELOPE' && err.code === 'NON_SUCCESS_ENVELOPE',
    );
  }

  const missingUsageStatus = makeValidUsageEnvelope();
  delete missingUsageStatus.status;
  assert.throws(
    () => parseAntigravityQuotaSnapshot(missingUsageStatus, makeValidCreditsEnvelope()),
    err => err.message === 'NON_SUCCESS_ENVELOPE' && err.code === 'NON_SUCCESS_ENVELOPE',
  );

  const missingCommandStatus = makeValidUsageEnvelope();
  delete missingCommandStatus.command.status;
  assert.throws(
    () => parseAntigravityQuotaSnapshot(missingCommandStatus, makeValidCreditsEnvelope()),
    err => err.message === 'NON_SUCCESS_ENVELOPE' && err.code === 'NON_SUCCESS_ENVELOPE',
  );

  const usageCommandError = makeValidUsageEnvelope();
  usageCommandError.command.status = 'ERROR';
  assert.throws(
    () => parseAntigravityQuotaSnapshot(usageCommandError, makeValidCreditsEnvelope()),
    /NON_SUCCESS_ENVELOPE/,
  );

  const usageWithErrorField = makeValidUsageEnvelope({ error: { code: 'DENIED' } });
  assert.throws(
    () => parseAntigravityQuotaSnapshot(usageWithErrorField, makeValidCreditsEnvelope()),
    /NON_SUCCESS_ENVELOPE/,
  );

  for (const badInput of [null, undefined, '', 'not json', 42, true, [], {}]) {
    assert.throws(
      () => parseAntigravityQuotaSnapshot(badInput, makeValidCreditsEnvelope()),
      /NON_SUCCESS_ENVELOPE/,
    );
  }
});

test('negative: rejects non-success credits envelopes with stable short code', () => {
  const badStatuses = ['ERROR', 'FAILED', 'RATE_LIMITED', ''];
  for (const status of badStatuses) {
    const credits = makeValidCreditsEnvelope({ status });
    assert.throws(
      () => parseAntigravityQuotaSnapshot(makeValidUsageEnvelope(), credits),
      err => err.message === 'NON_SUCCESS_ENVELOPE' && err.code === 'NON_SUCCESS_ENVELOPE',
    );
  }

  const creditsCommandError = makeValidCreditsEnvelope();
  creditsCommandError.command.status = 'ERROR';
  assert.throws(
    () => parseAntigravityQuotaSnapshot(makeValidUsageEnvelope(), creditsCommandError),
    /NON_SUCCESS_ENVELOPE/,
  );

  for (const badInput of [null, undefined, '', 'not json', 123, false, [], {}]) {
    assert.throws(
      () => parseAntigravityQuotaSnapshot(makeValidUsageEnvelope(), badInput),
      /NON_SUCCESS_ENVELOPE/,
    );
  }
});

test('negative: rejects missing required buckets or missing Gemini group', () => {
  const noGeminiGroup = makeValidUsageEnvelope();
  noGeminiGroup.command.data.groups = [
    { name: 'Claude Models', buckets: [{ id: 'claude-1', remaining_fraction: 0.5, reset_time: '2026-10-23T00:00:00Z' }] },
  ];
  assert.throws(
    () => parseAntigravityQuotaSnapshot(noGeminiGroup, makeValidCreditsEnvelope()),
    err => err.message === 'MISSING_REQUIRED_BUCKET' && err.code === 'MISSING_REQUIRED_BUCKET',
  );

  const emptyGroups = makeValidUsageEnvelope();
  emptyGroups.command.data.groups = [];
  assert.throws(
    () => parseAntigravityQuotaSnapshot(emptyGroups, makeValidCreditsEnvelope()),
    /MISSING_REQUIRED_BUCKET/,
  );

  const missingWeekly = makeValidUsageEnvelope();
  missingWeekly.command.data.groups[0].buckets = [
    { id: 'gemini-5h', remaining_fraction: 0.9, reset_time: '2026-10-18T05:46:39Z' },
  ];
  assert.throws(
    () => parseAntigravityQuotaSnapshot(missingWeekly, makeValidCreditsEnvelope()),
    /MISSING_REQUIRED_BUCKET/,
  );

  const missing5h = makeValidUsageEnvelope();
  missing5h.command.data.groups[0].buckets = [
    { id: 'gemini-weekly', remaining_fraction: 0.9, reset_time: '2026-10-23T22:50:38Z' },
  ];
  assert.throws(
    () => parseAntigravityQuotaSnapshot(missing5h, makeValidCreditsEnvelope()),
    /MISSING_REQUIRED_BUCKET/,
  );
});

test('negative: rejects duplicate required buckets or groups', () => {
  const duplicateWeekly = makeValidUsageEnvelope();
  duplicateWeekly.command.data.groups[0].buckets.push({
    id: 'gemini-weekly',
    remaining_fraction: 0.8,
    reset_time: '2026-10-23T22:50:38Z',
  });
  assert.throws(
    () => parseAntigravityQuotaSnapshot(duplicateWeekly, makeValidCreditsEnvelope()),
    err => err.message === 'DUPLICATE_REQUIRED_BUCKET' && err.code === 'DUPLICATE_REQUIRED_BUCKET',
  );

  const duplicate5h = makeValidUsageEnvelope();
  duplicate5h.command.data.groups[0].buckets.push({
    id: 'gemini-5h',
    remaining_fraction: 0.85,
    reset_time: '2026-10-18T05:46:39Z',
  });
  assert.throws(
    () => parseAntigravityQuotaSnapshot(duplicate5h, makeValidCreditsEnvelope()),
    /DUPLICATE_REQUIRED_BUCKET/,
  );

  const duplicateGeminiGroup = makeValidUsageEnvelope();
  duplicateGeminiGroup.command.data.groups.push(
    JSON.parse(JSON.stringify(duplicateGeminiGroup.command.data.groups[0])),
  );
  assert.throws(
    () => parseAntigravityQuotaSnapshot(duplicateGeminiGroup, makeValidCreditsEnvelope()),
    /DUPLICATE_REQUIRED_BUCKET/,
  );

  const duplicateGroupAliases = makeValidUsageEnvelope();
  const originalGeminiGroup = duplicateGroupAliases.command.data.groups[0];
  duplicateGroupAliases.command.data.groups = {
    'Gemini Models': originalGeminiGroup,
    'gemini-models': originalGeminiGroup,
  };
  assert.throws(
    () => parseAntigravityQuotaSnapshot(duplicateGroupAliases, makeValidCreditsEnvelope()),
    err => err.message === 'DUPLICATE_REQUIRED_BUCKET' && err.code === 'DUPLICATE_REQUIRED_BUCKET',
  );

  const duplicateBucketAliases = makeValidUsageEnvelope();
  duplicateBucketAliases.command.data.groups = {
    'Gemini Models': {
      buckets: {
        'gemini-weekly': { remaining_fraction: 0.9, reset_time: '2026-10-23T22:50:38Z' },
        gemini_weekly: { remaining_fraction: 0.8, reset_time: '2026-10-23T22:50:38Z' },
        'gemini-5h': { remaining_fraction: 0.9, reset_time: '2026-10-18T05:46:39Z' },
      },
    },
  };
  assert.throws(
    () => parseAntigravityQuotaSnapshot(duplicateBucketAliases, makeValidCreditsEnvelope()),
    err => err.message === 'DUPLICATE_REQUIRED_BUCKET' && err.code === 'DUPLICATE_REQUIRED_BUCKET',
  );
});

test('negative: rejects non-finite or out-of-range fractions', () => {
  const invalidFractions = [-0.01, -1, 1.001, 2, NaN, Infinity, -Infinity, '0.5', null, undefined, {}];
  for (const fraction of invalidFractions) {
    const usage = makeValidUsageEnvelope();
    usage.command.data.groups[0].buckets[0].remaining_fraction = fraction;
    assert.throws(
      () => parseAntigravityQuotaSnapshot(usage, makeValidCreditsEnvelope()),
      err => err.message === 'INVALID_FRACTION' && err.code === 'INVALID_FRACTION',
    );
  }
});

test('negative: rejects invalid reset timestamps', () => {
  const invalidTimestamps = ['not-a-timestamp', '', '   ', '2026-99-99T99:99:99Z', Number.MAX_VALUE, 8.64e15 + 1, null, undefined, true, {}];
  for (const reset_time of invalidTimestamps) {
    const usage = makeValidUsageEnvelope();
    usage.command.data.groups[0].buckets[0].reset_time = reset_time;
    assert.throws(
      () => parseAntigravityQuotaSnapshot(usage, makeValidCreditsEnvelope()),
      err => err.message === 'INVALID_TIMESTAMP' && err.code === 'INVALID_TIMESTAMP',
    );
  }
});

test('negative: rejects negative or non-safe-integer credit values', () => {
  const invalidCredits = [-1, -500, 10.5, 0.1, NaN, Infinity, -Infinity, '1500', Number.MAX_SAFE_INTEGER + 10, null, undefined, {}];
  for (const credits of invalidCredits) {
    const creditsEnv = makeValidCreditsEnvelope();
    creditsEnv.command.data.remaining_credits = credits;
    assert.throws(
      () => parseAntigravityQuotaSnapshot(makeValidUsageEnvelope(), creditsEnv),
      err => err.message === 'INVALID_CREDITS' && err.code === 'INVALID_CREDITS',
    );
  }
});

test('negative: error messages use stable short codes and never leak raw input or credentials', () => {
  const sensitiveCredential = 'bearer-token-secret-credential-value-999';
  const sensitiveEmail = 'admin@confidential.corp';

  const usageWithSecrets = makeValidUsageEnvelope();
  usageWithSecrets.command.data.groups[0].buckets[0].remaining_fraction = -100;
  usageWithSecrets.command.data.groups[0].buckets[0].secret_token = sensitiveCredential;

  const creditsWithSecrets = makeValidCreditsEnvelope();
  creditsWithSecrets.command.data.remaining_credits = -999;
  creditsWithSecrets.command.data.email = sensitiveEmail;

  try {
    parseAntigravityQuotaSnapshot(usageWithSecrets, creditsWithSecrets);
    assert.fail('Expected parse to throw');
  } catch (error) {
    assert.equal(error.message, 'INVALID_FRACTION');
    assert.equal(error.message.includes(sensitiveCredential), false);
    assert.equal(error.message.includes(sensitiveEmail), false);
    assert.equal(error.message.includes('-100'), false);
  }

  const validUsage = makeValidUsageEnvelope();
  try {
    parseAntigravityQuotaSnapshot(validUsage, creditsWithSecrets);
    assert.fail('Expected parse to throw');
  } catch (error) {
    assert.equal(error.message, 'INVALID_CREDITS');
    assert.equal(error.message.includes(sensitiveCredential), false);
    assert.equal(error.message.includes(sensitiveEmail), false);
    assert.equal(error.message.includes('-999'), false);
  }
});
