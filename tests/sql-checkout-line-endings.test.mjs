import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const migration = 'supabase/migrations/20261110072708_ordinary_media_reorder_timestamps.sql';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const gitRead = args => execFileSync('git', args, { cwd: repository, maxBuffer: 4 * 1024 * 1024 });

test('tracked SQL checkout bytes stay LF without a test-loader normalization', () => {
  const paths = gitRead(['ls-files', '-z', '--', '*.sql']).toString('utf8').split('\0').filter(Boolean);
  assert.ok(paths.includes(migration));
  for (const path of paths) {
    const target = resolve(repository, path), local = relative(repository, target);
    assert.ok(!isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), path);
    assert.equal(lstatSync(target).isSymbolicLink(), false, path);
    assert.equal(readFileSync(target).includes(13), false, `${path}: SQL must be materialized as LF`);
  }
});

test('a fresh Git checkout with core.autocrlf=true preserves the exact migration blob and predecessor guard bytes', () => {
  const canonical = gitRead(['show', `HEAD:${migration}`]);
  assert.equal(canonical.includes(13), false, 'the deployed migration blob is canonical LF');
  assert.equal(sha256(readFileSync(join(repository, migration))), sha256(canonical), 'the real SQL test reads the exact Git blob');
  const attributes = readFileSync(join(repository, '.gitattributes'));
  const temporaryRoot = realpathSync(tmpdir());
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^GIT_/i.test(key)) delete environment[key];
  for (const protectedCheckout of [false, true]) {
    const directory = mkdtempSync(join(temporaryRoot, 'toptik-sql-eol-'));
    try {
      mkdirSync(join(directory, 'supabase', 'migrations'), { recursive: true });
      const emptyAttributes = join(directory, 'empty-global-attributes');
      writeFileSync(emptyAttributes, '');
      writeFileSync(join(directory, '.gitattributes'), protectedCheckout ? attributes : '');
      // Reproduce Windows source bytes before Git's actual clean/checkout filters.
      writeFileSync(join(directory, migration), canonical.toString('utf8').replaceAll('\n', '\r\n'));
      const run = args => execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', '-c', 'core.safecrlf=false',
        '-c', `core.attributesFile=${emptyAttributes}`, ...args], {
        cwd: directory, maxBuffer: 4 * 1024 * 1024,
        env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'absent-global-config'), GIT_ATTR_NOSYSTEM: '1' },
      });
      run(['init', '--quiet']);
      run(['add', '--', '.gitattributes', migration]);
      const indexed = run(['show', `:${migration}`]);
      assert.equal(sha256(indexed), sha256(canonical), 'no migration content changes enter the Git index');
      unlinkSync(join(directory, migration));
      run(['checkout-index', '--force', '--', migration]);
      const materialized = readFileSync(join(directory, migration));
      if (protectedCheckout) {
        assert.equal(materialized.includes(13), false, 'repository attributes override the Windows CRLF default');
        assert.equal(sha256(materialized), sha256(indexed), 'fresh checkout SHA256 equals the exact Git blob');
        assert.match(run(['check-attr', 'eol', '--', migration]).toString('utf8'), /: eol: lf\s*$/);
        const oldBlock = materialized.toString('utf8').match(/old_block text:=\$old\$([\s\S]*?)\$old\$;/)?.[1];
        assert.ok(oldBlock && !oldBlock.includes('\r'), 'the exact predecessor literal reaches PGlite/Postgres as LF');
      } else {
        assert.ok(materialized.includes(Buffer.from('\r\n')), 'control reproduces the unprotected Windows checkout failure');
        assert.notEqual(sha256(materialized), sha256(indexed));
      }
    } finally {
      // Delete only the isolated directory created by this test, never a repository or computed parent.
      const target = realpathSync(directory);
      assert.equal(dirname(target), temporaryRoot);
      assert.ok(basename(target).startsWith('toptik-sql-eol-'));
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      rmSync(target, { recursive: true, force: true });
    }
  }
});
