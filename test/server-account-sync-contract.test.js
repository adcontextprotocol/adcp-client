'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AccountNotFoundError } = require('../dist/lib/server/decisioning/account');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');
const { randomUUID } = require('node:crypto');
process.env.NODE_ENV = 'test';
const entry = {
  brand: { domain: 'acme.example' },
  operator: 'agency.example',
  billing: 'agent',
  payment_terms: 'net_60',
  sandbox: true,
};
const account = {
  id: 'acct_1',
  name: 'Acme',
  brand: entry.brand,
  operator: entry.operator,
  status: 'active',
  billing: { invoicedTo: 'agent' },
  payment_terms: 'net_60',
  sandbox: true,
  ctx_metadata: {},
};
const row = {
  account_id: account.id,
  brand: entry.brand,
  operator: entry.operator,
  action: 'unchanged',
  status: 'active',
  sandbox: true,
};
function setup(store, opts = {}) {
  const diagnostics = [];
  const warnings = [];
  const server = createAdcpServerFromPlatform(
    {
      capabilities: {
        specialisms: ['signal-marketplace'],
        pricingModels: ['cpm'],
        supportedBillings: ['agent', 'operator'],
      },
      signals: { getSignals: async () => ({ signals: [] }), activateSignal: async () => ({}) },
      accounts: { onDiagnostic: d => diagnostics.push(d), ...store },
    },
    {
      name: 'account-contract',
      version: '1.0',
      validation: { requests: 'off', responses: 'off' },
      logger: {
        debug() {},
        info() {},
        error() {},
        warn(message, fields) {
          warnings.push({ message, fields });
        },
      },
      ...opts,
    }
  );
  const call = (entries = [entry], extra = {}) =>
    server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'sync_accounts',
          arguments: { accounts: entries, idempotency_key: randomUUID(), ...extra },
        },
      },
      { authInfo: { credential: { kind: 'api_key', key_id: 'buyer' } } }
    );
  return { server, call, diagnostics, warnings };
}

test('lookup is principal scoped, includes full natural key, and passes aligned existing snapshots without splitting the batch', async () => {
  const captures = [];
  const second = {
    ...entry,
    brand: { domain: 'other.example' },
    currency: 'EUR',
    timezone: 'Europe/Paris',
    operator_unit: { id: 'desk' },
  };
  const { call } = setup({
    resolve: async (ref, ctx) => {
      if (!ref) return null;
      captures.push({ ref, ctx });
      return ref.brand.domain === entry.brand.domain ? account : null;
    },
    upsert: async (refs, ctx) => {
      assert.equal(refs.length, 2);
      const { ctx_metadata, ...snapshot } = account;
      assert.deepEqual(ctx.existing, [snapshot, null]);
      assert.equal(ctx.authInfo.credential.key_id, 'buyer');
      assert.notEqual(ctx.existing[0], account);
      return [
        row,
        {
          ...row,
          brand: second.brand,
          account_id: 'new',
          action: 'created',
          billing: 'agent',
          payment_terms: 'net_60',
        },
      ];
    },
  });
  const result = await call([entry, second]);
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(captures.length, 3);
  assert.deepEqual(captures[0].ref, { brand: entry.brand, operator: entry.operator, sandbox: true });
  assert.equal(captures[0].ctx.provisioning, false);
  assert.equal(captures[0].ctx.toolName, 'sync_accounts');
  assert.equal(captures[1].ref.currency, 'EUR');
  assert.equal(result.structuredContent.accounts[0].billing, 'agent');
  assert.equal(result.structuredContent.accounts[0].payment_terms, 'net_60');
});

for (const violation of [{ account_id: 'new' }, { action: 'created' }]) {
  test(`identity violation ${JSON.stringify(violation)} warns by default and fails only in strict mode`, async () => {
    for (const strictIdempotency of [false, true]) {
      const source = Object.freeze({ ...row, billing: 'agent', payment_terms: 'net_60', ...violation });
      const { call, diagnostics, warnings } = setup({
        strictIdempotency,
        resolve: async () => account,
        upsert: async () => [source],
      });
      const result = await call();
      assert.equal(result.structuredContent.accounts[0].action, strictIdempotency ? 'failed' : source.action);
      if (strictIdempotency) assert.equal(result.structuredContent.accounts[0].errors[0].code, 'SYNC_FAILED');
      assert.equal(diagnostics[0].code, 'ACCOUNT_IDEMPOTENCY_VIOLATION');
      assert.equal(warnings[0].fields.index, 0);
      assert.equal(JSON.stringify(warnings).includes('acct_1'), false);
    }
  });
}

test('explicit active terms mismatch becomes PAYMENT_TERMS_NOT_SUPPORTED in strict mode', async () => {
  for (const payment_terms of ['net_30']) {
    const { call, diagnostics } = setup({
      strictIdempotency: true,
      resolve: async () => null,
      upsert: async () => [{ ...row, action: 'created', billing: 'agent', payment_terms }],
    });
    const result = await call();
    assert.equal(result.structuredContent.accounts[0].action, 'failed');
    assert.equal(result.structuredContent.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
    assert.ok(diagnostics.some(d => d.code === 'PAYMENT_TERMS_MISMATCH'));
  }
});

test('pending rows may omit terms but cannot explicitly remap them; rejected rows are not graded', async () => {
  for (const status of ['pending_approval', 'rejected']) {
    const { call, diagnostics } = setup({
      strictIdempotency: true,
      resolve: async () => null,
      upsert: async () => [{ ...row, status, action: 'created', billing: 'agent', payment_terms: 'net_30' }],
    });
    const response = (await call()).structuredContent.accounts[0];
    assert.equal(response.status, status);
    assert.equal(response.action, status === 'pending_approval' ? 'failed' : 'created');
    assert.equal(
      diagnostics.some(d => d.code === 'PAYMENT_TERMS_MISMATCH'),
      status === 'pending_approval'
    );
  }
});

test('existing snapshot cannot be rewritten by the adopter to hide an identity violation', async () => {
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async (_refs, ctx) => {
      ctx.existing[0].id = 'new';
      return [{ ...row, account_id: 'new' }];
    },
  });
  assert.equal((await call()).structuredContent.accounts[0].action, 'failed');
  assert.equal(account.id, 'acct_1');
});

test('lookup not found permits creation; other lookup errors stop writes', async () => {
  let writes = 0;
  const { call } = setup({
    resolve: async () => {
      throw new AccountNotFoundError();
    },
    upsert: async () => {
      writes++;
      return [{ ...row, action: 'created' }];
    },
  });
  await call();
  assert.equal(writes, 1);
  const unavailable = setup({
    strictIdempotency: true,
    resolve: async () => {
      throw new Error('unavailable');
    },
    upsert: async () => {
      writes++;
      return [row];
    },
  });
  assert.equal((await unavailable.call()).isError, true);
  assert.equal(writes, 1);
});

test('indices remain aligned when commercial policy refuses an earlier entry', async () => {
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async refs => {
      assert.equal(refs.length, 1);
      return [{ ...row, payment_terms: 'net_30' }];
    },
  });
  const result = await call([{ ...entry, billing: 'advertiser' }, entry]);
  assert.equal(result.structuredContent.accounts[0].action, 'failed');
  assert.equal(result.structuredContent.accounts[1].errors[0].field, 'accounts[1].payment_terms');
  assert.equal(diagnostics[0].index, 1);
});

test('idempotency replay skips the second upsert while a new key runs the natural-key guard', async () => {
  let existing = null;
  let writes = 0;
  const { call, diagnostics } = setup(
    {
      resolve: async () => existing,
      upsert: async () => {
        writes++;
        existing = account;
        return [{ ...row, action: 'created', billing: 'agent', payment_terms: 'net_60' }];
      },
    },
    { idempotency: createIdempotencyStore({ backend: memoryBackend() }), resolveIdempotencyPrincipal: () => 'buyer' }
  );
  const key = randomUUID();
  await call([entry], { idempotency_key: key });
  await call([entry], { idempotency_key: key });
  assert.equal(writes, 1);
  await call();
  assert.equal(writes, 2);
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_IDEMPOTENCY_VIOLATION'));
});

test('list_accounts incomplete agent billing produces a typed diagnostic', async () => {
  const { server, diagnostics } = setup({
    resolve: async () => null,
    list: async () => ({ items: [{ ...account, payment_terms: undefined }], nextCursor: null }),
  });
  await server.dispatchTestRequest({ method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
  assert.deepEqual(diagnostics, [{ code: 'ACCOUNT_BILLING_INCOMPLETE', toolName: 'list_accounts', index: 0 }]);
});

test('throwing diagnostic hooks/loggers cannot turn a compatibility diagnostic into failure', async () => {
  const { call } = setup(
    {
      resolve: async () => account,
      upsert: async () => [{ ...row, action: 'created' }],
      onDiagnostic: async () => {
        throw new Error('secret');
      },
    },
    {
      logger: {
        warn() {
          throw new Error('secret');
        },
        debug() {},
        info() {},
        error() {},
      },
    }
  );
  assert.equal((await call()).structuredContent.accounts[0].action, 'created');
});

test('adopter mutations cannot rewrite the requested commercial contract or nested snapshots', async () => {
  const requested = { ...entry };
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async (refs, ctx) => {
      ctx.existing[0].billing.invoicedTo = 'operator';
      assert.equal(ctx.existing[0].ctx_metadata, undefined);
      refs[0].payment_terms = 'net_30';
      return [{ ...row, action: 'updated', billing: 'agent', payment_terms: 'net_30' }];
    },
  });
  assert.equal((await call([requested])).structuredContent.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal(account.billing.invoicedTo, 'agent');
  assert.deepEqual(account.ctx_metadata, {});
});

test('missing response terms come from a fresh post-write lookup, preserving changes and exposing remaps', async () => {
  for (const requestedTerms of ['net_30', 'net_60']) {
    let stored = account;
    const { call } = setup({
      strictIdempotency: true,
      resolve: async () => stored,
      upsert: async () => {
        stored = { ...account, payment_terms: 'net_30' };
        return [{ ...row, action: 'updated', billing: 'agent' }];
      },
    });
    const response = (await call([{ ...entry, payment_terms: requestedTerms }])).structuredContent.accounts[0];
    assert.equal(response.action, requestedTerms === 'net_30' ? 'updated' : 'failed');
    if (requestedTerms === 'net_30') assert.equal(response.payment_terms, 'net_30');
    else assert.equal(response.errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  }
});

test('compatibility mode warns on lookup failure and still dispatches the original batch', async () => {
  let writes = 0;
  const { call, diagnostics } = setup({
    resolve: async ref => {
      if (ref) throw new Error('unsupported lookup');
      return null;
    },
    upsert: async () => {
      writes++;
      return [{ ...row, billing: 'agent', payment_terms: 'net_60' }];
    },
  });
  assert.notEqual((await call()).isError, true);
  assert.equal(writes, 1);
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_LOOKUP_FAILED'));
});

test('combined identity and terms violations retain terminal identity failure', async () => {
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async () => [
      { ...row, account_id: 'duplicate', action: 'created', billing: 'agent', payment_terms: 'net_30' },
    ],
  });
  const result = (await call()).structuredContent.accounts[0];
  assert.equal(result.errors[0].code, 'SYNC_FAILED');
  assert.equal(result.errors[0].recovery, 'terminal');
  assert.ok(diagnostics.some(d => d.code === 'PAYMENT_TERMS_MISMATCH'));
});

test('accepted operator payment terms can be completed from current stored state', async () => {
  const stored = { ...account, billing: { invoicedTo: 'operator' } };
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => stored,
    upsert: async () => [{ ...row, action: 'updated', billing: 'operator' }],
  });
  const result = (await call([{ ...entry, billing: 'operator' }])).structuredContent.accounts[0];
  assert.equal(result.action, 'updated');
  assert.equal(result.payment_terms, 'net_60');
});

test('dry-run omissions are neither completed from old terms nor falsely rejected', async () => {
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async (_refs, ctx) => {
      ctx.input.dry_run = false;
      return [{ ...row, action: 'updated', billing: 'agent' }];
    },
  });
  const result = (await call([{ ...entry, payment_terms: 'net_30' }], { dry_run: true })).structuredContent;
  assert.equal(result.dry_run, true);
  assert.equal(result.accounts[0].action, 'updated');
  assert.equal(result.accounts[0].payment_terms, undefined);
});

test('duplicate creates within one batch are diagnosed and fail only under strict enforcement', async () => {
  for (const strictIdempotency of [false, true]) {
    const { call, diagnostics } = setup({
      strictIdempotency,
      resolve: async () => null,
      upsert: async () => [
        { ...row, account_id: 'first', action: 'created', billing: 'agent', payment_terms: 'net_60' },
        { ...row, account_id: 'second', action: 'created', billing: 'agent', payment_terms: 'net_60' },
      ],
    });
    const result = (await call([entry, entry])).structuredContent.accounts;
    assert.equal(result[0].action, 'created');
    assert.equal(result[1].action, strictIdempotency ? 'failed' : 'created');
    assert.equal(result[1].account_id, 'second');
    assert.equal(result[1].status, 'active');
    assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_IDEMPOTENCY_VIOLATION' && d.index === 1));
  }
});

test('strict checks align reordered rows before inspecting identity and commercial terms', async () => {
  const second = { ...entry, brand: { domain: 'second.example' }, payment_terms: 'net_30' };
  const stored = { ...account, id: 'second', brand: second.brand, payment_terms: 'net_30' };
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async ref => (ref?.brand?.domain === second.brand.domain ? stored : ref ? account : null),
    upsert: async () => [
      { ...row, account_id: stored.id, brand: second.brand, billing: 'agent', payment_terms: 'net_30' },
      { ...row, billing: 'agent', payment_terms: 'net_60' },
    ],
  });
  const result = (await call([entry, second])).structuredContent.accounts;
  assert.deepEqual(
    result.map(row => row.account_id),
    [account.id, stored.id]
  );
  assert.deepEqual(
    result.map(row => row.action),
    ['unchanged', 'unchanged']
  );
  assert.deepEqual(diagnostics, []);
});

test('a failed post-write read diagnoses uncertainty without claiming unsupported terms', async () => {
  let committed = false;
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => {
      if (committed) throw new Error('read failed');
      return account;
    },
    upsert: async () => {
      committed = true;
      return [{ ...row, action: 'updated', billing: 'agent' }];
    },
  });
  const result = (await call()).structuredContent.accounts[0];
  assert.equal(result.action, 'updated');
  assert.equal(result.status, 'active');
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_LOOKUP_FAILED'));
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_BILLING_INCOMPLETE'));
  assert.equal(
    diagnostics.some(d => d.code === 'PAYMENT_TERMS_MISMATCH'),
    false
  );
});

test('dry runs do not add natural-key resolver calls and provide null snapshots', async () => {
  let naturalLookups = 0;
  const { call } = setup({
    strictIdempotency: true,
    resolve: async ref => {
      if (ref) {
        naturalLookups++;
        throw new Error('must not run in preview');
      }
      return null;
    },
    upsert: async (_refs, ctx) => {
      assert.deepEqual(ctx.existing, [null]);
      return [{ ...row, action: 'updated', billing: 'agent', payment_terms: 'net_60' }];
    },
  });
  const result = await call([entry], { dry_run: true });
  assert.notEqual(result.isError, true);
  assert.equal(naturalLookups, 0);
});

test('optional account ID omission does not imply a changed identity', async () => {
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async () => [
      { ...row, account_id: undefined, action: 'unchanged', billing: 'agent', payment_terms: 'net_60' },
    ],
  });
  assert.equal((await call()).structuredContent.accounts[0].action, 'unchanged');
});

test('a batch may report one created resource for identical entries without a false identity violation', async () => {
  const source = {
    ...row,
    account_id: 'one-created-account',
    action: 'created',
    billing: 'agent',
    payment_terms: 'net_60',
  };
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => null,
    upsert: async () => [source, source],
  });
  assert.deepEqual(
    (await call([entry, entry])).structuredContent.accounts.map(row => row.action),
    ['created', 'created']
  );
  assert.deepEqual(diagnostics, []);
});

test('credential and private metadata objects never enter existing-account snapshots', async () => {
  const privateAccount = {
    ...account,
    ctx_metadata: { client: () => 'private' },
    authInfo: { refresh: () => 'secret' },
    notification_configs: [{ authentication: { credentials: 'secret' } }],
    billing_entity: { legal_name: 'Acme', bank: { iban: 'private' } },
  };
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => privateAccount,
    upsert: async (_refs, ctx) => {
      assert.equal(ctx.existing[0].authInfo, undefined);
      assert.equal(ctx.existing[0].notification_configs, undefined);
      assert.equal(ctx.existing[0].billing_entity.bank, undefined);
      assert.equal(ctx.existing[0].ctx_metadata, undefined);
      return [{ ...row, billing: 'agent', payment_terms: 'net_60' }];
    },
  });
  assert.equal((await call()).structuredContent.accounts[0].action, 'unchanged');
  assert.deepEqual(diagnostics, []);
});

test('ambiguous new-key echoes cannot impose another entry’s commercial contract', async () => {
  const entries = [
    { ...entry, currency: 'USD' },
    { ...entry, currency: 'EUR', payment_terms: 'net_30' },
  ];
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => null,
    upsert: async () => [
      { ...row, account_id: 'euro', action: 'created', billing: 'agent', payment_terms: 'net_30' },
      { ...row, account_id: 'dollar', action: 'created', billing: 'agent', payment_terms: 'net_60' },
    ],
  });
  assert.deepEqual(
    (await call(entries)).structuredContent.accounts.map(row => row.action),
    ['created', 'created']
  );
  assert.equal(diagnostics.filter(d => d.code === 'ACCOUNT_SYNC_ROW_UNMATCHED').length, 2);
});

test('partial echoes do not consume a following row’s unique subdivision match', async () => {
  const entries = [
    { ...entry, brand: { ...entry.brand, brand_id: 'a' } },
    { ...entry, brand: { ...entry.brand, brand_id: 'b' }, payment_terms: 'net_30' },
  ];
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => null,
    upsert: async () => [
      { ...row, account_id: 'b', action: 'created', billing: 'agent', payment_terms: 'net_30' },
      {
        ...row,
        brand: entries[0].brand,
        account_id: 'a',
        action: 'created',
        billing: 'agent',
        payment_terms: 'net_60',
      },
    ],
  });
  assert.deepEqual(
    (await call(entries)).structuredContent.accounts.map(row => row.account_id),
    ['a', 'b']
  );
  assert.deepEqual(diagnostics, []);
});

test('strict billing remaps preserve the persisted commercial evidence', async () => {
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => null,
    upsert: async () => [{ ...row, action: 'created', billing: 'operator', payment_terms: 'net_30' }],
  });
  const response = (await call()).structuredContent.accounts[0];
  assert.equal(response.errors[0].code, 'BILLING_NOT_SUPPORTED');
  assert.equal(response.account_id, account.id);
  assert.equal(response.status, 'active');
  assert.equal(response.billing, 'operator');
  assert.equal(response.payment_terms, 'net_30');
  assert.ok(diagnostics.some(d => d.code === 'BILLING_MISMATCH'));
});

test('an operator-billed update does not inherit stale agent-billing incompleteness or require a terms lookup', async () => {
  let lookups = 0;
  const { call, diagnostics } = setup({
    resolve: async ref => {
      if (ref) lookups++;
      return account;
    },
    upsert: async () => [{ ...row, action: 'updated', billing: 'operator' }],
  });
  const { payment_terms, ...operatorEntry } = entry;
  await call([{ ...operatorEntry, billing: 'operator' }]);
  assert.equal(lookups, 1);
  assert.deepEqual(diagnostics, []);
});

test('the existing implicit SDK store performs lookup-only sync guards without provisioning side effects', async () => {
  const { InMemoryImplicitAccountStore } = require('../dist/lib/server');
  let builds = 0;
  const store = new InMemoryImplicitAccountStore({
    buildAccount: async () => {
      builds++;
      return structuredClone(account);
    },
  });
  const { call } = setup({ resolve: store.resolve.bind(store), upsert: store.upsert.bind(store) });
  await call();
  assert.equal(builds, 1);
  await call();
  assert.equal(builds, 1);
});

test('a known account ID alone cannot resolve ambiguous response key echoes', async () => {
  const entries = [
    { ...entry, currency: 'USD' },
    { ...entry, currency: 'EUR' },
  ];
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async ref => (ref?.currency === 'USD' ? account : null),
    upsert: async () => [
      { ...row, account_id: 'new', action: 'created', billing: 'agent', payment_terms: 'net_60' },
      { ...row, billing: 'agent', payment_terms: 'net_60' },
    ],
  });
  const responses = (await call(entries)).structuredContent.accounts;
  assert.deepEqual(
    responses.map(row => row.account_id),
    ['new', account.id]
  );
  assert.equal(
    responses.some(row => row.action === 'failed'),
    false
  );
  assert.deepEqual(
    diagnostics.map(d => d.code),
    ['ACCOUNT_SYNC_ROW_UNMATCHED', 'ACCOUNT_SYNC_ROW_UNMATCHED']
  );
});

test('commercially filtered dry-run entries never create accounts in the keyed store', async () => {
  const { createKeyedAccountStore, keyedAccountMemoryBackend } = require('../dist/lib/server');
  const store = createKeyedAccountStore({
    namespace: 'filtered-preview',
    principalKey: ctx => ctx.authInfo?.credential?.key_id,
    backend: keyedAccountMemoryBackend(),
    createAccount: (ref, id) => ({ ...account, id, brand: ref.brand, operator: ref.operator }),
  });
  const diagnostics = [];
  const server = createAdcpServerFromPlatform(
    {
      capabilities: { specialisms: ['signal-marketplace'], pricingModels: ['cpm'], supportedBillings: ['agent'] },
      signals: { getSignals: async () => ({ signals: [] }), activateSignal: async () => ({}) },
      accounts: store,
    },
    { name: 'filtered-preview', version: '1', validation: { requests: 'off', responses: 'off' } }
  );
  const result = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          accounts: [{ ...entry, billing: 'operator' }, entry],
          idempotency_key: randomUUID(),
          dry_run: true,
        },
      },
    },
    { authInfo: { credential: { kind: 'api_key', key_id: 'buyer' } } }
  );
  assert.equal(result.structuredContent.dry_run, true);
  assert.deepEqual(
    result.structuredContent.accounts.map(row => row.action),
    ['failed', 'created']
  );
  assert.equal(await store.resolve(entry, { authInfo: { credential: { kind: 'api_key', key_id: 'buyer' } } }), null);
});

test('mixed ID and natural-key entries reserve a uniquely echoed settings row', async () => {
  const entries = [entry, { account: { account_id: account.id }, payment_terms: 'net_30' }];
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => null,
    upsert: async () => [
      { ...row, billing: 'agent', payment_terms: 'net_60' },
      { ...row, account: { account_id: account.id }, billing: 'agent', payment_terms: 'net_30' },
    ],
  });
  assert.deepEqual(
    (await call(entries)).structuredContent.accounts.map(row => row.payment_terms),
    ['net_60', 'net_30']
  );
  assert.deepEqual(diagnostics, []);
});

test('single-entry seller-canonical brand echoes retain identity and commercial checks', async () => {
  for (const invalid of [false, true]) {
    const { call, diagnostics } = setup({
      strictIdempotency: true,
      resolve: async () => account,
      upsert: async () => [
        {
          ...row,
          brand: { domain: 'canonical.example' },
          account_id: invalid ? 'duplicate' : account.id,
          action: invalid ? 'created' : 'unchanged',
          billing: 'agent',
          payment_terms: 'net_60',
        },
      ],
    });
    const response = (await call()).structuredContent.accounts[0];
    assert.equal(response.action, invalid ? 'failed' : 'unchanged');
    assert.equal(
      diagnostics.some(d => d.code === 'ACCOUNT_IDEMPOTENCY_VIOLATION'),
      invalid
    );
    assert.equal(
      diagnostics.some(d => d.code === 'ACCOUNT_SYNC_ROW_UNMATCHED'),
      false
    );
  }
});
