// Portable, offline second pass of the existing queue regression suites.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const engine = path.join(root, 'node_modules', '@electric-sql', 'pglite');
if (!existsSync(path.join(engine, 'dist', 'index.js'))) {
  throw new Error('The installed local PGlite engine is required; do not silently skip queue upgrade tests.');
}
const suites = [
  'media-queue-failed-backoff', 'media-queue-priority', 'media-queue-defer',
  'media-liveness-sql', 'media-storage-attempt-retire',
].map(name => `tests/${name}.test.mjs`);
const result = spawnSync(process.execPath, ['--test', ...suites], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TOPTIK_PGLITE_DIR: engine, TOPTIK_TEST_QUEUE_UPGRADE: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
