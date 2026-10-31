/**
 * `postgresStorage({ pool })` and the versioned migrations on PostgreSQL (experimental, AdCP 3.3):
 * `npx adcp-reporting-storage migrate` on a fresh schema, `--status`, a re-run, concurrent runners, a
 * schema set up from the deprecated constants by hand, the startup schema check, and every store the
 * storage holds reading and writing its own tables.
 */
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('PostgreSQL reporting storage facade', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schemas = {
    fresh: `adcp_storage_fresh_${process.pid}`,
    race: `adcp_storage_race_${process.pid}`,
    legacy: `adcp_storage_legacy_${process.pid}`,
  };
  let Pool;
  let bootstrap;
  let lib;
  let cli;
  const pools = [];

  function poolFor(schema) {
    const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    pools.push(pool);
    return pool;
  }

  function io() {
    const out = [];
    const err = [];
    return { out, err, io: { out: line => out.push(line), err: line => err.push(line), env: {} } };
  }

  before(async () => {
    ({ Pool } = require('pg'));
    lib = require('@adcp/reporting-storage');
    cli = require('../dist/cli.js');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    for (const schema of Object.values(schemas)) await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  });

  after(async () => {
    for (const pool of pools) await pool.end();
    if (bootstrap) {
      for (const schema of Object.values(schemas)) await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('the CLI migrates a fresh schema in order, and the storage then starts', async () => {
    const pool = poolFor(schemas.fresh);
    const storage = lib.postgresStorage({ pool });
    await assert.rejects(storage.checkSchema(), { code: 'REPORTING_SCHEMA_BEHIND', message: /pending: 0001, 0002/ });

    const status = io();
    const args = ['migrate', '--database-url', DATABASE_URL, '--schema', schemas.fresh];
    assert.equal(await cli.runReportingStorageCli([...args, '--status'], status.io), 0, status.err.join('\n'));
    assert.equal(status.out.at(-1), `${lib.migrations().length} pending`);

    const dry = io();
    assert.equal(await cli.runReportingStorageCli([...args, '--dry-run'], dry.io), 0, dry.err.join('\n'));
    assert.equal((await lib.pendingMigrations(pool)).length, lib.migrations().length, 'a dry run applies nothing');

    const run = io();
    assert.equal(await cli.runReportingStorageCli(args, run.io), 0, run.err.join('\n'));
    assert.deepEqual(
      run.out,
      lib
        .migrations()
        .map(item => `applied ${item.version} ${item.name}${item.stoppedWorker ? ' (stopped-worker upgrade)' : ''}`)
    );
    const recorded = await pool.query('SELECT version, name FROM adcp_schema_migrations ORDER BY version');
    assert.deepEqual(
      recorded.rows.map(row => `${row.version} ${row.name}`),
      lib.migrations().map(item => `${item.version} ${item.name}`)
    );
    await storage.checkSchema();

    const again = io();
    assert.equal(await cli.runReportingStorageCli(args, again.io), 0);
    assert.deepEqual(again.out, ['up to date']);
    const afterStatus = io();
    await cli.runReportingStorageCli([...args, '--status'], afterStatus.io);
    assert.equal(afterStatus.out.at(-1), 'up to date');
    assert.ok(afterStatus.out.every(line => line === 'up to date' || / applied /.test(line)));
  });

  test('every store in the storage reads and writes its own tables', async () => {
    const storage = lib.postgresStorage({ pool: poolFor(schemas.fresh), namespace: 'facade-test' });
    const scope = { tenantId: 'tenant-1', principalId: 'principal-a' };

    // Engine state: one CAS document per key.
    const first = await storage.subscriptions.put(scope, 'principal', { served: {} }, null);
    assert.equal(first.outcome, 'applied');
    assert.deepEqual(await storage.subscriptions.put(scope, 'principal', { served: {} }, null), {
      outcome: 'conflict',
    });
    assert.deepEqual((await storage.subscriptions.get(scope, 'principal')).value, { served: {} });
    assert.deepEqual(await storage.subscriptions.listPrincipals('tenant-1'), [scope]);

    // Principal records share the state table, in their own collection.
    assert.equal(await storage.principals.get(scope), null);

    // The buyer consumer's leases and cursors.
    const key = { consumerScope: 'seller:principal-a', accountId: 'acc-1' };
    const lease = await storage.consumer.workLeases.claim({ key, ownerToken: 'owner-a', leaseMilliseconds: 30_000 });
    assert.equal(lease.generation, 1);
    assert.equal(await storage.consumer.changesCheckpointStore.compareAndSet(key, null, 'cursor-1', lease), 'applied');
    assert.equal((await storage.consumer.changesCheckpointStore.get(key)).checkpoint, 'cursor-1');

    // The ledger and managed delivery tables exist and are empty.
    assert.deepEqual(await storage.ledger.listConfigurations(), []);
    const managed = await storage.pool.query('SELECT count(*)::int AS n FROM adcp_reporting_managed_policy');
    assert.equal(managed.rows[0].n, 1);
  });

  test('concurrent runners serialize under the schema lock and apply each migration once', async () => {
    const runs = await Promise.all([lib.migrate(poolFor(schemas.race)), lib.migrate(poolFor(schemas.race))]);
    const applied = runs
      .flat()
      .map(item => item.version)
      .sort();
    assert.deepEqual(
      applied,
      lib.migrations().map(item => item.version),
      'each version is applied by exactly one runner'
    );
    assert.deepEqual(await lib.pendingMigrations(poolFor(schemas.race)), []);
  });

  test('a schema set up from the deprecated constants by hand migrates cleanly', async () => {
    const pool = poolFor(schemas.legacy);
    const server = require('@adcp/sdk/server');
    const consumer = require('@adcp/sdk/reporting/consumer');
    const managed = require('@adcp/reporting-storage/managed');
    await pool.query(server.ADCP_STATE_MIGRATION);
    await pool.query(lib.REPORTING_LEDGER_MIGRATION);
    await pool.query(managed.REPORTING_MANAGED_DELIVERY_MIGRATION);
    await pool.query(consumer.REPORTING_CONSUMER_POSTGRES_MIGRATION);
    await pool.query(`INSERT INTO adcp_state (collection, id, data) VALUES ('kept', 'row', '{"a":1}'::jsonb)`);
    await assert.rejects(lib.postgresStorage({ pool }).checkSchema(), { code: 'REPORTING_SCHEMA_BEHIND' });
    assert.equal((await lib.migrate(pool)).length, lib.migrations().length);
    await lib.postgresStorage({ pool }).checkSchema();
    const kept = await pool.query(`SELECT data FROM adcp_state WHERE collection = 'kept'`);
    assert.deepEqual(kept.rows[0].data, { a: 1 }, 'existing rows survive');
  });
});
