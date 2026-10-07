const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { before, after, describe, test } = require('node:test');
const url = process.env.REPORTING_LEDGER_PG_URL;
const sha = value => createHash('sha256').update(value).digest('hex');

describe('durable provider write inventory', { skip: !url && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_object_writes_${process.pid}`;
  let root, pool, store;
  const bytes = readFileSync('test/fixtures/reporting-interop/resources/rows.jsonl');
  const scope = id => ({ account_id: id, destination_ref: 'owned-test-destination', generation: 1 });
  const provider = { bucket: 'owned-fixture-bucket', namespace_key: sha('owned-fixture-namespace') };
  const plan = (id, key = 'delivery', generation = 1, binding = provider) => ({
    ...scope(id),
    generation,
    provider: binding,
    plan_id: sha(key),
    objects: [0, 1].map(i => ({
      bucket: binding.bucket,
      object_name: `adcp-reporting/${binding.namespace_key}/${sha(JSON.stringify([id, scope(id).destination_ref, generation]))}/${sha(key)}/${i}`,
      sha256: sha(bytes),
      size_bytes: bytes.length,
    })),
  });
  before(async () => {
    const { Pool } = require('pg');
    const lib = require('../../dist/lib/reporting/ledger');
    root = new Pool({ connectionString: url });
    await root.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path="${schema}"` });
    for (const migration of [
      lib.REPORTING_LEDGER_MIGRATION,
      lib.REPORTING_MANAGED_DELIVERY_MIGRATION,
      lib.REPORTING_OBJECT_WRITE_MIGRATION,
      lib.REPORTING_OBJECT_WRITE_MIGRATION,
    ])
      await pool.query(migration);
    store = new lib.PostgresReportingManagedDeliveryStore(pool);
  });
  after(async () => {
    if (pool) await pool.end();
    if (root) {
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.end();
    }
  });
  const authorize = id => store.authorizeDestination({ ...scope(id), authorized_at: new Date().toISOString() });
  const revoke = id => store.revokeDestination({ ...scope(id), revoked_at: new Date().toISOString() });

  test('freezes content and object identities across retry and rolls back conflicts', async () => {
    await authorize('freeze');
    const p = plan('freeze');
    assert.equal(await store.registerObjectWritePlan(p), 'registered');
    assert.equal(await store.registerObjectWritePlan(p), 'unchanged');
    await assert.rejects(
      store.registerObjectWritePlan({ ...p, objects: [{ ...p.objects[0], sha256: sha('changed') }, p.objects[1]] })
    );
    await revoke('freeze');
    assert.equal(await store.registerObjectWritePlan(p), 'revoked');
    const writes = await store.listRevokedObjectWrites(scope('freeze'));
    assert.equal(writes.length, 2);
    assert.equal(writes[0].sha256, sha(bytes));
  });

  test('registration and revocation close the same inventory under concurrent connections', async () => {
    for (let i = 0; i < 10; i++) {
      const id = `race-${i}`;
      await authorize(id);
      const [registered] = await Promise.all([store.registerObjectWritePlan(plan(id)), revoke(id)]);
      assert.ok(['registered', 'revoked'].includes(registered));
      assert.equal((await store.listRevokedObjectWrites(scope(id))).length, registered === 'registered' ? 2 : 0);
      assert.equal(await store.registerObjectWritePlan(plan(id, 'later')), 'revoked');
    }
  });

  test('fence progress survives a new store instance and isolates generations/accounts', async () => {
    await authorize('progress');
    await authorize('other');
    await store.registerObjectWritePlan(plan('progress'));
    await store.registerObjectWritePlan(plan('other'));
    await assert.rejects(store.listRevokedObjectWrites(scope('progress')));
    await assert.rejects(
      store.markObjectWriteFenced({
        ...scope('progress'),
        plan_id: sha('delivery'),
        object_index: 0,
        tombstone_generation: '123',
      })
    );
    await revoke('progress');
    const [first] = await store.listRevokedObjectWrites(scope('progress'), { limit: 1 });
    await store.markObjectWriteFenced({
      ...scope('progress'),
      plan_id: first.plan_id,
      object_index: first.object_index,
      tombstone_generation: '123',
    });
    const lib = require('../../dist/lib/reporting/ledger');
    const recovered = new lib.PostgresReportingManagedDeliveryStore(pool);
    assert.equal((await recovered.listRevokedObjectWrites(scope('progress'))).length, 1);
    await assert.rejects(recovered.listRevokedObjectWrites(scope('other')));
    await recovered.authorizeDestination({
      ...scope('progress'),
      generation: 2,
      authorized_at: new Date().toISOString(),
    });
    await recovered.registerObjectWritePlan(plan('progress', 'generation2', 2));
    assert.equal((await recovered.listRevokedObjectWrites(scope('progress'))).length, 1);
  });

  test('a provider object cannot be reassigned to another authorization', async () => {
    await authorize('owner');
    await authorize('intruder');
    const p = plan('owner');
    await store.registerObjectWritePlan(p);
    await assert.rejects(store.registerObjectWritePlan({ ...p, ...scope('intruder') }));
    await revoke('intruder');
    assert.deepEqual(await store.listRevokedObjectWrites(scope('intruder')), []);
  });
  test('provider routing is frozen per generation and conflicts leave no new plan', async () => {
    await authorize('binding');
    await store.registerObjectWritePlan(plan('binding'));
    await assert.rejects(store.getObjectWriteBinding(scope('binding')));
    await assert.rejects(
      store.registerObjectWritePlan(plan('binding', 'other', 1, { ...provider, namespace_key: sha('rotated') }))
    );
    await assert.rejects(
      store.registerObjectWritePlan(plan('binding', 'other', 1, { ...provider, bucket: 'another-owned-bucket' }))
    );
    await revoke('binding');
    assert.deepEqual(await store.getObjectWriteBinding(scope('binding')), provider);
    assert.equal((await store.listRevokedObjectWrites(scope('binding'))).length, 2);
    await authorize('no-plan');
    await revoke('no-plan');
    assert.equal(await store.getObjectWriteBinding(scope('no-plan')), null);
  });

  test('first tombstone evidence is immutable and negative markers cannot advance progress', async () => {
    await authorize('markers');
    await store.registerObjectWritePlan(plan('markers'));
    await revoke('markers');
    const mark = { ...scope('markers'), plan_id: sha('delivery'), object_index: 0, tombstone_generation: '456' };
    await store.markObjectWriteFenced(mark);
    const before = (
      await pool.query('SELECT fenced_at FROM adcp_reporting_object_writes WHERE account_id=$1 AND object_index=0', [
        'markers',
      ])
    ).rows[0].fenced_at;
    await store.markObjectWriteFenced(mark);
    const after = (
      await pool.query('SELECT fenced_at FROM adcp_reporting_object_writes WHERE account_id=$1 AND object_index=0', [
        'markers',
      ])
    ).rows[0].fenced_at;
    assert.equal(after.toISOString(), before.toISOString());
    for (const invalid of [
      { ...mark, tombstone_generation: '789' },
      { ...mark, plan_id: sha('unknown') },
      { ...mark, object_index: 2 },
    ])
      await assert.rejects(store.markObjectWriteFenced(invalid));
    assert.equal((await store.listRevokedObjectWrites(scope('markers'))).length, 1);
  });

  test('aborting while waiting for the authoritative lock rolls back registration', async () => {
    await authorize('cancelled');
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['adcp-reporting-account:cancelled']);
      const controller = new AbortController();
      const pending = store.registerObjectWritePlan(plan('cancelled'), { signal: controller.signal });
      // Observe the actual PostgreSQL waiter, rather than guessing with a sleep.
      for (let i = 0; i < 100; i++) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%' AND pid <> pg_backend_pid()"
        );
        if (waiting.rowCount) break;
        if (i === 99) assert.fail('registration did not wait for the authority lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      controller.abort();
      await held.query('COMMIT');
      await assert.rejects(pending);
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
    await revoke('cancelled');
    assert.deepEqual(await store.listRevokedObjectWrites(scope('cancelled')), []);
    assert.equal(await store.getObjectWriteBinding(scope('cancelled')), null);
  });
});
