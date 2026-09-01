const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const PROJECT_FILE = 'adcp.project.json';
const SAFE_SPECIALISM = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_DEPLOYMENT_NAMESPACE = /^[a-z][a-z0-9-]{0,23}$/;
const SAFE_WEBHOOK_TABLE = /^[a-z_][a-z0-9_]{0,41}$/;

function validateArgs(args, { positionalCount, valueFlags, booleanFlags }) {
  const seen = new Set();
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positionals += 1;
      continue;
    }
    if (!valueFlags.includes(arg) && !booleanFlags.includes(arg)) throw new Error(`Unknown option: ${arg}`);
    if (seen.has(arg)) throw new Error(`Option may only be specified once: ${arg}`);
    seen.add(arg);
    if (valueFlags.includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
  if (positionals > positionalCount) throw new Error('Too many positional arguments');
}

function valueFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function postgresStarter(source) {
  return source
    .replace('createInMemoryTaskRegistry', 'createPostgresTaskRegistry')
    .replace('memoryBackend', 'pgBackend')
    .replace('proposalTermsDigest', 'PostgresStateStore, proposalTermsDigest')
    .replace("} from '@adcp/sdk/server';", "} from '@adcp/sdk/server';\nimport { Pool } from 'pg';")
    .replace(
      "if (!TOKEN) throw new Error('Set ADCP_AUTH_TOKEN before starting the seller');",
      "if (!TOKEN) throw new Error('Set ADCP_AUTH_TOKEN before starting the seller');\nconst DATABASE_URL = process.env.DATABASE_URL;\nif (!DATABASE_URL) throw new Error('Set DATABASE_URL before starting the seller');\nconst DEPLOYMENT_NAMESPACE = process.env.ADCP_DEPLOYMENT_NAMESPACE;\nif (!DEPLOYMENT_NAMESPACE || !/^[a-z][a-z0-9-]{0,23}$/.test(DEPLOYMENT_NAMESPACE)) {\n  throw new Error('Set ADCP_DEPLOYMENT_NAMESPACE to a unique lowercase slug (max 24 characters)');\n}\nconst SQL_NAMESPACE = DEPLOYMENT_NAMESPACE.replaceAll('-', '_');\nconst IDEMPOTENCY_TABLE = `${SQL_NAMESPACE}_adcp_idempotency`;\nconst TASK_NAMESPACE = `${DEPLOYMENT_NAMESPACE}:tasks`;\nconst pool = new Pool({ connectionString: DATABASE_URL });\npool.on('error', error => console.error('Unexpected idle PostgreSQL client error', error.message));"
    )
    .replace(
      'const buys = new Map<string, StoredRecord>();',
      'const buyStore = new PostgresStateStore(pool);\nconst BUY_COLLECTION = `${DEPLOYMENT_NAMESPACE}:starter_media_buys`;'
    )
    .replace(
      '      const stored = buys.get(req.media_buy_id);',
      '      const versioned = await buyStore.getWithVersion<StoredRecord>(BUY_COLLECTION, req.media_buy_id);\n      const stored = versioned?.data;'
    )
    .replace(
      '      buy.available_actions = available_actions;\n      // prettier-ignore',
      "      buy.available_actions = available_actions;\n      const saved = await buyStore.putIfMatch(BUY_COLLECTION, req.media_buy_id, stored, versioned.version);\n      if (!saved.ok) throw new AdcpError('CONFLICT', { message: 'Revision is stale' });\n      // prettier-ignore"
    )
    .replace(
      '    getMediaBuys: async (req, ctx) => ({\n      media_buys: (req.media_buy_ids ? req.media_buy_ids.flatMap(id => buys.get(id) ?? []) : [...buys.values()])\n        .filter(stored => stored.accountId === ctx.account.id)\n        .map(stored => stored.buy),\n    }),',
      '    getMediaBuys: async (req, ctx) => {\n      let selected: StoredRecord[];\n      if (req.media_buy_ids) {\n        selected = (\n          await Promise.all(req.media_buy_ids.map(id => buyStore.get<StoredRecord>(BUY_COLLECTION, id)))\n        ).filter((stored): stored is StoredRecord => stored !== null);\n      } else {\n        selected = [];\n        let cursor: string | undefined;\n        do {\n          const page = await buyStore.list<StoredRecord>(BUY_COLLECTION, {\n            filter: { accountId: ctx.account.id },\n            limit: 500,\n            ...(cursor && { cursor }),\n          });\n          selected.push(...page.items);\n          cursor = page.nextCursor;\n        } while (cursor);\n      }\n      return { media_buys: selected.filter(stored => stored.accountId === ctx.account.id).map(stored => stored.buy) };\n    },'
    )
    .replace(
      '      const existing = buys.get(mediaBuyId);',
      '      const existing = await buyStore.get<StoredRecord>(BUY_COLLECTION, mediaBuyId);'
    )
    .replace(
      '      buys.set(mediaBuyId, record);\n      return response;',
      "      const claimed = await buyStore.putIfMatch(BUY_COLLECTION, mediaBuyId, record, null);\n      if (!claimed.ok) {\n        const winner = await buyStore.get<StoredRecord>(BUY_COLLECTION, mediaBuyId);\n        if (!winner) throw new AdcpError('CONFLICT', { message: 'Media buy creation raced; retry safely' });\n        if (winner.requestDigest !== requestDigest) {\n          throw new AdcpError('CONFLICT', { message: 'Idempotency key was already used for another request' });\n        }\n        return winner.response;\n      }\n      return response;"
    )
    .replace(
      'const taskRegistry = createInMemoryTaskRegistry();\nconst idempotency = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });',
      'const taskRegistry = createPostgresTaskRegistry({\n  pool,\n  namespace: TASK_NAMESPACE,\n  storageId: `${DEPLOYMENT_NAMESPACE}:primary`,\n});\nconst idempotency = createIdempotencyStore({\n  backend: pgBackend(pool, { tableName: IDEMPOTENCY_TABLE }),\n  ttlSeconds: 86_400,\n});'
    )
    .replace(
      'authenticate: verifyApiKey',
      "      readinessCheck: async () => {\n        if (!idempotency.probe) throw new Error('Idempotency probe unavailable');\n        await Promise.all([\n          idempotency.probe(),\n          buyStore.get(BUY_COLLECTION, 'readiness_probe'),\n          taskRegistry.getTask('readiness_probe', { accountId: ACCOUNT_ID, ownerScope: `account:${ACCOUNT_ID}` }),\n        ]);\n      },\n      authenticate: verifyApiKey"
    );
}

async function handleInitCommand(args, { libraryVersion }) {
  if (args.length > 0) {
    validateArgs(args, {
      positionalCount: 1,
      valueFlags: ['--specialism', '--backend', '--dir'],
      booleanFlags: ['--help', '-h'],
    });
  }
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
Create a compact AdCP 3.2 seller

USAGE:
  adcp init seller --specialism <slug> --backend postgres [--dir path]

The target must be absent or empty. Existing files are never overwritten.
`);
    return 0;
  }
  if (args[0] !== 'seller') throw new Error(`Unsupported project kind: ${args[0]}`);
  const specialism = valueFlag(args, '--specialism', 'sales-non-guaranteed');
  const backend = valueFlag(args, '--backend', 'postgres');
  if (!SAFE_SPECIALISM.test(specialism)) throw new Error('--specialism must be a lowercase AdCP specialism slug');
  if (specialism !== 'sales-non-guaranteed') {
    throw new Error('The compact seller template currently supports sales-non-guaranteed');
  }
  if (!['postgres', 'memory'].includes(backend)) throw new Error('--backend must be postgres or memory');
  const target = path.resolve(valueFlag(args, '--dir', 'adcp-seller'));
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`Target directory is not empty: ${target}`);

  mkdirSync(path.join(target, 'src'), { recursive: true });
  mkdirSync(path.join(target, 'scripts'), { recursive: true });
  const source = readFileSync(path.join(__dirname, '..', 'examples', 'seller-3.2-starter.ts'), 'utf8').replace(
    "specialisms: ['sales-non-guaranteed'] as const",
    `specialisms: ['${specialism}'] as const`
  );
  writeFileSync(path.join(target, 'src', 'index.ts'), backend === 'postgres' ? postgresStarter(source) : source, {
    flag: 'wx',
  });
  writeJson(path.join(target, 'package.json'), {
    name: 'adcp-seller',
    private: true,
    type: 'module',
    scripts: {
      dev: 'node --env-file=.env --import tsx src/index.ts',
      build: 'tsc --noEmit',
      doctor: 'node --env-file=.env node_modules/@adcp/sdk/bin/adcp.js doctor',
      ...(backend === 'postgres' && { migrate: 'node --env-file=.env --import tsx scripts/migrate.ts' }),
    },
    dependencies: {
      '@adcp/sdk': `^${libraryVersion}`,
      ...(backend === 'postgres' && { pg: '^8.16.3' }),
    },
    devDependencies: {
      '@types/node': '^24.0.0',
      ...(backend === 'postgres' && { '@types/pg': '^8.15.5' }),
      tsx: '^4.20.0',
      typescript: '^5.9.0',
    },
  });
  writeJson(path.join(target, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts', 'scripts/**/*.ts'],
  });
  writeJson(path.join(target, PROJECT_FILE), {
    schemaVersion: 1,
    sdkMajor: Number(libraryVersion.split('.')[0]),
    kind: 'seller',
    specialism,
    backend,
    ...(backend === 'postgres' && { deploymentNamespaceEnv: 'ADCP_DEPLOYMENT_NAMESPACE' }),
    webhooks: false,
    requiredSecrets: [
      'ADCP_AUTH_TOKEN',
      'ADCP_ACCOUNT_ID',
      ...(backend === 'postgres' ? ['DATABASE_URL', 'ADCP_DEPLOYMENT_NAMESPACE'] : []),
    ],
  });
  writeFileSync(
    path.join(target, '.env.example'),
    `ADCP_AUTH_TOKEN=\nADCP_ACCOUNT_ID=\n${backend === 'postgres' ? 'DATABASE_URL=\nADCP_DEPLOYMENT_NAMESPACE=\n' : ''}PRODUCT_CATALOG_JSON=[]\n`,
    { flag: 'wx' }
  );
  writeFileSync(path.join(target, '.gitignore'), '.env\nnode_modules/\ndist/\n', { flag: 'wx' });
  if (backend === 'postgres') {
    writeFileSync(
      path.join(target, 'scripts', 'migrate.ts'),
      `import { getAdcpStateMigration, getCtxMetadataMigration, getDecisioningTaskRegistryBootstrap, getIdempotencyMigration } from '@adcp/sdk/server';\nimport { Pool } from 'pg';\n\nconst url = process.env.DATABASE_URL;\nif (!url) throw new Error('Set DATABASE_URL');\nconst deployment = process.env.ADCP_DEPLOYMENT_NAMESPACE;\nif (!deployment || !/^[a-z][a-z0-9-]{0,23}$/.test(deployment)) {\n  throw new Error('Set ADCP_DEPLOYMENT_NAMESPACE to a unique lowercase slug (max 24 characters)');\n}\nconst taskNamespace = \`\${deployment}:tasks\`;\nconst idempotencyTable = \`\${deployment.replaceAll('-', '_')}_adcp_idempotency\`;\nconst pool = new Pool({ connectionString: url });\ntry {\n  await pool.query(getIdempotencyMigration({ tableName: idempotencyTable }));\n  await pool.query(getCtxMetadataMigration());\n  await pool.query(getDecisioningTaskRegistryBootstrap({ namespace: taskNamespace }));\n  await pool.query(getAdcpStateMigration());\n  console.log('AdCP migrations applied');\n} finally {\n  await pool.end();\n}\n`,
      { flag: 'wx' }
    );
  }
  console.log(`Created ${backend} seller in ${target}`);
  console.log(
    `Next: cd ${target} && cp .env.example .env && edit .env && npm install${backend === 'postgres' ? ' && npm run migrate' : ''} && npm run doctor`
  );
  if (backend === 'memory') console.log('Note: doctor will warn that the memory backend is development-only.');
  return 0;
}

function addCheck(checks, name, ok, detail) {
  checks.push({ name, status: ok ? 'pass' : 'fail', detail });
}

function addWarning(checks, name, detail) {
  checks.push({ name, status: 'warn', detail });
}

function checkProductCatalog(checks) {
  const raw = process.env.PRODUCT_CATALOG_JSON;
  try {
    const products = JSON.parse(raw ?? '[]');
    if (!Array.isArray(products)) {
      addCheck(checks, 'product catalog', false, 'PRODUCT_CATALOG_JSON must be a JSON array');
      return;
    }
    const { ListProductsResponseSchema } = require('../dist/lib/schemas/index.js');
    const result = ListProductsResponseSchema.safeParse({
      status: 'completed',
      outcome: 'listed',
      products,
      feed_version: 'doctor',
      cache_scope: 'public',
    });
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 3)
        .map(issue => `${issue.path.join('.') || 'catalog'}: ${issue.message}`)
        .join('; ');
      addCheck(checks, 'product catalog', false, `invalid canonical products: ${issues}`);
      return;
    }
    if (products.length === 0) {
      addWarning(
        checks,
        'product catalog',
        raw === undefined
          ? 'PRODUCT_CATALOG_JSON is unset; seller will return honest empty inventory'
          : 'valid empty array; seller will return honest empty inventory'
      );
      return;
    }
    addCheck(checks, 'product catalog', true, `${products.length} canonical product(s)`);
  } catch (error) {
    addCheck(
      checks,
      'product catalog',
      false,
      error instanceof SyntaxError ? 'PRODUCT_CATALOG_JSON is not valid JSON' : 'catalog schema validation failed'
    );
  }
}

function postgresFailureDetail(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  if (code === '28P01') return 'database authentication failed';
  if (code === '42501') return 'database permission denied';
  if (code === '3D000') return 'database does not exist';
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
    return 'database unreachable or timed out';
  }
  return 'database connection or migration query failed';
}

async function checkPostgres(_root, config, checks, loadPostgres = () => require('pg')) {
  if (!process.env.DATABASE_URL) return;
  try {
    // Resolve the driver from this CLI installation, never from an inspected
    // --dir target. Loading target-owned modules would execute untrusted code
    // with the doctor's credential-bearing process environment.
    const { Pool } = loadPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const deployment = process.env.ADCP_DEPLOYMENT_NAMESPACE;
      const idempotencyTable = deployment ? `${deployment.replaceAll('-', '_')}_adcp_idempotency` : 'adcp_idempotency';
      const webhookTables = {
        deliveries: config.webhookTables?.deliveries ?? 'adcp_webhook_deliveries',
        outbox: config.webhookTables?.outbox ?? 'adcp_webhook_outbox',
      };
      const tables = [idempotencyTable, 'adcp_ctx_metadata', 'adcp_decisioning_tasks', 'adcp_state'];
      if (config.webhooks) tables.push(webhookTables.deliveries, webhookTables.outbox);
      const result = await pool.query(
        'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])',
        [tables]
      );
      const found = new Set(result.rows.map(row => `${row.table_name}.${row.column_name}`));
      const expected = {
        [idempotencyTable]: ['scoped_key', 'payload_hash', 'response', 'expires_at', 'retain_until'],
        adcp_ctx_metadata: ['scoped_key', 'value'],
        adcp_decisioning_tasks: ['registry_namespace', 'task_id', 'account_id', 'owner_scope', 'status'],
        adcp_state: ['collection', 'id', 'data', 'version'],
        ...(config.webhooks && {
          [webhookTables.deliveries]: [
            'publisher_scope',
            'tenant_scope',
            'delivery_id',
            'status',
            'idempotency_key',
            'payload_fingerprint',
            'first_attempt_at',
            'retain_until',
          ],
          [webhookTables.outbox]: [
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
          ],
        }),
      };
      const missing = Object.entries(expected).flatMap(([table, columns]) =>
        columns.filter(column => !found.has(`${table}.${column}`)).map(column => `${table}.${column}`)
      );
      addCheck(
        checks,
        'postgres migrations',
        missing.length === 0,
        missing.length ? `missing: ${missing.join(', ')}` : 'required table shapes present'
      );
    } finally {
      await pool.end();
    }
  } catch (error) {
    addCheck(checks, 'postgres connection', false, postgresFailureDetail(error));
  }
}

function releasePrecision(version) {
  if (typeof version !== 'string') return undefined;
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return undefined;
  return match[4] ? `${match[1]}.${match[2]}.${match[3] ?? '0'}${match[4]}` : `${match[1]}.${match[2]}`;
}

async function checkAgentProfile(agentName, dependencies, checks) {
  try {
    const saved = dependencies.resolveAgent(agentName);
    const protocol = saved.protocol ?? (await dependencies.detectProtocol(saved.url));
    const config = {
      id: 'doctor-target',
      name: 'doctor-target',
      agent_uri: saved.url,
      protocol,
      ...(saved.auth_token && { auth_token: saved.auth_token }),
      ...(saved.headers && { headers: saved.headers }),
    };
    const client = new dependencies.AdCPClient([config], {
      transport: { requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576 },
    });
    const capabilities = await client.agent(config.id).getCapabilities();
    addCheck(checks, 'profile discovery', Boolean(capabilities), `protocol=${protocol}`);
    const supportedVersions = Array.isArray(capabilities?.supportedVersions) ? capabilities.supportedVersions : [];
    const servedVersion = capabilities?.servedVersion;
    const matches = supportedVersions.length
      ? dependencies.isAdcpVersionSupported(dependencies.adcpVersion, supportedVersions)
      : releasePrecision(servedVersion) === releasePrecision(dependencies.adcpVersion);
    const observed = supportedVersions.length ? supportedVersions.join(',') : (servedVersion ?? 'unknown');
    addCheck(checks, 'agent schema drift', matches, `agent=${observed}, SDK=${dependencies.adcpVersion}`);
  } catch {
    addCheck(checks, 'profile discovery', false, 'agent capability discovery failed');
  }
}

async function handleDoctorCommand(args, dependencies) {
  validateArgs(args, {
    positionalCount: 0,
    valueFlags: ['--dir', '--agent'],
    booleanFlags: ['--json', '--help', '-h'],
  });
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: adcp doctor [--dir path] [--agent alias|url] [--json]\nChecks project shape, secrets, product catalog, SDK drift, PostgreSQL migrations, and optional live profile discovery.'
    );
    return 0;
  }
  const root = path.resolve(valueFlag(args, '--dir', process.cwd()));
  const json = args.includes('--json');
  const checks = [];
  const projectPath = path.join(root, PROJECT_FILE);
  if (!existsSync(projectPath)) {
    addCheck(checks, 'project config', false, `${PROJECT_FILE} not found`);
  } else {
    try {
      const config = JSON.parse(readFileSync(projectPath, 'utf8'));
      const expectedSecrets = [
        'ADCP_AUTH_TOKEN',
        'ADCP_ACCOUNT_ID',
        ...(config.backend === 'postgres' ? ['DATABASE_URL', 'ADCP_DEPLOYMENT_NAMESPACE'] : []),
      ];
      const configErrors = [
        ...(config.schemaVersion === 1 ? [] : ['schemaVersion must be 1']),
        ...(Number.isSafeInteger(config.sdkMajor) && config.sdkMajor > 0
          ? []
          : ['sdkMajor must be a positive integer']),
        ...(config.kind === 'seller' ? [] : ['kind must be seller']),
        ...(typeof config.specialism === 'string' && SAFE_SPECIALISM.test(config.specialism)
          ? []
          : ['specialism must be a lowercase slug']),
        ...(['memory', 'postgres'].includes(config.backend) ? [] : ['backend must be memory or postgres']),
        ...(typeof config.webhooks === 'boolean' ? [] : ['webhooks must be boolean']),
        ...(config.webhookTables === undefined ||
        (config.webhooks === true &&
          config.webhookTables &&
          typeof config.webhookTables === 'object' &&
          SAFE_WEBHOOK_TABLE.test(config.webhookTables.deliveries) &&
          SAFE_WEBHOOK_TABLE.test(config.webhookTables.outbox) &&
          config.webhookTables.deliveries !== config.webhookTables.outbox)
          ? []
          : ['webhookTables requires webhooks: true and valid deliveries/outbox SQL identifiers']),
        ...(Array.isArray(config.requiredSecrets) &&
        config.requiredSecrets.length === expectedSecrets.length &&
        expectedSecrets.every(secret => config.requiredSecrets.includes(secret))
          ? []
          : ['requiredSecrets does not match backend requirements']),
        ...(config.backend !== 'postgres' || config.deploymentNamespaceEnv === 'ADCP_DEPLOYMENT_NAMESPACE'
          ? []
          : ['deploymentNamespaceEnv must be ADCP_DEPLOYMENT_NAMESPACE']),
      ];
      addCheck(
        checks,
        'project config',
        configErrors.length === 0,
        configErrors.length ? configErrors.join('; ') : 'schema v1 seller'
      );

      const sdkPackagePath = path.join(root, 'node_modules', '@adcp', 'sdk', 'package.json');
      if (!existsSync(sdkPackagePath)) {
        addCheck(checks, 'SDK installation', false, '@adcp/sdk is not installed in this project');
      } else {
        const installedVersion = JSON.parse(readFileSync(sdkPackagePath, 'utf8')).version;
        const installedMajor = Number(String(installedVersion).split('.')[0]);
        addCheck(checks, 'SDK installation', true, `@adcp/sdk ${installedVersion}`);
        addCheck(
          checks,
          'SDK schema drift',
          config.sdkMajor === installedMajor,
          `project=${config.sdkMajor}, installed=${installedMajor}`
        );
      }
      for (const secret of expectedSecrets) {
        addCheck(checks, `secret ${secret}`, Boolean(process.env[secret]), process.env[secret] ? 'set' : 'missing');
      }
      checkProductCatalog(checks);
      if (config.webhooks) {
        addWarning(
          checks,
          'webhook runtime wiring',
          'table diagnostics only; verify the server uses runtime.serverConfig and schedules recoverOnce()'
        );
      }
      if (config.backend === 'memory') {
        addWarning(checks, 'durable backend', 'memory is development-only; choose postgres before production');
      } else if (config.backend === 'postgres') {
        const deployment = process.env.ADCP_DEPLOYMENT_NAMESPACE;
        if (deployment) {
          addCheck(
            checks,
            'deployment namespace',
            SAFE_DEPLOYMENT_NAMESPACE.test(deployment),
            SAFE_DEPLOYMENT_NAMESPACE.test(deployment)
              ? deployment
              : 'must be a unique lowercase slug (max 24 characters)'
          );
        }
        if (deployment && SAFE_DEPLOYMENT_NAMESPACE.test(deployment)) await checkPostgres(root, config, checks);
      } else {
        addCheck(checks, 'backend', false, `unsupported backend: ${config.backend}`);
      }
    } catch (error) {
      addCheck(checks, 'project config parse', false, error instanceof Error ? error.message : 'invalid JSON');
    }
  }
  const agent = valueFlag(args, '--agent', undefined);
  if (agent) await checkAgentProfile(agent, dependencies, checks);
  const ok = checks.length > 0 && checks.every(check => check.status !== 'fail');
  if (json) console.log(JSON.stringify({ checks, ok }, null, 2));
  else
    for (const check of checks) {
      const label = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
      console.log(`${label}  ${check.name}: ${check.detail}`);
    }
  if (!ok) process.exitCode = 1;
  return ok ? 0 : 1;
}

module.exports = {
  handleDoctorCommand,
  handleInitCommand,
  _test: { checkAgentProfile, checkPostgres, checkProductCatalog, postgresFailureDetail, validateArgs },
};
