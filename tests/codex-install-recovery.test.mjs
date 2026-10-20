import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('Codex installer runtime file list contains the complete static module closure', async () => {
  const installerPath = fileURLToPath(new URL('../native-bridge/install-codex-executor.ps1', import.meta.url));
  const sourceRoot = dirname(installerPath);
  const script = readFileSync(installerPath, 'utf8');
  const declaration = script.match(/\$sourceNames\s*=\s*@\(([^)]*)\)/);
  assert.ok(declaration, 'installer must declare the exact files it stages');
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const staticLocalImportClosure = entry => {
    const found = new Set();
    const pending = [entry];
    while (pending.length) {
      const name = pending.pop();
      if (found.has(name)) continue;
      found.add(name);
      const source = readFileSync(join(sourceRoot, name), 'utf8');
      assert.doesNotMatch(source, /\bimport\s*\(/,
        `${name} must not add an unstaged dynamic import to the runtime bundle`);
      assert.doesNotMatch(source, /\brequire\s*\(/,
        `${name} must not add an unstaged CommonJS dependency to the runtime bundle`);
      for (const match of source.matchAll(/\bimport\s+['"]\.\/([^'"]+\.mjs)['"]/g))
        pending.push(match[1]);
      for (const match of source.matchAll(/\bfrom\s+['"]\.\/([^'"]+\.mjs)['"]/g))
        pending.push(match[1]);
    }
    return [...found].sort();
  };
  const expected = [...staticLocalImportClosure('codex-executor.mjs'), 'HiddenCodexExecutor.vbs'].sort();
  assert.deepEqual([...names].sort(), expected,
    'installer stages each runtime module in the executor static import closure and only its launcher');
  for (const required of ['codex-executor.mjs', 'codex-continuation.mjs',
    'captured-process.mjs', 'windows-executor.mjs', 'HiddenCodexExecutor.vbs'])
    assert.ok(names.includes(required), `installer staging list omits ${required}`);

  const runtimeDir = mkdtempSync(join(tmpdir(), 'pty-codex-runtime-import-'));
  try {
    for (const name of names) copyFileSync(join(sourceRoot, name), join(runtimeDir, name));
    const runtime = await import(pathToFileURL(join(runtimeDir, 'codex-executor.mjs')).href);
    assert.equal(typeof runtime.runExecutorOnce, 'function');
  } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
});
