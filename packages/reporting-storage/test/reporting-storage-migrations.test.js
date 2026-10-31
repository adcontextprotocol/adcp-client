/**
 * Versioned reporting-storage migrations and the `adcp-reporting-storage` CLI, without a database:
 * the shipped order, the schema check's refusal and the command's argument handling.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const lib = require('@adcp/reporting-storage');
const { runReportingStorageCli, REPORTING_STORAGE_CLI_USAGE } = require('../dist/cli.js');
const manifest = require('../package.json');

/** A pool that has never been migrated: `adcp_schema_migrations` does not exist. */
function emptyPool() {
  const queries = [];
  return {
    queries,
    async query(text) {
      queries.push(text);
      if (/to_regclass\('adcp_schema_migrations'\)/.test(text)) return { rows: [{ present: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error('not used');
    },
    async end() {},
  };
}

function io(env = {}, createPool) {
  const out = [];
  const err = [];
  return { out, err, io: { out: line => out.push(line), err: line => err.push(line), env, createPool } };
}

describe('versioned migrations', () => {
  test('ship in version order, each once, built from the existing idempotent DDL', () => {
    const all = lib.migrations();
    const versions = all.map(item => item.version);
    assert.deepEqual(versions, [...versions].sort());
    assert.equal(new Set(versions).size, versions.length);
    for (const item of all) {
      assert.match(item.version, /^\d{4}$/);
      assert.match(item.name, /^[a-z0-9_]+$/);
      assert.ok(item.statements().length > 0, item.name);
    }
    const sql = name => all.find(item => item.name === name).statements();
    assert.deepEqual(sql('reporting_ledger'), [lib.REPORTING_LEDGER_MIGRATION]);
    assert.deepEqual(sql('reporting_managed_delivery'), [
      require('@adcp/reporting-storage/managed').REPORTING_MANAGED_DELIVERY_MIGRATION,
    ]);
    assert.deepEqual(sql('adcp_state'), [require('@adcp/sdk/server').ADCP_STATE_MIGRATION]);
    assert.deepEqual(sql('reporting_consumer'), [
      require('@adcp/sdk/reporting/consumer').REPORTING_CONSUMER_POSTGRES_MIGRATION,
    ]);
    assert.deepEqual(
      all.filter(item => item.stoppedWorker).map(item => item.name),
      ['reporting_ledger_finality_fence']
    );
    assert.equal(lib.MIGRATE_COMMAND, 'npx adcp-reporting-storage migrate');
  });

  test('checkSchema refuses a schema that is behind, naming the command and the pending versions', async () => {
    const pool = emptyPool();
    const storage = lib.postgresStorage({ pool });
    assert.equal(storage.durability, 'durable');
    assert.equal(storage.principals.durability, 'durable');
    assert.equal(storage.subscriptions.durability, 'durable');
    assert.ok(require('@adcp/sdk/storage').isReportingStorage(storage));
    await assert.rejects(storage.checkSchema(), error => {
      assert.equal(error.name, 'PlatformConfigError');
      assert.equal(error.code, 'REPORTING_SCHEMA_BEHIND');
      assert.match(error.message, /Run "npx adcp-reporting-storage migrate"/);
      assert.match(
        error.message,
        new RegExp(
          `pending: ${lib
            .migrations()
            .map(item => item.version)
            .join(', ')}`
        )
      );
      assert.match(error.message, /0003 is a stopped-worker upgrade/);
      return true;
    });
    assert.equal(
      pool.queries.some(text => /CREATE|ALTER|INSERT/i.test(text)),
      false,
      'the check never changes the schema'
    );
  });

  test('postgresStorage needs a pool', () => {
    assert.throws(() => lib.postgresStorage({}), { name: 'PlatformConfigError', configField: 'pool' });
  });

  test('describeMigrations marks pending and stopped-worker entries', () => {
    const lines = lib.describeMigrations(
      lib.migrations().map((migration, index) => ({
        migration,
        appliedAt: index === 0 ? new Date('2026-11-01T00:00:00Z') : null,
        pending: index !== 0,
      }))
    );
    assert.equal(lines[0], '0001 adcp_state: applied 2026-11-01T00:00:00.000Z');
    assert.equal(lines[2], '0003 reporting_ledger_finality_fence: pending (stopped-worker upgrade)');
  });
});

describe('npx adcp-reporting-storage', () => {
  test('the package declares the bin and ships it', () => {
    assert.deepEqual(manifest.bin, { 'adcp-reporting-storage': 'bin/adcp-reporting-storage.js' });
    assert.ok(manifest.files.includes('bin'));
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'adcp-reporting-storage.js'), '--help'],
      {
        encoding: 'utf8',
      }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /npx adcp-reporting-storage migrate \[--database-url URL\]/);
  });

  test('refuses unknown commands, unknown options, conflicting modes and a missing URL', async () => {
    for (const [argv, pattern] of [
      [[], /Usage/],
      [['upgrade'], /Unknown command/],
      [['migrate', '--force'], /Unknown option/],
      [['migrate', '--status', '--dry-run', '--database-url', 'postgres://x'], /not both/],
      [['migrate'], /DATABASE_URL/],
      [['migrate', '--database-url', 'postgres://x', '--schema', 'bad;name'], /plain PostgreSQL identifier/],
    ]) {
      const run = io();
      const code = await runReportingStorageCli(argv, run.io);
      assert.equal(code, 2, argv.join(' '));
      assert.match([...run.out, ...run.err].join('\n'), pattern, argv.join(' '));
    }
  });

  test('--status and --dry-run read the database and change nothing', async () => {
    const pool = emptyPool();
    const pools = [];
    const createPool = async config => {
      pools.push(config);
      return pool;
    };
    const status = io({ DATABASE_URL: 'postgres://db/app' }, createPool);
    assert.equal(await runReportingStorageCli(['migrate', '--status', '--schema', 'adcp'], status.io), 0);
    assert.equal(status.out.at(-1), `${lib.migrations().length} pending`);
    assert.deepEqual(pools[0], { connectionString: 'postgres://db/app', options: '-c search_path=adcp' });
    const dry = io({ ADCP_DATABASE_URL: 'postgres://db/adcp', DATABASE_URL: 'postgres://db/app' }, createPool);
    assert.equal(await runReportingStorageCli(['migrate', '--dry-run'], dry.io), 0);
    assert.equal(dry.out[0], 'would apply 0001 adcp_state');
    assert.equal(pools[1].connectionString, 'postgres://db/adcp', 'ADCP_DATABASE_URL wins over DATABASE_URL');
    assert.equal(
      pool.queries.some(text => /CREATE|ALTER|INSERT/i.test(text)),
      false
    );
    assert.match(REPORTING_STORAGE_CLI_USAGE, /--status/);
  });

  test('a failure exits 1 with the message', async () => {
    const run = io({ DATABASE_URL: 'postgres://db/app' }, async () => {
      throw new Error('connect ECONNREFUSED');
    });
    assert.equal(await runReportingStorageCli(['migrate'], run.io), 1);
    assert.match(run.err.join('\n'), /ECONNREFUSED/);
  });
});
