const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'bin', 'adcp.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ADCP_SKIP_VERSION_CHECK: '1', ...env },
    encoding: 'utf8',
  });
}

test('init seller creates a compile-gated PostgreSQL 3.2 project without inventory fallbacks', () => {
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-init-'));
  try {
    const result = run([
      'init',
      'seller',
      '--specialism',
      'sales-non-guaranteed',
      '--backend',
      'postgres',
      '--dir',
      dir,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const source = readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8');
    assert.match(source, /createPostgresTaskRegistry/);
    assert.match(source, /pgBackend/);
    assert.match(source, /pool\.on\('error'/);
    assert.match(source, /putIfMatch\(BUY_COLLECTION, mediaBuyId, record, null\)/);
    assert.match(source, /putIfMatch\(BUY_COLLECTION, req\.media_buy_id, stored, versioned\.version\)/);
    assert.match(source, /winner\.requestDigest !== requestDigest/);
    assert.match(source, /idempotency\.probe\(\)/);
    assert.match(source, /buyStore\.get\(BUY_COLLECTION, 'readiness_probe'\)/);
    assert.match(source, /taskRegistry\.getTask\('readiness_probe'/);
    assert.match(source, /ADCP_DEPLOYMENT_NAMESPACE/);
    assert.match(source, /pgBackend\(pool, \{ tableName: IDEMPOTENCY_TABLE \}\)/);
    assert.match(source, /BUY_COLLECTION = `\$\{DEPLOYMENT_NAMESPACE\}:starter_media_buys`/);
    assert.match(source, /while \(cursor\)/);
    assert.match(source, /PRODUCT_CATALOG_JSON/);
    assert.match(source, /parseProducts\(process\.env\.PRODUCT_CATALOG_JSON \?\? '\[\]'\)/);

    const generatedPackage = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.match(generatedPackage.scripts.dev, /--env-file=\.env/);
    assert.match(generatedPackage.scripts.doctor, /--env-file=\.env/);
    assert.match(generatedPackage.scripts.migrate, /--env-file=\.env/);
    const environmentExample = readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(
      environmentExample,
      /^ADCP_AUTH_TOKEN=\nADCP_ACCOUNT_ID=\nDATABASE_URL=\nADCP_DEPLOYMENT_NAMESPACE=\n/m
    );
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.env\nnode_modules/\ndist/\n');
    const migration = readFileSync(path.join(dir, 'scripts', 'migrate.ts'), 'utf8');
    assert.match(migration, /getIdempotencyMigration\(\{ tableName: idempotencyTable \}\)/);
    assert.match(migration, /getCtxMetadataMigration\(\)/);
    assert.match(migration, /getDecisioningTaskRegistryBootstrap\(\{ namespace: taskNamespace \}\)/);
    assert.doesNotMatch(migration, /getAllAdcpMigrations/);
    assert.match(migration, /`\$\{deployment\}:tasks`/);

    const compile = spawnSync(
      path.join(ROOT, 'node_modules', '.bin', 'tsc'),
      ['--noEmit', '--project', path.join(dir, 'tsconfig.json')],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);

    const installedSdkDir = path.join(dir, 'node_modules', '@adcp', 'sdk');
    mkdirSync(installedSdkDir, { recursive: true });
    writeFileSync(path.join(installedSdkDir, 'package.json'), JSON.stringify({ version: '13.9.0' }));

    const doctor = run(['doctor', '--dir', dir, '--json']);
    assert.equal(doctor.status, 1);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(check => check.name === 'secret ADCP_AUTH_TOKEN' && check.status === 'fail'));
    assert.ok(report.checks.some(check => check.name === 'secret ADCP_ACCOUNT_ID' && check.status === 'fail'));
    assert.ok(report.checks.some(check => check.name === 'secret DATABASE_URL' && check.status === 'fail'));
    assert.ok(
      report.checks.some(check => check.name === 'secret ADCP_DEPLOYMENT_NAMESPACE' && check.status === 'fail')
    );
    assert.ok(report.checks.some(check => check.name === 'SDK schema drift' && check.status === 'fail'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init and doctor reject unknown or duplicate options before doing work', () => {
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-init-flags-'));
  try {
    const unknown = run(['init', 'seller', '--dir', dir, '--bogus']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option: --bogus/);
    assert.deepEqual(readdirSync(dir), []);

    const duplicate = run(['init', 'seller', '--dir', dir, '--dir', dir]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /Option may only be specified once: --dir/);
    assert.deepEqual(readdirSync(dir), []);

    const doctorUnknown = run(['doctor', '--dir', dir, '--wat']);
    assert.equal(doctorUnknown.status, 1);
    assert.match(doctorUnknown.stderr, /Unknown option: --wat/);

    const globalFlags = run(['doctor', '--allow-v2', '--allow-http', '--help']);
    assert.equal(globalFlags.status, 0, globalFlags.stderr || globalFlags.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor compares the release-precision schema line and bounds discovery transport', async () => {
  const { _test } = require('../../bin/adcp-project.js');
  const checks = [];
  let receivedOptions;
  class FakeClient {
    constructor(_configs, options) {
      receivedOptions = options;
    }
    agent() {
      return { getCapabilities: async () => ({ version: 'v3', supportedVersions: ['3.2'] }) };
    }
  }
  await _test.checkAgentProfile(
    'https://seller.example/mcp',
    {
      adcpVersion: '3.2.0',
      AdCPClient: FakeClient,
      detectProtocol: async () => 'mcp',
      isAdcpVersionSupported: (version, supported) => supported.includes(version.replace(/\.0$/, '')),
      resolveAgent: url => ({ url }),
    },
    checks
  );
  assert.equal(checks.find(check => check.name === 'agent schema drift').status, 'pass');
  assert.deepEqual(receivedOptions.transport, { requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576 });

  checks.length = 0;
  FakeClient.prototype.agent = () => ({
    getCapabilities: async () => ({ version: 'v3', servedVersion: '3.1.18', supportedVersions: ['3.1'] }),
  });
  await _test.checkAgentProfile(
    'https://seller.example/mcp',
    {
      adcpVersion: '3.2.0',
      AdCPClient: FakeClient,
      detectProtocol: async () => 'mcp',
      isAdcpVersionSupported: () => false,
      resolveAgent: url => ({ url }),
    },
    checks
  );
  assert.equal(checks.find(check => check.name === 'agent schema drift').status, 'fail');
});

test('doctor validates canonical catalog JSON without requiring inventory', () => {
  const { _test } = require('../../bin/adcp-project.js');
  const previousCatalog = process.env.PRODUCT_CATALOG_JSON;
  try {
    for (const [catalog, expectedStatus, detail] of [
      ['[', 'fail', /not valid JSON/],
      ['{}', 'fail', /must be a JSON array/],
      ['[{}]', 'fail', /products\.0\.product_id/],
      ['[]', 'warn', /honest empty inventory/],
    ]) {
      process.env.PRODUCT_CATALOG_JSON = catalog;
      const checks = [];
      _test.checkProductCatalog(checks);
      assert.equal(checks[0].status, expectedStatus);
      assert.match(checks[0].detail, detail);
    }
  } finally {
    if (previousCatalog === undefined) delete process.env.PRODUCT_CATALOG_JSON;
    else process.env.PRODUCT_CATALOG_JSON = previousCatalog;
  }
});

test('doctor classifies common PostgreSQL failures without exposing raw errors', () => {
  const { _test } = require('../../bin/adcp-project.js');
  assert.equal(_test.postgresFailureDetail({ code: '28P01' }), 'database authentication failed');
  assert.equal(_test.postgresFailureDetail({ code: '42501' }), 'database permission denied');
  assert.equal(_test.postgresFailureDetail({ code: 'ECONNREFUSED' }), 'database unreachable or timed out');
  assert.equal(
    _test.postgresFailureDetail(new Error('secret-bearing driver message')),
    'database connection or migration query failed'
  );
});

test('doctor recognizes the current PostgreSQL idempotency migration columns', async () => {
  const { _test } = require('../../bin/adcp-project.js');
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-doctor-pg-'));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDeployment = process.env.ADCP_DEPLOYMENT_NAMESPACE;
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }));
    const loadPostgres = () => ({
      Pool: class Pool {
        async query() {
          const columns = {
            tenant_a_adcp_idempotency: ['scoped_key', 'payload_hash', 'response', 'expires_at', 'retain_until'],
            adcp_ctx_metadata: ['scoped_key', 'value'],
            adcp_decisioning_tasks: ['registry_namespace', 'task_id', 'account_id', 'owner_scope', 'status'],
            adcp_state: ['collection', 'id', 'data', 'version'],
          };
          return {
            rows: Object.entries(columns).flatMap(([table_name, names]) =>
              names.map(column_name => ({ table_name, column_name }))
            ),
          };
        }
        async end() {}
      },
    });
    process.env.DATABASE_URL = 'postgres://test.invalid/adcp';
    process.env.ADCP_DEPLOYMENT_NAMESPACE = 'tenant-a';
    const checks = [];
    await _test.checkPostgres(dir, { webhooks: false }, checks, loadPostgres);
    assert.deepEqual(checks, [
      { name: 'postgres migrations', status: 'pass', detail: 'required table shapes present' },
    ]);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDeployment === undefined) delete process.env.ADCP_DEPLOYMENT_NAMESPACE;
    else process.env.ADCP_DEPLOYMENT_NAMESPACE = previousDeployment;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor never loads PostgreSQL code from an inspected --dir target', async () => {
  const { _test } = require('../../bin/adcp-project.js');
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-doctor-untrusted-pg-'));
  const marker = path.join(dir, 'target-pg-loaded');
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDeployment = process.env.ADCP_DEPLOYMENT_NAMESPACE;
  try {
    const pgDir = path.join(dir, 'node_modules', 'pg');
    mkdirSync(pgDir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(path.join(pgDir, 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFileSync(
      path.join(pgDir, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); throw new Error('target pg executed');`
    );
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/adcp';
    process.env.ADCP_DEPLOYMENT_NAMESPACE = 'tenant-a';
    const checks = [];
    await _test.checkPostgres(dir, { webhooks: false }, checks);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(checks, [
      { name: 'postgres connection', status: 'fail', detail: 'database unreachable or timed out' },
    ]);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDeployment === undefined) delete process.env.ADCP_DEPLOYMENT_NAMESPACE;
    else process.env.ADCP_DEPLOYMENT_NAMESPACE = previousDeployment;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor recognizes configured PostgreSQL webhook table names', async () => {
  const { _test } = require('../../bin/adcp-project.js');
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-doctor-webhook-pg-'));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDeployment = process.env.ADCP_DEPLOYMENT_NAMESPACE;
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }));
    const deliveryColumns = [
      'publisher_scope',
      'tenant_scope',
      'delivery_id',
      'status',
      'idempotency_key',
      'payload_fingerprint',
      'first_attempt_at',
      'retain_until',
    ];
    const outboxColumns = [
      'publisher_scope',
      'tenant_scope',
      'delivery_id',
      'snapshot',
      'snapshot_fingerprint',
      'storage_fingerprint',
      'intent_fingerprint',
      'state',
      'disposition',
      'attempt_count',
      'next_attempt_at',
      'lease_owner',
      'lease_claim_id',
      'lease_version',
      'lease_expires_at',
    ];
    let omitIntentFingerprint = false;
    const loadPostgres = () => ({
      Pool: class Pool {
        async query() {
          const columns = {
            tenant_a_adcp_idempotency: ['scoped_key', 'payload_hash', 'response', 'expires_at', 'retain_until'],
            adcp_ctx_metadata: ['scoped_key', 'value'],
            adcp_decisioning_tasks: ['registry_namespace', 'task_id', 'account_id', 'owner_scope', 'status'],
            adcp_state: ['collection', 'id', 'data', 'version'],
            adcp_webhook_deliveries: deliveryColumns,
            adcp_webhook_outbox: outboxColumns,
            seller_webhook_deliveries: deliveryColumns,
            seller_webhook_outbox: omitIntentFingerprint
              ? outboxColumns.filter(column => column !== 'intent_fingerprint')
              : outboxColumns,
          };
          return {
            rows: Object.entries(columns).flatMap(([table_name, names]) =>
              names.map(column_name => ({ table_name, column_name }))
            ),
          };
        }
        async end() {}
      },
    });
    process.env.DATABASE_URL = 'postgres://test.invalid/adcp';
    process.env.ADCP_DEPLOYMENT_NAMESPACE = 'tenant-a';
    const checks = [];
    await _test.checkPostgres(
      dir,
      { webhooks: true, webhookTables: { deliveries: 'seller_webhook_deliveries', outbox: 'seller_webhook_outbox' } },
      checks,
      loadPostgres
    );
    assert.deepEqual(checks, [
      { name: 'postgres migrations', status: 'pass', detail: 'required table shapes present' },
    ]);
    omitIntentFingerprint = true;
    checks.length = 0;
    await _test.checkPostgres(
      dir,
      { webhooks: true, webhookTables: { deliveries: 'seller_webhook_deliveries', outbox: 'seller_webhook_outbox' } },
      checks,
      loadPostgres
    );
    assert.deepEqual(checks, [
      {
        name: 'postgres migrations',
        status: 'fail',
        detail: 'missing: seller_webhook_outbox.intent_fingerprint',
      },
    ]);
    checks.length = 0;
    await _test.checkPostgres(dir, { webhooks: true }, checks, loadPostgres);
    assert.deepEqual(checks, [
      { name: 'postgres migrations', status: 'pass', detail: 'required table shapes present' },
    ]);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDeployment === undefined) delete process.env.ADCP_DEPLOYMENT_NAMESPACE;
    else process.env.ADCP_DEPLOYMENT_NAMESPACE = previousDeployment;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor rejects unsafe or colliding webhook table configuration', () => {
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-doctor-webhook-config-'));
  try {
    writeFileSync(
      path.join(dir, 'adcp.project.json'),
      JSON.stringify({
        schemaVersion: 1,
        sdkMajor: 14,
        kind: 'seller',
        specialism: 'sales-non-guaranteed',
        backend: 'postgres',
        deploymentNamespaceEnv: 'ADCP_DEPLOYMENT_NAMESPACE',
        webhooks: true,
        webhookTables: { deliveries: 'unsafe;drop', outbox: 'unsafe;drop' },
        requiredSecrets: ['ADCP_AUTH_TOKEN', 'ADCP_ACCOUNT_ID', 'DATABASE_URL', 'ADCP_DEPLOYMENT_NAMESPACE'],
      })
    );
    const installedSdkDir = path.join(dir, 'node_modules', '@adcp', 'sdk');
    mkdirSync(installedSdkDir, { recursive: true });
    writeFileSync(path.join(installedSdkDir, 'package.json'), JSON.stringify({ version: '14.0.0' }));
    const result = run(['doctor', '--dir', dir, '--json']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(
      report.checks.find(check => check.name === 'project config').detail,
      /valid deliveries\/outbox SQL identifiers/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init seller refuses to overwrite an existing project', () => {
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-init-existing-'));
  try {
    const first = run(['init', 'seller', '--dir', dir]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const result = run(['init', 'seller', '--dir', dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Target directory is not empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory scaffold doctor succeeds with explicit development warnings', () => {
  const dir = mkdtempSync(path.join(ROOT, '.context', 'cli-doctor-memory-'));
  try {
    const initialized = run(['init', 'seller', '--backend', 'memory', '--dir', dir]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const installedSdkDir = path.join(dir, 'node_modules', '@adcp', 'sdk');
    mkdirSync(installedSdkDir, { recursive: true });
    writeFileSync(path.join(installedSdkDir, 'package.json'), JSON.stringify({ version: '14.0.0-rc.1' }));
    const result = run(['doctor', '--dir', dir, '--json'], {
      ADCP_AUTH_TOKEN: 'local-test-token',
      ADCP_ACCOUNT_ID: 'local-test-account',
      PRODUCT_CATALOG_JSON: '[]',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.checks.some(check => check.name === 'product catalog' && check.status === 'warn'));
    assert.ok(report.checks.some(check => check.name === 'durable backend' && check.status === 'warn'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
