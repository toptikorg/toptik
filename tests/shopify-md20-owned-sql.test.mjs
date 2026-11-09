import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('isolated PostgreSQL: owner lease, atomicity, exact colors and editorial guards', {timeout:60000}, () => {
  const engine=path.join(process.cwd(),'node_modules','@electric-sql','pglite');
  const result=spawnSync(process.execPath,['scripts/verify-md20-owned-projection.mjs',engine],{encoding:'utf8',timeout:55000,maxBuffer:2_000_000});
  assert.equal(result.status,0,result.stderr?.slice(-4000) || result.error?.message || 'SQL regression did not finish');
  assert.match(result.stdout,/PASS: legacy self-lock reproduced/);
});
