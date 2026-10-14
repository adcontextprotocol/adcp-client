const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createKeyedAccountStore,
  memoryKeyedAccountBackend,
  getKeyedAccountMigration,
  pgKeyedAccountBackend,
  redisKeyedAccountBackend,
} = require('../../dist/lib/server/index.js');
const ctx = { authInfo: { credential: { kind: 'api_key', key_id: 'caller' } } };
const entry = {
  brand: { domain: 'brand.example' },
  operator: 'operator.example',
  billing: 'agent',
  payment_terms: 'net_60',
};
const buildAccount = (ref, { accountId }) => ({
  id: accountId,
  name: 'Brand',
  status: 'active',
  mode: ref.sandbox ? 'sandbox' : 'live',
  billing: { invoicedTo: ref.billing ?? 'agent' },
  payment_terms: ref.payment_terms ?? 'net_60',
  ctx_metadata: {},
  authInfo: { token: 'do-not-persist' },
});
function store(backend = memoryKeyedAccountBackend(), extra = {}) {
  return createKeyedAccountStore({ backend, namespace: 'seller', buildAccount, ...extra });
}

test('stable IDs survive new requests, store reconstruction and elapsed days without TTL', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const backend = memoryKeyedAccountBackend();
  const first = await store(backend).upsert([entry], ctx);
  t.mock.timers.tick(30 * 86_400_000);
  const second = await store(backend).upsert([entry], ctx);
  assert.equal(first[0].action, 'created');
  assert.equal(second[0].action, 'unchanged');
  assert.equal(first[0].account_id, second[0].account_id);
  assert.ok(!JSON.stringify(await store(backend).resolve(entry, ctx)).includes('do-not-persist'));
});
test('terms are accepted or rejected before persistence, preserving the old terms', async () => {
  const backend = memoryKeyedAccountBackend();
  await store(backend).upsert([entry], ctx);
  const refusal = store(backend, {
    buildAccount: (ref, context) => buildAccount({ ...ref, payment_terms: 'net_30' }, context),
  });
  assert.equal((await refusal.upsert([entry], ctx))[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal((await refusal.resolve(entry, ctx)).payment_terms, 'net_60');
  const rows = await store(backend).upsert([{ ...entry, payment_terms: 'net_30' }], ctx);
  assert.equal(rows[0].action, 'updated');
  assert.equal((await store(backend).list({}, ctx)).items[0].payment_terms, 'net_30');
});
test('parallel first syncs and repeated keys within one batch converge on one record', async () => {
  const backend = memoryKeyedAccountBackend();
  const clients = [store(backend), store(backend)];
  const results = await Promise.all(clients.map(s => s.upsert([entry, entry], ctx)));
  assert.equal(new Set(results.flat().map(row => row.account_id)).size, 1);
  assert.equal(results.flat().filter(row => row.action === 'created').length, 1);
  assert.equal((await clients[0].list({}, ctx)).items.length, 1);
});
test('natural key variants, principals and seller namespaces stay isolated', async () => {
  const backend = memoryKeyedAccountBackend();
  const accountStore = store(backend);
  const refs = [
    entry,
    ...[{ sandbox: true }, { currency: 'USD' }, { timezone: 'UTC' }, { operator_unit: { id: 'unit' } }].map(extra => ({
      ...entry,
      ...extra,
    })),
  ];
  const rows = await accountStore.upsert(refs, ctx);
  assert.equal(new Set(rows.map(row => row.account_id)).size, refs.length);
  const other = { authInfo: { credential: { kind: 'api_key', key_id: 'other' } } };
  assert.equal(await accountStore.resolve({ account_id: rows[0].account_id }, other), null);
  assert.equal(await store(backend, { namespace: 'another-seller' }).resolve(entry, ctx), null);
  assert.equal(await accountStore.resolve(undefined, ctx), null);
});
test('dry runs do not persist and additive syncs keep earlier brands', async () => {
  const s = store();
  await s.upsert([entry], { ...ctx, input: { dry_run: true } });
  assert.equal(await s.resolve(entry, ctx), null);
  await s.upsert([entry], ctx);
  await s.upsert([{ ...entry, brand: { domain: 'another.example' } }], ctx);
  assert.equal((await s.list({}, ctx)).items.length, 2);
});
test('lookup/list copies cannot modify persisted state; cursors cannot cross principals or revisions', async () => {
  const s = store();
  await s.upsert([entry, { ...entry, brand: { domain: 'another.example' } }], ctx);
  const account = await s.resolve(entry, ctx);
  account.payment_terms = 'net_30';
  assert.equal((await s.resolve(entry, ctx)).payment_terms, 'net_60');
  const page = await s.list({ pagination: { max_results: 1 } }, ctx);
  assert.equal((await s.list({ pagination: { cursor: page.nextCursor } }, ctx)).items.length, 1);
  await assert.rejects(
    s.list(
      { pagination: { cursor: page.nextCursor } },
      { authInfo: { credential: { kind: 'api_key', key_id: 'other' } } }
    ),
    { code: 'INVALID_REQUEST' }
  );
  await s.upsert([{ ...entry, payment_terms: 'net_30' }], ctx);
  await assert.rejects(s.list({ pagination: { cursor: page.nextCursor } }, ctx), { code: 'INVALID_REQUEST' });
});
test('backend CAS rejects stale snapshots and cannot overwrite new state', async () => {
  const backend = memoryKeyedAccountBackend();
  assert.equal(await backend.compareAndSwap('scope', null, []), true);
  const snapshot = await backend.load('scope');
  assert.equal(await backend.compareAndSwap('scope', null, []), false);
  assert.equal(await backend.compareAndSwap('scope', snapshot.version, []), true);
  assert.equal(await backend.compareAndSwap('scope', snapshot.version, []), false);
});

test('buyer sandbox input cannot grant test authority', async () => {
  const s = store(undefined, {
    buildAccount: (ref, context) => ({ ...buildAccount(ref, context), mode: undefined, sandbox: undefined }),
  });
  const rows = await s.upsert([{ ...entry, sandbox: true }], ctx);
  assert.equal(rows[0].action, 'failed');
  assert.equal(await s.resolve({ ...entry, sandbox: true }, ctx), null);
});
test('dryRun is explicit, missing settings cannot provision, and account limits apply before callbacks', async () => {
  const calls = [];
  const s = store(undefined, {
    maxAccounts: 1,
    buildAccount: (ref, context) => {
      calls.push(context);
      return buildAccount(ref, context);
    },
  });
  await s.upsert([entry], { ...ctx, input: { dry_run: true } });
  assert.equal(calls[0].dryRun, true);
  await s.upsert([entry], ctx);
  assert.equal((await s.upsert([{ ...entry, brand: { domain: 'over-limit.example' } }], ctx))[0].action, 'failed');
  const before = calls.length;
  await assert.rejects(s.upsert([entry, { account: { account_id: 'unknown' } }], ctx), { code: 'ACCOUNT_NOT_FOUND' });
  assert.equal(calls.length, before);
  const empty = store();
  assert.equal((await empty.upsert([{ account: entry }], ctx))[0].errors[0].code, 'UNSUPPORTED_PROVISIONING');
});
test('JSON normalisation preserves unchanged syncs with undefined metadata', async () => {
  const s = store(undefined, {
    buildAccount: (ref, context) => ({
      ...buildAccount(ref, context),
      setup: undefined,
      ctx_metadata: { value: undefined },
    }),
  });
  await s.upsert([entry], ctx);
  assert.equal((await s.upsert([entry], ctx))[0].action, 'unchanged');
});
test('Postgres migration rejects SQL identifiers and the backend binds all values', async () => {
  assert.throws(() => getKeyedAccountMigration({ tableName: 'accounts;DROP TABLE x' }));
  assert.match(getKeyedAccountMigration(), /scope TEXT PRIMARY KEY/);
  const queries = [];
  const backend = pgKeyedAccountBackend({
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  });
  assert.equal(await backend.compareAndSwap('untrusted-scope', null, []), true);
  assert.equal(await backend.compareAndSwap('untrusted-scope', 'prior', []), true);
  assert.match(queries[0].sql, /ON CONFLICT \(scope\) DO NOTHING/);
  assert.match(queries[1].sql, /AND version = \$4/);
  assert.ok(queries.every(query => !query.sql.includes('untrusted-scope')));
});
test('Redis CAS script uses atomic version matching without expiry', async () => {
  let captured;
  const backend = redisKeyedAccountBackend({
    get: async () => null,
    eval: async (script, args) => {
      captured = { script, args };
      return 1;
    },
  });
  assert.equal(await backend.load('scope'), null);
  assert.equal(await backend.compareAndSwap('scope', null, []), true);
  assert.equal(captured.args.arguments[0], '');
  assert.ok(!/EXPIRE|PEXPIRE|SETEX/.test(captured.script));
  assert.match(captured.script, /cjson.decode\(current\).version/);
});

test('backend errors have fixed messages and preserve the underlying cause', async () => {
  const cause = new Error('secret upstream password at internal.example');
  const fail = async () => {
    throw cause;
  };
  for (const backend of [pgKeyedAccountBackend({ query: fail }), redisKeyedAccountBackend({ get: fail, eval: fail })]) {
    for (const operation of [() => backend.load('scope'), () => backend.compareAndSwap('scope', null, [])]) {
      await assert.rejects(operation(), error => {
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes('secret'));
        return true;
      });
    }
  }
});
test('list sandbox filters use seller authority', async () => {
  const s = store(undefined, { buildAccount: (ref, context) => ({ ...buildAccount(ref, context), mode: 'sandbox' }) });
  await s.upsert([entry], ctx);
  assert.equal((await s.list({ sandbox: true }, ctx)).items.length, 1);
  assert.equal((await s.list({ sandbox: false }, ctx)).items.length, 0);
});
