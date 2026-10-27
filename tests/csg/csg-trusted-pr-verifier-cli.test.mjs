import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyDirectParent} from '../../governance/csg/trust-root/csg-trusted-pr-verifier.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const verifier=path.resolve(here,'../../governance/csg/trust-root/csg-trusted-pr-verifier.mjs');

test('trusted verifier CLI entrypoint executes on this platform',()=>{
  const r=spawnSync(process.execPath,[verifier],{encoding:'utf8'});
  assert.equal(r.status,2);
  const line=(r.stderr||'').trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line,'expected verifier failure JSON on stderr');
  const out=JSON.parse(line);
  assert.equal(out.result,'FAIL');
  assert.equal(out.code,'ERR_INVALID_ARG_TYPE');
});

test('trusted direct-parent regression: candidate commit must be single direct child of base SHA', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'csg-direct-parent-test-'));
  try {
    const git = (args) => execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'PR Verifier Test',
        GIT_AUTHOR_EMAIL: 'verifier-test@example.com',
        GIT_COMMITTER_NAME: 'PR Verifier Test',
        GIT_COMMITTER_EMAIL: 'verifier-test@example.com',
      },
    }).trim();

    git(['init']);
    git(['config', 'user.name', 'PR Verifier Test']);
    git(['config', 'user.email', 'verifier-test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'core.autocrlf', 'false']);

    // Create a base commit
    writeFileSync(path.join(repo, 'base.txt'), 'base commit\n', 'utf8');
    git(['add', 'base.txt']);
    git(['commit', '-m', 'base commit']);
    const baseOid = git(['rev-parse', 'HEAD']);

    // Create candidate 1: sole parent is exactly the base SHA and changed path is allowed for main
    git(['checkout', '-b', 'candidate-1', baseOid]);
    writeFileSync(path.join(repo, 'candidate-change.txt'), 'candidate change allowed for main\n', 'utf8');
    git(['add', 'candidate-change.txt']);
    git(['commit', '-m', 'candidate 1 commit']);
    const headOid1 = git(['rev-parse', 'HEAD']);

    // Assert verifyDirectParent accepts it and returns exact base/head SHAs and changed path count
    const accepted = verifyDirectParent({
      repo,
      baseOid,
      headOid: headOid1,
      baseRef: 'main',
    });
    assert.equal(accepted.baseOid, baseOid);
    assert.equal(accepted.headOid, headOid1);
    assert.equal(accepted.count, 1);
    assert.deepEqual(accepted.paths, ['candidate-change.txt']);
    assert.equal(accepted.baseRef, 'main');

    // Create candidate 2 with two commits after that same base
    git(['checkout', '-b', 'candidate-2', baseOid]);
    writeFileSync(path.join(repo, 'candidate-2-step1.txt'), 'step 1\n', 'utf8');
    git(['add', 'candidate-2-step1.txt']);
    git(['commit', '-m', 'candidate 2 step 1']);

    writeFileSync(path.join(repo, 'candidate-2-step2.txt'), 'step 2\n', 'utf8');
    git(['add', 'candidate-2-step2.txt']);
    git(['commit', '-m', 'candidate 2 step 2']);
    const headOid2 = git(['rev-parse', 'HEAD']);

    // Assert verifyDirectParent fails with DIRECT_PARENT_MISMATCH
    assert.throws(
      () => verifyDirectParent({
        repo,
        baseOid,
        headOid: headOid2,
        baseRef: 'main',
      }),
      {
        code: 'DIRECT_PARENT_MISMATCH',
      }
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
