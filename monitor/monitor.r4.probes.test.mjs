import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const [name, script, count] of [
  ['Independent production-build fault probes', 'monitor.r4.fault-probes.mjs', 13],
  ['Offline DOM / boss-page semantic probes', 'monitor.r4.ui-probes.mjs', 5]
]) {
  test(name, () => {
    const result = spawnSync(process.execPath, [script], { cwd: import.meta.dirname, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.rows.length, count);
    assert.equal(report.fail, 0, JSON.stringify(report.rows.filter(r => !r.pass)));
    assert.equal(report.pass, count);
  });
}
