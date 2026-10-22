// Pure JavaScript parser for saved Antigravity CLI quota and credit snapshots.
// This module never invokes CLI commands, contacts a provider, or reads credentials.

function createQuotaError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseEnvelopeJson(envelope) {
  if (typeof envelope === 'string') {
    try {
      return JSON.parse(envelope);
    } catch {
      throw createQuotaError('NON_SUCCESS_ENVELOPE');
    }
  }
  return envelope;
}

function assertSuccessEnvelope(envelope, expectedCommandName) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw createQuotaError('NON_SUCCESS_ENVELOPE');
  }
  if (envelope.status !== 'SUCCESS') {
    throw createQuotaError('NON_SUCCESS_ENVELOPE');
  }
  if (envelope.success !== undefined && envelope.success !== true) {
    throw createQuotaError('NON_SUCCESS_ENVELOPE');
  }
  if (envelope.command && typeof envelope.command === 'object' && !Array.isArray(envelope.command)) {
    if (envelope.command.status !== 'SUCCESS') {
      throw createQuotaError('NON_SUCCESS_ENVELOPE');
    }
    if (envelope.command.error !== undefined && envelope.command.error !== null) {
      throw createQuotaError('NON_SUCCESS_ENVELOPE');
    }
  }
  if (envelope.error !== undefined && envelope.error !== null) {
    throw createQuotaError('NON_SUCCESS_ENVELOPE');
  }
  if (!envelope.command || typeof envelope.command !== 'object' || Array.isArray(envelope.command) ||
      !envelope.command.data || typeof envelope.command.data !== 'object' || Array.isArray(envelope.command.data)) {
    throw createQuotaError('NON_SUCCESS_ENVELOPE');
  }
  if (envelope.command.name !== expectedCommandName) {
    throw createQuotaError('NON_SUCCESS_ENVELOPE');
  }
}

function formatUtcTimestamp(milliseconds) {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw createQuotaError('INVALID_TIMESTAMP');
  return date.toISOString();
}

function normalizeUtcTimestamp(val) {
  if (typeof val === 'string') {
    if (!val.trim()) throw createQuotaError('INVALID_TIMESTAMP');
    const ms = Date.parse(val);
    if (!Number.isFinite(ms)) throw createQuotaError('INVALID_TIMESTAMP');
    return formatUtcTimestamp(ms);
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) throw createQuotaError('INVALID_TIMESTAMP');
    return formatUtcTimestamp(val);
  }
  if (val instanceof Date) {
    if (!Number.isFinite(val.getTime())) throw createQuotaError('INVALID_TIMESTAMP');
    return val.toISOString();
  }
  throw createQuotaError('INVALID_TIMESTAMP');
}

function validateFraction(val) {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
    throw createQuotaError('INVALID_FRACTION');
  }
  return val;
}

function validateCredits(val) {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
    throw createQuotaError('INVALID_CREDITS');
  }
  return val;
}

export function parseAntigravityQuotaSnapshot(usageEnvelopeInput, creditsEnvelopeInput) {
  const usageEnvelope = parseEnvelopeJson(usageEnvelopeInput);
  const creditsEnvelope = parseEnvelopeJson(creditsEnvelopeInput);

  assertSuccessEnvelope(usageEnvelope, '/usage');
  assertSuccessEnvelope(creditsEnvelope, '/credits');

  const groups = usageEnvelope.command.data.groups;
  if (!groups || typeof groups !== 'object') {
    throw createQuotaError('MISSING_REQUIRED_BUCKET');
  }

  let geminiGroup = null;
  if (Array.isArray(groups)) {
    const matches = groups.filter(g =>
      g && typeof g === 'object' &&
      (g.name === 'Gemini Models' || g.id === 'Gemini Models' || g.group === 'Gemini Models')
    );
    if (matches.length === 0) {
      throw createQuotaError('MISSING_REQUIRED_BUCKET');
    }
    if (matches.length > 1) {
      throw createQuotaError('DUPLICATE_REQUIRED_BUCKET');
    }
    geminiGroup = matches[0];
  } else {
    const geminiGroupKeys = ['Gemini Models', 'gemini-models', 'gemini_models']
      .filter(key => Object.hasOwn(groups, key));
    if (geminiGroupKeys.length === 0) {
      throw createQuotaError('MISSING_REQUIRED_BUCKET');
    }
    if (geminiGroupKeys.length > 1) {
      throw createQuotaError('DUPLICATE_REQUIRED_BUCKET');
    }
    geminiGroup = groups[geminiGroupKeys[0]];
    if (!geminiGroup || typeof geminiGroup !== 'object') {
      throw createQuotaError('MISSING_REQUIRED_BUCKET');
    }
  }

  const rawBuckets = geminiGroup.buckets ?? geminiGroup;
  const weeklyMatches = [];
  const fiveHourMatches = [];

  if (Array.isArray(rawBuckets)) {
    for (const b of rawBuckets) {
      if (!b || typeof b !== 'object') continue;
      const id = b.id ?? b.name ?? b.bucket ?? b.bucket_id ?? b.key;
      if (id === 'gemini-weekly' || id === 'gemini_weekly') {
        weeklyMatches.push(b);
      } else if (id === 'gemini-5h' || id === 'gemini_5h') {
        fiveHourMatches.push(b);
      }
    }
  } else if (rawBuckets && typeof rawBuckets === 'object') {
    const weeklyKeys = ['gemini-weekly', 'gemini_weekly']
      .filter(key => Object.hasOwn(rawBuckets, key));
    const fiveHourKeys = ['gemini-5h', 'gemini_5h']
      .filter(key => Object.hasOwn(rawBuckets, key));
    weeklyMatches.push(...weeklyKeys.map(key => rawBuckets[key]));
    fiveHourMatches.push(...fiveHourKeys.map(key => rawBuckets[key]));
  } else {
    throw createQuotaError('MISSING_REQUIRED_BUCKET');
  }

  if (weeklyMatches.length === 0 || fiveHourMatches.length === 0) {
    throw createQuotaError('MISSING_REQUIRED_BUCKET');
  }
  if (weeklyMatches.length > 1 || fiveHourMatches.length > 1) {
    throw createQuotaError('DUPLICATE_REQUIRED_BUCKET');
  }

  const weeklyBucket = weeklyMatches[0];
  const fiveHourBucket = fiveHourMatches[0];

  const weeklyRemainingFraction = validateFraction(weeklyBucket.remaining_fraction);
  const weeklyResetTime = normalizeUtcTimestamp(weeklyBucket.reset_time);

  const fiveHourRemainingFraction = validateFraction(fiveHourBucket.remaining_fraction);
  const fiveHourResetTime = normalizeUtcTimestamp(fiveHourBucket.reset_time);

  const credits = validateCredits(creditsEnvelope.command.data.remaining_credits);

  return {
    schema: 1,
    gemini_weekly_remaining_fraction: weeklyRemainingFraction,
    gemini_weekly_reset_time: weeklyResetTime,
    gemini_5h_remaining_fraction: fiveHourRemainingFraction,
    gemini_5h_reset_time: fiveHourResetTime,
    g1_credits_remaining: credits,
  };
}
