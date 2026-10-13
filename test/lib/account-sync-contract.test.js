const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { AccountNotFoundError } = require('../../dist/lib/server/decisioning/account.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');

const entry = {
  brand: { domain: 'brand.example' },
  operator: 'operator.example',
  billing: 'agent',
  payment_terms: 'net_60',
};
const stored = {
  id: 'existing',
  name: 'Brand',
  status: 'active',
  brand: entry.brand,
  operator: entry.operator,
  billing: { invoicedTo: 'agent' },
  payment_terms: 'net_60',
  ctx_metadata: { secret: 'internal-metadata' },
};
const row = {
  account_id: stored.id,
  brand: entry.brand,
  operator: entry.operator,
  action: 'unchanged',
  status: 'active',
  billing: 'agent',
  payment_terms: 'net_60',
};
function fixture(t, extra = {}) {
  const diagnostics = [];
  const warnings = [];
  const calls = [];
  const server = createAdcpServerFromPlatform(
    {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
        supportedBillings: ['agent'],
      },
      accounts: {
        resolve: async (ref, ctx) => {
          calls.push({ ref, ctx });
          return stored;
        },
        upsert: async () => [row],
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
        list: async () => ({ items: [stored] }),
        ...extra,
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'buy' }),
        updateMediaBuy: async () => ({ media_buy_id: 'buy' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    },
    {
      name: 'sync-contract',
      version: '1',
      validation: { requests: 'off', responses: 'off' },
      logger: { debug() {}, info() {}, error() {}, warn: (...args) => warnings.push(args) },
    }
  );
  t.after(() => server.close());
  const call = (name = 'sync_accounts', accounts = [entry]) =>
    server.dispatchTestRequest({
      method: 'tools/call',
      params: { name, arguments: name === 'sync_accounts' ? { accounts, idempotency_key: 'contract-key-0001' } : {} },
    });
  return { call, diagnostics, calls, warnings };
}

for (const resolution of ['explicit', 'implicit'])
  test(`${resolution} upsert receives lookup-only snapshots with full natural key`, async t => {
    let context;
    const { call, calls, diagnostics } = fixture(t, {
      resolution,
      upsert: async (_, ctx) => {
        context = ctx;
        return [row];
      },
    });
    const natural = { ...entry, sandbox: true, currency: 'USD', timezone: 'UTC', operator_unit: { id: 'unit' } };
    const response = await call('sync_accounts', [natural]);
    assert.equal(response.structuredContent.accounts[0].action, 'unchanged');
    assert.equal(context.existing[0].id, stored.id);
    const guardLookup = calls.find(call => call.ctx.provisioning === false);
    assert.ok(guardLookup);
    assert.equal(guardLookup.ref.currency, 'USD');
    assert.equal(guardLookup.ref.sandbox, true);
    assert.deepEqual(diagnostics, []);
    assert.ok(!JSON.stringify(response).includes('internal-metadata'));
  });
for (const change of [{ account_id: 'duplicate' }, { action: 'created' }])
  test(`duplicate account diagnostic preserves compatible output: ${JSON.stringify(change)}`, async t => {
    const { call, diagnostics } = fixture(t, { upsert: async () => [{ ...row, ...change }] });
    const body = (await call()).structuredContent;
    assert.equal(body.accounts[0].account_id, change.account_id ?? stored.id);
    assert.equal(diagnostics[0].code, 'ACCOUNT_SYNC_IDEMPOTENCY_VIOLATION');
  });
test('strict violations become per-row failures with schema-valid, secret-free errors', async t => {
  const { call } = fixture(t, {
    strictIdempotency: true,
    upsert: async () => [{ ...row, account_id: 'duplicate', payment_terms: 'net_30' }],
  });
  const body = (await call()).structuredContent;
  assert.equal(body.accounts[0].action, 'failed');
  assert.equal(body.accounts[0].account_id, undefined, 'failed guards do not expose a resolver-only ID');
  assert.equal(body.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal(validateResponse('sync_accounts', body, '3.2.1').valid, true);
});
test('missing commercial fields are filled only from matching persisted accounts', async t => {
  const { call, diagnostics } = fixture(t, {
    upsert: async () => [{ ...row, billing: undefined, payment_terms: undefined }],
  });
  const result = (await call()).structuredContent.accounts[0];
  assert.equal(result.billing, 'agent');
  assert.equal(result.payment_terms, 'net_60');
  assert.deepEqual(diagnostics, []);
});
test('new accounts cannot fabricate missing accepted terms from the request', async t => {
  const { call, diagnostics } = fixture(t, {
    resolve: async () => null,
    strictIdempotency: true,
    upsert: async () => [{ ...row, action: 'created', billing: undefined, payment_terms: undefined }],
  });
  assert.equal((await call()).structuredContent.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_BILLING_FIELDS_MISSING'));
});
test('pending and failed accounts can reject or defer requested terms', async t => {
  for (const status of ['pending_approval', 'rejected']) {
    const { call, diagnostics } = fixture(t, {
      strictIdempotency: true,
      upsert: async () => [{ ...row, status, payment_terms: 'net_30' }],
    });
    assert.notEqual((await call()).structuredContent.accounts[0].action, 'failed');
    assert.deepEqual(diagnostics, []);
  }
});
test('policy filtering retains original diagnostic and error row indices', async t => {
  const { call, diagnostics } = fixture(t, {
    strictIdempotency: true,
    upsert: async () => [{ ...row, payment_terms: 'net_30' }],
  });
  const body = (await call('sync_accounts', [{ ...entry, billing: 'operator' }, entry])).structuredContent;
  assert.equal(body.accounts[0].errors[0].code, 'BILLING_NOT_SUPPORTED');
  assert.equal(body.accounts[1].errors[0].field, 'accounts[1].payment_terms');
  assert.equal(diagnostics[0].index, 1);
});
test('lookup outages prevent writes; ordinary account-not-found allows provisioning', async t => {
  let writes = 0;
  const { call } = fixture(t, {
    resolve: async () => {
      throw new Error('DB offline');
    },
    upsert: async () => {
      writes++;
      return [row];
    },
  });
  assert.equal((await call()).structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(writes, 0);
  const missing = fixture(t, {
    resolve: async () => {
      throw new AccountNotFoundError();
    },
    upsert: async () => [{ ...row, action: 'created' }],
  });
  assert.equal((await missing.call()).structuredContent.accounts[0].action, 'created');
});
test('duplicate natural keys within a batch are checked against the first returned ID', async t => {
  const { call } = fixture(t, {
    resolve: async () => null,
    strictIdempotency: true,
    upsert: async () => [
      { ...row, action: 'created' },
      { ...row, account_id: 'duplicate', action: 'created' },
    ],
  });
  const rows = (await call('sync_accounts', [entry, entry])).structuredContent.accounts;
  assert.equal(rows[0].action, 'created');
  assert.equal(rows[1].action, 'failed');
});
test('list_accounts emits a typed diagnostic for missing agent billing terms', async t => {
  const { call, diagnostics } = fixture(t, {
    resolve: async () => ({ ...stored, payment_terms: undefined }),
    list: async () => ({ items: [{ ...stored, payment_terms: undefined }] }),
  });
  await call('list_accounts');
  assert.deepEqual(diagnostics, [{ code: 'ACCOUNT_BILLING_FIELDS_MISSING', toolName: 'list_accounts', index: 0 }]);
});

test('guard snapshots cannot be mutated by upsert to hide a changed ID', async t => {
  const { call } = fixture(t, {
    strictIdempotency: true,
    upsert: async (_, context) => {
      context.existing[0].id = 'duplicate';
      return [{ ...row, account_id: 'duplicate' }];
    },
  });
  assert.equal((await call()).structuredContent.accounts[0].action, 'failed');
});
test('enrichment outages do not fail a committed sync', async () => {
  // Exercise the post-write helper directly: pre-write outages still prevent writes.
  const { checkSyncAccountRows } = require('../../dist/lib/server/account-sync-contract.js');
  const result = await checkSyncAccountRows(
    {
      resolve: async () => {
        throw new Error('read outage');
      },
    },
    [entry],
    [stored],
    [{ ...row, payment_terms: undefined }],
    [0],
    {},
    { warn() {} }
  );
  assert.equal(result[0].payment_terms, 'net_60');
});
test('structured ACCOUNT_NOT_FOUND and mismatched lookup identities do not supply unrelated snapshots', async () => {
  const { existingSyncAccounts } = require('../../dist/lib/server/account-sync-contract.js');
  const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');
  const aliases = await existingSyncAccounts(
    { resolve: async () => ({ ...stored, account_id: stored.id }) },
    [entry],
    {}
  );
  assert.equal(aliases[0].id, stored.id);
  assert.deepEqual(
    await existingSyncAccounts(
      {
        resolve: async () => {
          throw new AdcpError('ACCOUNT_NOT_FOUND', { message: 'Account not found' });
        },
      },
      [entry],
      {}
    ),
    [null]
  );
  assert.deepEqual(
    await existingSyncAccounts(
      { resolve: async () => ({ ...stored, brand: { domain: 'other.example' } }) },
      [entry],
      {}
    ),
    [null]
  );
});

test('ID-keyed updates and list rows enrich billing only from the matching stored ID', async t => {
  const { call, diagnostics } = fixture(t, {
    strictIdempotency: true,
    upsert: async () => [{ ...row, billing: undefined, payment_terms: undefined }],
    list: async () => ({ items: [{ ...stored, billing: undefined, payment_terms: undefined }] }),
  });
  const result = (await call('sync_accounts', [{ account: { account_id: stored.id }, payment_terms: 'net_60' }]))
    .structuredContent.accounts[0];
  assert.equal(result.action, 'unchanged');
  assert.equal(result.billing, 'agent');
  assert.equal(result.payment_terms, 'net_60');
  const listed = (await call('list_accounts')).structuredContent.accounts[0];
  assert.equal(listed.billing, 'agent');
  assert.equal(listed.payment_terms, 'net_60');
  assert.deepEqual(diagnostics, []);
});

test('ID-only resolvers remain usable with an unsupported-lookup diagnostic', async () => {
  const { existingSyncAccounts } = require('../../dist/lib/server/account-sync-contract.js');
  const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');
  const diagnostics = [];
  const result = await existingSyncAccounts(
    {
      resolve: async () => {
        throw new AdcpError('INVALID_REQUEST', { message: 'Only account IDs are supported' });
      },
      onDiagnostic: d => diagnostics.push(d),
    },
    [entry],
    {},
    { warn() {} }
  );
  assert.deepEqual(result, [null]);
  assert.equal(diagnostics[0].code, 'ACCOUNT_SYNC_LOOKUP_UNSUPPORTED');
});

test('strict mode rejects an agent billing remap and logging cannot fail a committed result', async t => {
  const { call } = fixture(t, { strictIdempotency: true, upsert: async () => [{ ...row, billing: 'operator' }] });
  assert.equal((await call()).structuredContent.accounts[0].errors[0].code, 'BILLING_NOT_SUPPORTED');
  const { checkSyncAccountRows } = require('../../dist/lib/server/account-sync-contract.js');
  const result = await checkSyncAccountRows(
    {
      resolve: async () => stored,
      onDiagnostic: () => {
        throw new Error('observer failed');
      },
    },
    [entry],
    [stored],
    [{ ...row, action: 'created' }],
    [0],
    {},
    {
      warn: () => {
        throw new Error('logger failed');
      },
    }
  );
  assert.equal(result[0].action, 'created');
});
