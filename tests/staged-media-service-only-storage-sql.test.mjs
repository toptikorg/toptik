import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const legacy = await readFile('supabase/migrations/20260423_carousel_storage.sql', 'utf8');
const migration = await readFile('supabase/migrations/20261110062842_staged_media_service_only_writes.sql', 'utf8');
const writePolicies = ['carousel_media_auth_delete', 'carousel_media_auth_insert', 'carousel_media_auth_update'];
const card = '10000000-0000-4000-8000-000000000001';
const names = [
  `items/${card}/cover/20000000-0000-4000-8000-000000000001.jpg`,
  `sync-staged/${card}/${'a'.repeat(64)}.jpg`,
];
const metadata = { sha256: 'a'.repeat(64), bytes: 1234 };

async function fixture({ rls = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin nobypassrls;
    create role authenticated nologin nobypassrls;
    create role service_role nologin bypassrls;
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null, metadata jsonb not null default '{}',
      unique (bucket_id, name)
    );
    grant usage on schema storage to anon, authenticated, service_role;
    grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
  `);
  if (rls) await db.exec('alter table storage.objects enable row level security');
  await db.exec(legacy);
  await db.exec(`
    insert into storage.buckets values ('unrelated-bucket', 'unrelated-bucket', false, 4096, array['text/plain']);
    create policy unrelated_bucket_auth_all on storage.objects for all to authenticated
      using (bucket_id = 'unrelated-bucket') with check (bucket_id = 'unrelated-bucket');
  `);
  for (const name of names) {
    await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',
      ['carousel-media', name, JSON.stringify(metadata)]);
  }
  return db;
}

async function asRole(db, role, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  try { return await action(); }
  finally { await db.exec('reset role'); }
}

async function policySnapshot(db) {
  return (await db.query(`
    select policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname
  `)).rows;
}

async function infrastructureSnapshot(db) {
  return {
    buckets: (await db.query('select * from storage.buckets order by id')).rows,
    permissions: (await db.query(`
      select grantee, privilege_type, is_grantable from information_schema.role_table_grants
      where table_schema='storage' and table_name='objects' order by grantee, privilege_type
    `)).rows,
    roles: (await db.query(`
      select rolname, rolsuper, rolbypassrls from pg_roles
      where rolname in ('anon','authenticated','service_role') order by rolname
    `)).rows,
    rls: (await db.query("select relrowsecurity from pg_class where oid='storage.objects'::regclass")).rows,
  };
}

async function assertOriginalObjects(db) {
  const rows = (await db.query(`
    select name, metadata from storage.objects where bucket_id='carousel-media' order by name
  `)).rows;
  assert.deepEqual(rows, [...names].sort().map(name => ({ name, metadata })));
}

test('legacy replay cleanup enforces service-only writes on raw and reviewed staged objects', { timeout: 60000 }, async t => {
  const db = await fixture();
  try {
    await t.test('fixture uses native role grants and demonstrates the historical policy, not a live finding', async () => {
      const roles = (await infrastructureSnapshot(db)).roles;
      assert.deepEqual(roles, [
        { rolname: 'anon', rolsuper: false, rolbypassrls: false },
        { rolname: 'authenticated', rolsuper: false, rolbypassrls: false },
        { rolname: 'service_role', rolsuper: false, rolbypassrls: true },
      ]);
      const membership = (await db.query(`select
        pg_has_role('anon','service_role','MEMBER') as anon,
        pg_has_role('authenticated','service_role','MEMBER') as authenticated
      `)).rows[0];
      assert.deepEqual(membership, { anon: false, authenticated: false });
      for (const name of names) {
        const changed = await asRole(db, 'authenticated', () => db.query(`
          update storage.objects set metadata='{"historical_fixture_write":true}'
          where bucket_id='carousel-media' and name=$1 returning name
        `, [name]));
        assert.equal(changed.rows.length, 1);
        await db.query("update storage.objects set metadata=$1 where bucket_id='carousel-media' and name=$2",
          [JSON.stringify(metadata), name]);
      }
    });

    const beforePolicies = await policySnapshot(db);
    const beforeInfrastructure = await infrastructureSnapshot(db);
    await db.exec(migration);
    assert.deepEqual(await policySnapshot(db), beforePolicies.filter(p => !writePolicies.includes(p.policyname)));
    assert.deepEqual(await infrastructureSnapshot(db), beforeInfrastructure);

    for (const role of ['anon', 'authenticated']) {
      await t.test(`${role} can read but cannot insert, overwrite, update or delete either prefix`, async () => {
        await asRole(db, role, async () => {
          assert.equal((await db.query("select name from storage.objects where bucket_id='carousel-media'")).rows.length, 2);
          for (const name of names) {
            await assert.rejects(db.query(`
              insert into storage.objects(bucket_id,name,metadata) values('carousel-media',$1,'{"tampered":true}')
            `, [`${name}.new`]), /row-level security/i);
            await assert.rejects(db.query(`
              insert into storage.objects(bucket_id,name,metadata) values('carousel-media',$1,'{"tampered":true}')
              on conflict (bucket_id,name) do update set metadata=excluded.metadata
            `, [name]), /row-level security/i);
            assert.equal((await db.query(`
              update storage.objects set metadata='{"tampered":true}'
              where bucket_id='carousel-media' and name=$1 returning name
            `, [name])).rows.length, 0);
            assert.equal((await db.query(`
              delete from storage.objects where bucket_id='carousel-media' and name=$1 returning name
            `, [name])).rows.length, 0);
          }
        });
        await assertOriginalObjects(db);
      });
    }

    await t.test('service role retains insert, overwrite and delete without widening browser roles', async () => {
      await asRole(db, 'service_role', async () => {
        for (const name of names) {
          const temporaryName = `${name}.service`;
          await db.query("insert into storage.objects(bucket_id,name) values('carousel-media',$1)", [temporaryName]);
          const overwrite = await db.query(`
            insert into storage.objects(bucket_id,name,metadata) values('carousel-media',$1,$2)
            on conflict (bucket_id,name) do update set metadata=excluded.metadata returning metadata
          `, [name, JSON.stringify({ serviceWrite: true })]);
          assert.deepEqual(overwrite.rows[0].metadata, { serviceWrite: true });
          await db.query("update storage.objects set metadata=$1 where bucket_id='carousel-media' and name=$2",
            [JSON.stringify(metadata), name]);
          assert.equal((await db.query("delete from storage.objects where bucket_id='carousel-media' and name=$1 returning name",
            [temporaryName])).rows.length, 1);
        }
      });
      await assertOriginalObjects(db);
    });

    await t.test('an unrelated bucket policy and its authorized writes are retained', async () => {
      const name = randomUUID();
      await asRole(db, 'authenticated', async () => {
        await db.query("insert into storage.objects(bucket_id,name) values('unrelated-bucket',$1)", [name]);
        assert.equal((await db.query(`
          update storage.objects set metadata='{"unrelated":true}'
          where bucket_id='unrelated-bucket' and name=$1 returning name
        `, [name])).rows.length, 1);
        assert.equal((await db.query("delete from storage.objects where bucket_id='unrelated-bucket' and name=$1 returning name", [name])).rows.length, 1);
      });
    });

    await t.test('rerunning in the current-live-like SELECT-only state is a no-op', async () => {
      const policies = await policySnapshot(db);
      const infrastructure = await infrastructureSnapshot(db);
      await db.exec(migration);
      assert.deepEqual(await policySnapshot(db), policies);
      assert.deepEqual(await infrastructureSnapshot(db), infrastructure);
      await assertOriginalObjects(db);
    });
  } finally { await db.close(); }
});

test('disabled storage RLS aborts before removing policies or changing permissions', { timeout: 60000 }, async () => {
  const db = await fixture({ rls: false });
  try {
    const policies = await policySnapshot(db);
    const infrastructure = await infrastructureSnapshot(db);
    await assert.rejects(db.exec(migration), /STAGED_MEDIA_STORAGE_RLS_REQUIRED/);
    await db.exec('rollback');
    assert.deepEqual(await policySnapshot(db), policies);
    assert.deepEqual(await infrastructureSnapshot(db), infrastructure);
    await assertOriginalObjects(db);
  } finally { await db.close(); }
});
