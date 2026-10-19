import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, 'native-bridge');
const installer = readFileSync(join(sourceDir, 'install.ps1'), 'utf8');
const installIndex = installer.indexOf("if ($Mode -eq 'Install')");
assert.notEqual(installIndex, -1, 'installer has an explicit install mode');
const installBlock = installer.slice(installIndex);

function staticLocalImportClosure(entry) {
  const found = new Set();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (found.has(name)) continue;
    found.add(name);
    const source = readFileSync(join(sourceDir, name), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]\.\/([^'"]+\.mjs)['"]/g))
      pending.push(match[1]);
  }
  return [...found].sort();
}

const required = staticLocalImportClosure('worker.mjs');
const bundleBlock = installer.match(/\$runtimeFiles\s*=\s*@\(([\s\S]*?)\)/i);
assert.ok(bundleBlock, 'installer declares its complete worker runtime file bundle');
const bundled = [...bundleBlock[1].matchAll(/['"]([^'"]+\.mjs)['"]/g)]
  .map(match => match[1]).sort();
assert.deepEqual(bundled, required,
  'installed worker runtime contains the exact recursive static import closure');
assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$sourcePath\s+-Destination\s+\$targetPath/i,
  'installer copies each declared module to the runtime directory');
assert.match(installer, /Get-FileHash[\s\S]*?\$sourcePath[\s\S]*?Get-FileHash[\s\S]*?\$targetPath/i,
  'installer verifies source and destination hashes for each module');
assert.match(installer, /--check\s+\$targetPath/i,
  'installer syntax-checks each copied module before task registration');
assert.match(installer, /\$hiddenWorkerSha256\s*=\s*'BEB20341D759C4F6380A62197AB0FAD79B2F0D0B52798BFBF734346A05B82A89'/i,
  'installer pins the already validated HiddenWorker.vbs bytes');
assert.match(installer, /\[regex\]::Match\(\$wrapperText/i,
  'installer reads the Node executable from the validated wrapper instead of resolving another PATH binary');
assert.match(installer, /\$node\s*=\s*\$nodeMatch\.Groups\[1\]\.Value/i,
  'syntax checks use the same Node executable that the scheduled wrapper launches');
assert.doesNotMatch(installBlock, /\$node\s*=\s*Require-Command\s+'node\.exe'/i,
  'a different PATH Node binary cannot be mistaken for the deployed runtime');
assert.match(installer, /New-ScheduledTaskAction\s+-Execute\s+\$wscript\s+-Argument\s+\$argsLine/i,
  'scheduled action invokes the validated hidden Windows Script Host wrapper');
assert.doesNotMatch(installer, /New-ScheduledTaskAction\s+-Execute\s+\$node\b/i,
  'installer never registers a visible Node console action');
assert.match(installer, /Arguments\s+-ne\s+\$argsLine/i,
  'task readback verifies the exact wrapper arguments');
