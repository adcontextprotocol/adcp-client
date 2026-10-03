// `strictAccountReferences` (#3094, #3091): SDK 14 keeps the 14.0 account
// behaviors by default and warns once per process; the flag opts in to the
// refusals that become default in the next major release.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { _resetAccountReferenceWarnings } = require('../../dist/lib/server/account-reference-warnings.js');

const a = { brand: { domain: 'a.example' }, operator: 'agency.example' };
const b = { brand: { domain: 'b.example' }, operator: 'agency.example' };

beforeEach(() => _resetAccountReferenceWarnings());

function call(server, name, args) {
  return server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } });
}

function captureWarnings(t) {
  const warned = [];
  const debugged = [];
  const emitted = [];
  t.mock.method(process, 'emitWarning', (message, options) => emitted.push({ message, options }));
  const logger = {
    debug: (message, meta) => debugged.push({ message, meta }),
    info() {},
    warn: (message, meta) => warned.push({ message, meta }),
    error() {},
  };
  const byCode = (entries, code) => entries.filter(entry => (entry.meta ?? entry.options)?.code === code);
  return {
    logger,
    warned: code => byCode(warned, code),
    debugged: code => byCode(debugged, code),
    emitted: code => byCode(emitted, code),
  };
}

function seller(options = {}) {
  return createAdcpServer({
    name: 'account-policy',
    version: '1',
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: { getProducts: async () => ({ products: [], cache_scope: 'public' }) },
    ...options,
  });
}

// --- Supplied reference without resolveAccount -------------------------------

test('default: a supplied reference without resolveAccount reaches the handler and warns once', async t => {
  const w = captureWarnings(t);
  const seen = [];
  const server = seller({
    logger: w.logger,
    mediaBuy: {
      getProducts: async (params, ctx) => {
        seen.push({ account: params.account, resolved: ctx.account });
        return { products: [], cache_scope: 'public' };
      },
    },
  });
  for (let i = 0; i < 2; i++) {
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  }
  assert.deepEqual(seen, [
    { account: a, resolved: undefined },
    { account: a, resolved: undefined },
  ]);
  assert.equal(w.warned('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1);
  assert.match(w.warned('ADCP_UNRESOLVED_ACCOUNT_REFERENCE')[0].message, /strictAccountReferences: true/);
  assert.equal(w.debugged('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1, 'repeat occurrences log at debug');
  const loud = w.emitted('ADCP_UNRESOLVED_ACCOUNT_REFERENCE');
  assert.equal(loud.length, 1);
  assert.equal(loud[0].options.type, 'DeprecationWarning');
  await server.close();
});

test('default: two servers in one process produce one warning', async t => {
  const w = captureWarnings(t);
  for (let i = 0; i < 2; i++) {
    const server = seller({ logger: w.logger });
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true);
    await server.close();
  }
  assert.equal(w.warned('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1);
  assert.equal(w.emitted('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1);
  assert.equal(w.debugged('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1);
});

test('production: the warning goes to the configured logger only', async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const w = captureWarnings(t);
  const server = seller({ logger: w.logger, stateStore: new InMemoryStateStore() });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(w.warned('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1);
  assert.equal(w.emitted('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 0);
  await server.close();
});

test('strict: a supplied reference without resolveAccount is refused before the handler', async t => {
  const w = captureWarnings(t);
  let called = false;
  const server = seller({
    logger: w.logger,
    strictAccountReferences: true,
    resolveAccountFromAuth: async () => ({ id: 'from-auth' }),
    mediaBuy: {
      getProducts: async () => {
        called = true;
        return { products: [], cache_scope: 'public' };
      },
    },
  });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(called, false);
  assert.equal(w.warned('ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 0);
  await server.close();
});

test('list_creative_formats refuses an unresolvable account selector in both modes (14.0 behavior)', async () => {
  for (const strictAccountReferences of [false, true]) {
    const server = seller({
      strictAccountReferences,
      creative: { listCreativeFormats: async () => ({ formats: [] }) },
    });
    const response = await call(server, 'list_creative_formats', { account: a });
    assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    await server.close();
  }
});

// --- required_for_products ----------------------------------------------------

test('default: required_for_products is not enforced and warns once', async t => {
  const w = captureWarnings(t);
  const server = seller({ logger: w.logger, capabilities: { account: { requiredForProducts: true } } });
  for (let i = 0; i < 2; i++) {
    const response = await call(server, 'get_products', { brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  }
  assert.equal(w.warned('ADCP_REQUIRED_FOR_PRODUCTS_NOT_ENFORCED').length, 1);
  assert.equal(w.debugged('ADCP_REQUIRED_FOR_PRODUCTS_NOT_ENFORCED').length, 1);
  await server.close();
});

test('default: a passed-through reference satisfies required_for_products without that warning', async t => {
  const w = captureWarnings(t);
  const server = seller({ logger: w.logger, capabilities: { account: { requiredForProducts: true } } });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(w.warned('ADCP_REQUIRED_FOR_PRODUCTS_NOT_ENFORCED').length, 0);
  await server.close();
});

test('strict: required_for_products refuses account-less discovery and accepts a resolved account', async t => {
  const w = captureWarnings(t);
  const server = seller({
    logger: w.logger,
    strictAccountReferences: true,
    capabilities: { account: { requiredForProducts: true } },
    resolveAccount: async ref => (ref.brand?.domain === 'a.example' ? { id: 'acct_a' } : null),
  });
  const missing = await call(server, 'get_products', { brief: 'catalog' });
  assert.equal(missing.structuredContent.adcp_error.code, 'ACCOUNT_REQUIRED');
  const unknown = await call(server, 'get_products', { account: b, brief: 'catalog' });
  assert.equal(unknown.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  const resolved = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.notEqual(resolved.isError, true, JSON.stringify(resolved.structuredContent));
  assert.equal(w.warned('ADCP_REQUIRED_FOR_PRODUCTS_NOT_ENFORCED').length, 0);
  await server.close();
});

test('strict: required_for_products accepts an auth-derived account', async () => {
  const server = seller({
    strictAccountReferences: true,
    capabilities: { account: { requiredForProducts: true } },
    resolveAccountFromAuth: async () => ({ id: 'from-auth' }),
  });
  const response = await call(server, 'get_products', { brief: 'catalog' });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  await server.close();
});

// --- list_accounts filter -----------------------------------------------------

function listAccountsSeller(options, seen) {
  return seller({
    resolveAccount: async ref => {
      seen.resolved.push(ref);
      return ref.account_id === 'acct_known' ? { id: 'acct_known' } : null;
    },
    accounts: {
      listAccounts: async (_params, ctx) => {
        seen.ctxAccounts.push(ctx.account);
        return { accounts: [] };
      },
    },
    ...options,
  });
}

test('default: list_accounts resolves the filter through resolveAccount, as in 14.0', async t => {
  const w = captureWarnings(t);
  const seen = { resolved: [], ctxAccounts: [] };
  const server = listAccountsSeller({ logger: w.logger }, seen);
  const known = await call(server, 'list_accounts', { account: { account_id: 'acct_known' } });
  assert.notEqual(known.isError, true, JSON.stringify(known.structuredContent));
  assert.deepEqual(seen.ctxAccounts, [{ id: 'acct_known' }]);
  const unknown = await call(server, 'list_accounts', { account: { account_id: 'acct_other' } });
  assert.equal(unknown.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  assert.deepEqual(
    seen.resolved.map(ref => ref.account_id),
    ['acct_known', 'acct_other']
  );
  assert.equal(seen.ctxAccounts.length, 1, 'the handler never sees an unauthorized filter');
  assert.equal(w.warned('ADCP_LIST_ACCOUNTS_FILTER_RESOLVED').length, 1);
  await server.close();
});

test('strict: list_accounts treats account as a filter and scopes ctx.account from auth', async t => {
  const w = captureWarnings(t);
  const seen = { resolved: [], ctxAccounts: [] };
  const server = listAccountsSeller(
    {
      logger: w.logger,
      strictAccountReferences: true,
      resolveAccountFromAuth: async () => ({ id: 'from-auth' }),
    },
    seen
  );
  const result = await call(server, 'list_accounts', { account: { account_id: 'acct_other' } });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.deepEqual(seen.resolved, []);
  assert.deepEqual(seen.ctxAccounts, [{ id: 'from-auth' }]);
  assert.equal(w.warned('ADCP_LIST_ACCOUNTS_FILTER_RESOLVED').length, 0);
  await server.close();
});

// --- Implicit identity metadata (createAdcpServerFromPlatform) ------------------

const MISMATCH = 'ADCP_IMPLICIT_ACCOUNT_IDENTITY_MISMATCH';
// A custom store that ignores the supplied natural key and returns another brand's account.
const otherBrandAccount = async () => ({
  id: 'acct_b_internal',
  status: 'active',
  mode: 'sandbox',
  ctx_metadata: {},
  ...b,
});

function implicitPlatform(resolve = otherBrandAccount, accountsExtra = {}, complianceTesting = false) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
      ...(complianceTesting && { compliance_testing: {} }),
    },
    accounts: {
      resolution: 'implicit',
      resolve,
      upsert: async () => [],
      list: async () => ({ items: [] }),
      ...accountsExtra,
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ cache_scope: 'account', products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
}

function implicitServer(logger, { strict = false, resolve, accountsExtra, opts = {} } = {}) {
  return createAdcpServerFromPlatform(implicitPlatform(resolve, accountsExtra, opts.complyTest !== undefined), {
    name: 'implicit-identity',
    version: '1',
    validation: { requests: 'off', responses: 'off' },
    logger,
    ...(strict && { strictAccountReferences: true }),
    ...opts,
  });
}

function assertNoAccountIdLeak(response) {
  assert.doesNotMatch(JSON.stringify(response), /acct_b_internal/, 'mismatched account id must stay server-side');
}

test('default: implicit identity mismatch on get_products warns once and keeps the 14.0 result', async t => {
  const w = captureWarnings(t);
  const server = implicitServer(w.logger);
  for (let i = 0; i < 2; i++) {
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    assertNoAccountIdLeak(response);
  }
  assert.equal(w.warned(MISMATCH).length, 1);
  assert.equal(w.warned(MISMATCH)[0].meta.field, 'brand.domain');
  assert.equal(w.warned(MISMATCH)[0].meta.accountId, 'acct_b_internal');
  assert.doesNotMatch(w.warned(MISMATCH)[0].message, /acct_b_internal/);
  assert.ok(w.debugged(MISMATCH).length >= 1, 'repeat mismatches log at debug');
  assert.equal(w.emitted(MISMATCH).length, 1);
  await server.close();
});

test('strict: implicit identity mismatch on get_products is refused without leaking the account', async t => {
  const w = captureWarnings(t);
  const server = implicitServer(w.logger, { strict: true });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  assertNoAccountIdLeak(response);
  assert.equal(w.warned(MISMATCH).length, 0);
  await server.close();
});

test('strict: implicit identity accepts matching or omitted metadata', async t => {
  const w = captureWarnings(t);
  for (const resolve of [
    async ref => ({ id: 'acct_a', status: 'active', ctx_metadata: {}, ...ref }),
    async () => ({ id: 'acct_a', status: 'active', ctx_metadata: {} }),
  ]) {
    const server = implicitServer(w.logger, { strict: true, resolve });
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    await server.close();
  }
  assert.equal(w.warned(MISMATCH).length, 0);
});

test('default: implicit identity mismatch on tasks/get warns instead of refusing', async t => {
  for (const strict of [false, true]) {
    _resetAccountReferenceWarnings();
    const w = captureWarnings(t);
    let resolved = 0;
    const server = implicitServer(w.logger, {
      strict,
      resolve: async (...args) => {
        resolved++;
        return otherBrandAccount(...args);
      },
    });
    const response = await call(server, 'tasks_get', { task_id: 'task_unknown', account: a });
    assertNoAccountIdLeak(response);
    assert.ok(resolved >= 1, 'tasks/get resolved the supplied natural key');
    assert.equal(w.warned(MISMATCH).length, strict ? 0 : 1, `strict=${strict}`);
    await server.close();
  }
});

for (const [tool, method, result] of [
  [
    'list_account_changes',
    'listChanges',
    {
      changes: [],
      cursor: 'checkpoint-2',
      has_more: false,
      available_since: '2026-01-01T00:00:00Z',
      generated_at: '2026-08-28T00:00:00Z',
    },
  ],
  ['get_account_financials', 'getAccountFinancials', { financials: { spend: { amount: 0, currency: 'USD' } } }],
]) {
  test(`implicit identity mismatch on ${tool}: default warns and dispatches, strict refuses`, async t => {
    for (const strict of [false, true]) {
      _resetAccountReferenceWarnings();
      const w = captureWarnings(t);
      let dispatched = 0;
      const server = implicitServer(w.logger, {
        strict,
        accountsExtra: {
          [method]: async () => {
            dispatched++;
            return result;
          },
        },
      });
      const args = tool === 'list_account_changes' ? { account: a, cursor: 'checkpoint-1' } : { account: a };
      const response = await call(server, tool, args);
      assertNoAccountIdLeak(response);
      if (strict) {
        assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
        assert.equal(dispatched, 0);
        assert.equal(w.warned(MISMATCH).length, 0);
      } else {
        assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
        assert.equal(dispatched, 1);
        assert.equal(w.warned(MISMATCH).length, 1);
      }
      await server.close();
    }
  });
}

test('implicit identity mismatch on comply_test_controller: default warns and dispatches, strict refuses', async t => {
  // Admission must come from the resolved sandbox account alone: no env bridge
  // and no wire `sandbox: true` fallback for an unresolved account.
  const previousSandbox = process.env.ADCP_SANDBOX;
  delete process.env.ADCP_SANDBOX;
  t.after(() => {
    if (previousSandbox !== undefined) process.env.ADCP_SANDBOX = previousSandbox;
  });
  for (const strict of [false, true]) {
    _resetAccountReferenceWarnings();
    const w = captureWarnings(t);
    let forced = 0;
    const server = implicitServer(w.logger, {
      strict,
      opts: {
        complyTest: {
          force: {
            creative_status: async params => {
              forced++;
              return {
                success: true,
                transition: 'forced',
                resource_type: 'creative',
                resource_id: params.creative_id,
                previous_state: 'pending_review',
                current_state: params.status,
              };
            },
          },
        },
      },
    });
    const response = await call(server, 'comply_test_controller', {
      scenario: 'force_creative_status',
      account: a,
      params: { creative_id: 'cr_42', status: 'approved' },
    });
    assertNoAccountIdLeak(response);
    if (strict) {
      assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
      assert.equal(forced, 0);
      assert.equal(w.warned(MISMATCH).length, 0);
    } else {
      assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
      assert.equal(forced, 1);
      assert.equal(w.warned(MISMATCH).length, 1);
    }
    await server.close();
  }
});
