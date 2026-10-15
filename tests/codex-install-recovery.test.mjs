import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Codex executor installer resumes only exact owned artifacts after injected failures', {
  skip: process.platform !== 'win32',
}, () => {
  const script = fileURLToPath(new URL('./codex-executor-install-recovery.test.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(result.error, undefined, `PowerShell harness failed to start: ${result.error}`);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /INSTALL_RECOVERY_SYNTHETIC_TESTS=PASS/);
  assert.match(result.stdout, /TASK_SCHEDULER=MOCKED;MODEL_EXECUTION=NOT_RUN/);
});
