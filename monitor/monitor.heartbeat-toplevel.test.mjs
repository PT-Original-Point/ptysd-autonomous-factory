import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAutomations } from './server.mjs';

const PREFIX = 'mon-toplevel-';

function safeCleanup(target) {
  if (!target) return;
  const realTarget = fs.realpathSync(target);
  const realTmp = fs.realpathSync(os.tmpdir());
  if (path.dirname(realTarget) === realTmp && path.basename(realTarget).startsWith(PREFIX)) {
    fs.rmSync(realTarget, { recursive: true, force: true });
  }
}

test('scanAutomations: top-level lexical scoping excludes prompt multiline strings and nested tables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const ws = path.join(root, 'workspace');
  const auto = path.join(root, 'automations');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(auto, { recursive: true });

  const mk = (name, toml) => {
    const d = path.join(auto, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'automation.toml'), toml, 'utf8');
  };

  try {
    mk('real-heartbeat', [
      'kind = "heartbeat"',
      'target_thread_id = "thread-123"',
      'status = "ACTIVE"'
    ].join('\n'));

    mk('prompt-multiline-basic', [
      'prompt = """',
      'kind = "heartbeat"',
      'target_thread_id = "thread-123"',
      '"""',
      'status = "ACTIVE"'
    ].join('\n'));

    mk('prompt-multiline-literal', [
      "prompt = '''",
      "kind = 'heartbeat'",
      "target_thread_id = 'thread-123'",
      "'''",
      'status = "ACTIVE"'
    ].join('\n'));

    mk('nested-table', [
      '[nested]',
      'kind = "heartbeat"',
      'target_thread_id = "thread-123"',
      'status = "ACTIVE"'
    ].join('\n'));

    mk('nested-array-table', [
      '[[tasks]]',
      'kind = "heartbeat"',
      'target_thread_id = "thread-123"',
      'status = "ACTIVE"'
    ].join('\n'));

    const res = scanAutomations(auto, ws, 'thread-123');
    const matchedNames = res.automations.map(a => a.name);
    assert.deepEqual(matchedNames, ['real-heartbeat']);
    assert.equal(res.status, 'MONITORING');
    assert.equal(res.automations[0].status, 'MONITORING');
  } finally {
    safeCleanup(root);
  }
});
