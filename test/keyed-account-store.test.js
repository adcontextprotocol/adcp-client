'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createKeyedAccountStore,
  keyedAccountMemoryBackend,
  keyedAccountPgBackend,
  keyedAccountKvBackend,
  getKeyedAccountMigration,
} = require('../dist/lib/server');
const entry = {
  brand: { domain: 'acme.example' },
  operator: 'agency.example',
  sandbox: true,
  billing: 'agent',
  payment_terms: 'net_60',
};
const ctx = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer' } }, input: {} };
function createAccount(ref, id) {
  return {
    ...ref,
    id,
    name: 'Acme',
    status: 'active',
    billing: { invoicedTo: ref.billing },
    payment_terms: ref.payment_terms,
    ctx_metadata: {},
  };
}
function factory(backend, extra = {}) {
  return createKeyedAccountStore({
    backend,
    namespace: 'test-seller',
    principalKey: ctx => ctx.authInfo?.credential?.key_id,
    createAccount,
    ...extra,
  });
}

function backendContract(name, makeBackend) {
  test(`${name}: new-key re-sync, restarts, concurrent stores and duplicate batch entries preserve identity`, async () => {
    const backend = await makeBackend();
    let creates = 0;
    const store = factory(backend, {
      createAccount: (...args) => {
        creates++;
        return createAccount(...args);
      },
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => (index % 2 ? store : factory(backend)).upsert([entry], ctx))
    );
    assert.equal(new Set(results.map(rows => rows[0].account_id)).size, 1);
    assert.equal(results.filter(rows => rows[0].action === 'created').length, 1);
    if (name !== 'kv') assert.ok(creates <= 1);
    const restarted = factory(backend);
    const rows = await restarted.upsert([entry, entry], ctx);
    assert.deepEqual(
      rows.map(row => row.action),
      ['unchanged', 'unchanged']
    );
    assert.equal(rows[0].billing, 'agent');
    assert.equal(rows[0].payment_terms, 'net_60');
    assert.equal((await restarted.resolve(entry, ctx)).id, rows[0].account_id);
    assert.equal((await restarted.list({}, ctx)).items.length, 1);
  });
  test(`${name}: principal, namespace and full natural-key isolation`, async () => {
    const backend = await makeBackend();
    const store = factory(backend);
    const first = (await store.upsert([entry], ctx))[0];
    const otherCtx = { authInfo: { credential: { kind: 'api_key', key_id: 'other-buyer' } } };
    assert.equal(await store.resolve(entry, otherCtx), null);
    const second = (await store.upsert([entry], otherCtx))[0];
    assert.notEqual(first.account_id, second.account_id);
    const ns = factory(backend, { namespace: 'other-seller' });
    assert.equal(await ns.resolve(entry, ctx), null);
    assert.notEqual((await ns.upsert([entry], ctx))[0].account_id, first.account_id);
    const live = (await store.upsert([{ ...entry, sandbox: false }], ctx))[0];
    assert.notEqual(live.account_id, first.account_id);
    assert.equal(await store.resolve(undefined, ctx), null);
    assert.equal((await store.list({ sandbox: true }, ctx)).items.length, 1);
  });
  test(`${name}: rejected payment terms leave stored account intact, updates preserve id`, async () => {
    const backend = await makeBackend();
    const store = factory(backend);
    const first = (await store.upsert([entry], ctx))[0];
    const rejected = (await store.upsert([{ ...entry, payment_terms: 'net_30' }], ctx))[0];
    assert.equal(rejected.action, 'failed');
    assert.equal(rejected.account_id, first.account_id);
    assert.equal(rejected.status, 'active');
    assert.equal(rejected.payment_terms, 'net_60');
    assert.equal(rejected.errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
    assert.equal((await store.resolve(entry, ctx)).payment_terms, 'net_60');
    const updated = factory(backend, {
      updateAccount: (account, ref) => ({ ...account, payment_terms: ref.payment_terms }),
    });
    const row = (await updated.upsert([{ ...entry, payment_terms: 'net_30' }], ctx))[0];
    assert.equal(row.account_id, first.account_id);
    assert.equal(row.action, 'updated');
    assert.equal(row.payment_terms, 'net_30');
  });
  test(`${name}: dry-run and thrown callbacks cannot persist records`, async () => {
    const backend = await makeBackend();
    const store = factory(backend);
    const preview = (await store.upsert([entry], { ...ctx, input: { dry_run: true } }))[0];
    assert.equal(preview.action, 'created');
    assert.equal(await store.resolve(entry, ctx), null);
    const failing = factory(backend, {
      createAccount() {
        throw new Error('upstream unavailable');
      },
    });
    await assert.rejects(failing.upsert([entry], ctx), /upstream unavailable/);
    assert.equal(await store.resolve(entry, ctx), null);
    assert.equal((await store.upsert([entry], ctx))[0].account_id, preview.account_id);
  });
}
backendContract('memory', () => keyedAccountMemoryBackend());
backendContract('kv', () => {
  const data = new Map();
  return keyedAccountKvBackend({
    async get(key) {
      return data.get(key) ?? null;
    },
    async compareAndSwap(key, expected, value) {
      if ((data.get(key) ?? null) !== expected) return false;
      data.set(key, value);
      return true;
    },
  });
});

test('the store refuses anonymous writes and rejects callback ID changes/authInfo persistence', async () => {
  const backend = keyedAccountMemoryBackend();
  await assert.rejects(factory(backend).upsert([entry]), err => err.code === 'AUTH_REQUIRED');
  for (const extra of [{ id: 'wrong' }, { authInfo: ctx.authInfo }]) {
    const store = factory(backend, { createAccount: (ref, id) => ({ ...createAccount(ref, id), ...extra }) });
    assert.equal((await store.upsert([entry], ctx))[0].action, 'failed');
    assert.equal(await store.resolve(entry, ctx), null);
  }
});

test('memory transactions clone reads and writes and recover after failures', async () => {
  const backend = keyedAccountMemoryBackend();
  const store = factory(backend);
  await store.upsert([entry], ctx);
  (await store.resolve(entry, ctx)).id = 'poison';
  assert.notEqual((await store.resolve(entry, ctx)).id, 'poison');
});

test('Postgres table identifiers are validated before interpolation', () => {
  assert.throws(() => getKeyedAccountMigration({ tableName: 'accounts; DROP TABLE accounts' }), /Invalid/);
  assert.match(getKeyedAccountMigration(), /scope TEXT PRIMARY KEY/);
});

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const { after } = require('node:test');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let counter = 0;
  const tables = [];
  after(async () => {
    for (const tableName of tables) await pool.query(`DROP TABLE "${tableName}"`);
    await pool.end();
  });
  backendContract('postgres', async () => {
    const tableName = `keyed_accounts_test_${process.pid}_${counter++}`;
    tables.push(tableName);
    await pool.query(getKeyedAccountMigration({ tableName }));
    return keyedAccountPgBackend(pool, { tableName });
  });
} else test('Postgres backend contract (set DATABASE_URL)', { skip: true }, () => {});

test('exact list filters and cursors remain principal/filter scoped', async () => {
  const store = factory(keyedAccountMemoryBackend());
  const second = { ...entry, brand: { domain: 'second.example' } };
  const rows = await store.upsert([entry, second], ctx);
  assert.equal(
    (await store.list({ account: { account_id: rows[1].account_id } }, ctx)).items[0].id,
    rows[1].account_id
  );
  assert.equal((await store.list({ account: entry }, ctx)).items.length, 1);
  const first = await store.list({ pagination: { max_results: 1 } }, ctx);
  assert.equal(first.items.length, 1);
  const next = await store.list({ pagination: { cursor: first.nextCursor, max_results: 1 } }, ctx);
  assert.equal(next.items[0].id, rows[1].account_id);
  assert.equal(next.nextCursor, undefined);
  await assert.rejects(
    store.list({ sandbox: false, pagination: { cursor: first.nextCursor } }, ctx),
    err => err.code === 'INVALID_REQUEST'
  );
});

test('settings updates never create an account on a missing natural key', async () => {
  let creates = 0;
  const store = factory(keyedAccountMemoryBackend(), {
    createAccount(...args) {
      creates++;
      return createAccount(...args);
    },
  });
  const rows = await store.upsert([{ account: { brand: entry.brand, operator: entry.operator, sandbox: true } }], ctx);
  assert.equal(rows[0].errors[0].code, 'ACCOUNT_NOT_FOUND');
  assert.equal(creates, 0);
});

test('namespace and principal storage limits are enforced before persistence', async () => {
  assert.throws(() => createKeyedAccountStore({ backend: keyedAccountMemoryBackend(), createAccount }), /namespace/);
  const backend = keyedAccountMemoryBackend();
  const store = factory(backend, { maxAccountsPerPrincipal: 1 });
  const rows = await store.upsert([entry, { ...entry, brand: { domain: 'too-many.example' } }], ctx);
  assert.equal(rows[0].action, 'created');
  assert.equal(rows[1].action, 'failed');
  assert.equal((await store.list({}, ctx)).items.length, 1);
  const small = factory(keyedAccountMemoryBackend(), { maxBytesPerPrincipal: 1 });
  assert.equal((await small.upsert([entry], ctx))[0].action, 'failed');
  assert.equal(await small.resolve(entry, ctx), null);
});

test('callbacks cannot rewrite requested payment terms; pending accounts may omit terms', async () => {
  const backend = keyedAccountMemoryBackend();
  const store = factory(backend, {
    createAccount(ref, id) {
      ref.payment_terms = 'net_30';
      return createAccount(ref, id);
    },
  });
  assert.equal((await store.upsert([entry], ctx))[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal(await store.resolve(entry, ctx), null);
  const pending = factory(backend, {
    createAccount(ref, id) {
      return { ...createAccount(ref, id), status: 'pending_approval', payment_terms: undefined };
    },
  });
  assert.equal((await pending.upsert([entry], ctx))[0].action, 'created');
});

test('KV read-only previews do not issue compare-and-swap writes', async () => {
  let writes = 0;
  const store = factory(
    keyedAccountKvBackend({
      get: async () => null,
      async compareAndSwap() {
        writes++;
        return true;
      },
    })
  );
  await store.upsert([entry], { ...ctx, input: { dry_run: true } });
  assert.equal(writes, 0);
});

test('backend failures expose fixed messages and retain their cause', async () => {
  const secret = new Error('infrastructure credential');
  const kv = keyedAccountKvBackend({
    get: async () => {
      throw secret;
    },
    compareAndSwap: async () => {
      throw secret;
    },
  });
  await assert.rejects(
    kv.read('scope'),
    err => err.message === 'Keyed account KV operation failed.' && err.cause === secret
  );
  const pg = keyedAccountPgBackend({
    connect: async () => {
      throw secret;
    },
    query: async () => {
      throw secret;
    },
  });
  await assert.rejects(
    pg.read('scope'),
    err => err.message === 'Keyed account database operation failed.' && err.cause === secret
  );
  await assert.rejects(
    pg.transaction('scope', async () => ({ records: [], value: null })),
    err => err.cause === secret
  );
});

test('framework lookups share one scope read and are refreshed after writes', async () => {
  const backend = keyedAccountMemoryBackend();
  const originalRead = backend.read;
  let reads = 0;
  backend.read = async scope => {
    reads++;
    return originalRead(scope);
  };
  const store = factory(backend);
  const lookup = { ...ctx, toolName: 'sync_accounts', provisioning: false, input: {} };
  await Promise.all([store.resolve(entry, lookup), store.resolve(entry, lookup)]);
  assert.equal(reads, 1);
  await store.upsert([entry], lookup);
  assert.equal((await store.resolve(entry, lookup)).payment_terms, 'net_60');
  assert.equal(reads, 2);
});

test('dry-run flag mutations in callbacks cannot turn previews into committed writes', async () => {
  const backend = keyedAccountMemoryBackend();
  const store = factory(backend, {
    createAccount(ref, id, requestCtx) {
      requestCtx.input.dry_run = false;
      return createAccount(ref, id);
    },
  });
  await store.upsert([entry], { ...ctx, input: { dry_run: true } });
  assert.equal(await store.resolve(entry, ctx), null);
});

test('one callback cannot rewrite a later entry commercial request', async () => {
  const entries = [entry, { ...entry, brand: { domain: 'second.example' } }];
  const store = factory(keyedAccountMemoryBackend(), {
    createAccount(ref, id, requestCtx) {
      requestCtx.input.accounts[1].payment_terms = 'net_30';
      return createAccount(ref, id);
    },
  });
  const rows = await store.upsert(entries, { ...ctx, input: { accounts: entries } });
  assert.equal(rows[1].payment_terms, 'net_60');
});

test('failed PostgreSQL rollback destroys the pooled client', async () => {
  const calls = [];
  const backend = keyedAccountPgBackend({
    connect: async () => ({
      async query(sql) {
        if (sql === 'ROLLBACK') throw new Error('broken connection');
        return { rows: [{ records: [] }] };
      },
      release(discard) {
        calls.push(discard);
      },
    }),
  });
  await assert.rejects(
    backend.transaction('scope', async () => {
      throw new Error('callback failed');
    }),
    /callback failed/
  );
  assert.deepEqual(calls, [true]);
});

test('KV retries preserve the original key and commercial data after callback mutation', async () => {
  const data = new Map();
  let swaps = 0;
  const backend = keyedAccountKvBackend({
    get: async key => data.get(key) ?? null,
    async compareAndSwap(key, expected, value) {
      if (++swaps === 1) return false;
      data.set(key, value);
      return true;
    },
  });
  const seen = [];
  const store = factory(backend, {
    createAccount(ref, id) {
      const account = createAccount(ref, id);
      account.brand = { ...ref.brand };
      account.billing_entity = structuredClone(ref.billing_entity);
      seen.push(structuredClone(ref));
      ref.brand.domain = 'mutated.example';
      ref.billing_entity.name = 'mutated';
      return account;
    },
  });
  const input = { ...entry, billing_entity: { name: 'original' } };
  const result = (await store.upsert([input], ctx))[0];
  assert.equal(result.action, 'created');
  assert.equal(swaps, 2);
  assert.deepEqual(
    seen.map(ref => ref.brand.domain),
    ['acme.example', 'acme.example']
  );
  assert.deepEqual(
    seen.map(ref => ref.billing_entity.name),
    ['original', 'original']
  );
  assert.equal((await store.resolve(entry, ctx)).billing_entity.name, 'original');
});

test('callback inputs allow only schema request fields and require explicit billing-entity updates', async () => {
  let received;
  const store = factory(keyedAccountMemoryBackend(), {
    createAccount(ref, id) {
      received = ref;
      return createAccount(ref, id);
    },
  });
  await store.upsert(
    [
      {
        ...entry,
        credit_limit: { amount: 999999 },
        rate_card: 'buyer-selected',
        ctx_metadata: { injected: true },
        status: 'suspended',
      },
    ],
    ctx
  );
  for (const key of ['credit_limit', 'rate_card', 'ctx_metadata', 'status']) assert.equal(key in received, false);
  const result = (await store.upsert([{ ...entry, billing_entity: { name: 'new entity' } }], ctx))[0];
  assert.equal(result.action, 'failed');
  assert.equal(result.errors[0].code, 'UNSUPPORTED_FEATURE');
});

test('canonical domain/country validation cannot create alternate accounts for invalid variants', async () => {
  const store = factory(keyedAccountMemoryBackend());
  await store.upsert([entry], ctx);
  for (const variant of [
    { ...entry, brand: { domain: 'Acme.example' } },
    { ...entry, operator: 'Agency.example' },
    { ...entry, brand: { domain: 'acme.example', countries: ['us'] } },
    { ...entry, brand: { domain: 'acme.example', countries: ['US', 'US'] } },
  ]) {
    await assert.rejects(store.upsert([variant], ctx), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal((await store.list({}, ctx)).items.length, 1);
});

test('stable caller scopes preserve accounts across credential rotations', async () => {
  const store = factory(keyedAccountMemoryBackend(), { principalKey: ctx => ctx.authInfo?.extra?.tenantId });
  const before = { ...ctx, authInfo: { ...ctx.authInfo, extra: { tenantId: 'buyer-company' } } };
  const after = {
    ...ctx,
    authInfo: { credential: { kind: 'api_key', key_id: 'rotated-key' }, extra: { tenantId: 'buyer-company' } },
  };
  const first = (await store.upsert([entry], before))[0];
  const second = (await store.upsert([entry], after))[0];
  assert.equal(second.account_id, first.account_id);
  assert.equal(second.action, 'unchanged');
});

test('unsupported notification and reporting declarations are refused without a write', async () => {
  const store = factory(keyedAccountMemoryBackend());
  for (const field of ['notification_configs', 'reporting_delivery_configs', 'preferred_reporting_protocol']) {
    const response = (await store.upsert([{ ...entry, [field]: [] }], ctx))[0];
    assert.equal(response.action, 'failed');
    assert.equal(response.errors[0].code, 'UNSUPPORTED_FEATURE');
    assert.equal(await store.resolve(entry, ctx), null);
  }
});

test('dry previews use only backend reads, without opening a write transaction', async () => {
  const backend = keyedAccountMemoryBackend();
  const store = factory({
    read: scope => backend.read(scope),
    transaction() {
      throw new Error('preview must not acquire a write lock');
    },
  });
  assert.equal((await store.upsert([entry], { ...ctx, input: { dry_run: true } }))[0].action, 'created');
});

test('same-principal PostgreSQL writers queue before acquiring connections across backend instances', async () => {
  let connections = 0;
  const pool = {
    async connect() {
      connections++;
      return {
        async query() {
          return { rows: [{ records: [] }] };
        },
        release() {},
      };
    },
  };
  let unblock;
  const gate = new Promise(resolve => {
    unblock = resolve;
  });
  let started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const first = keyedAccountPgBackend(pool).transaction('busy', async records => {
    started();
    await gate;
    return { records, value: 'first' };
  });
  await ready;
  const second = keyedAccountPgBackend(pool).transaction('busy', async records => ({ records, value: 'second' }));
  assert.equal(
    await keyedAccountPgBackend(pool).transaction('other', async records => ({ records, value: 'other' })),
    'other'
  );
  assert.equal(connections, 2);
  unblock();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(connections, 3);
});

if (process.env.DATABASE_URL) {
  test('PostgreSQL lock waits are bounded while unrelated principals remain available', async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    const tableName = `keyed_accounts_lock_${process.pid}`;
    let lock;
    try {
      await pool.query(getKeyedAccountMigration({ tableName }));
      await pool.query(`INSERT INTO "${tableName}" (scope) VALUES ('busy')`);
      lock = await pool.connect();
      await lock.query('BEGIN');
      await lock.query(`SELECT records FROM "${tableName}" WHERE scope = 'busy' FOR UPDATE`);
      const backend = keyedAccountPgBackend(pool, { tableName, lockTimeoutMs: 150 });
      const blocked = backend.transaction('busy', async records => ({ records, value: 'blocked' }));
      const refused = assert.rejects(blocked, error => error.cause?.code === '55P03');
      assert.deepEqual(await backend.read('other'), []);
      assert.equal(await backend.transaction('other', async records => ({ records, value: 'available' })), 'available');
      await refused;
    } finally {
      if (lock) {
        await lock.query('ROLLBACK');
        lock.release();
      }
      await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
      await pool.end();
    }
  });
}
