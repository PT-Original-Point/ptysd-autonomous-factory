import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = readFileSync(new URL('../governance/v51/VNEXT5.1-R1-CANONICAL-RECOVERY-SPEC-20260929.md', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../governance/v51/VNEXT5.1-R1-CODEX-PRIMARY-EXECUTION-POLICY-20260929.json', import.meta.url), 'utf8');
const combined = spec + '\n' + policy;

const legacy = [
  'CHAT_CAN_DO',
  'DIRECT_NATIVE_CAPABILITY_PRECEDENCE',
  'CODEX_LAST_MILE',
  'Chat 能做就不得委派',
  'Chat 優先施工',
];

test('V5.1-R1 active executor policy contains no legacy Chat-first routing tokens', () => {
  for (const token of legacy) {
    assert.equal(combined.includes(token), false, `legacy routing token resurrected: ${token}`);
  }
});

test('V5.1-R1 declares Codex-primary substantial-work routing', () => {
  assert.match(combined, /CODEX_PRIMARY/);
  assert.match(combined, /SUBSTANTIAL_OR_LONG_RUNNING_WORK/);
  assert.match(combined, /CONTROL_REVIEW_SHORT_READBACK_HUMAN_INTERFACE/);
});
