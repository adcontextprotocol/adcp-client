// Framework enforcement of the per-mode account-reference contract
// documented at `AccountStore.resolution`.
//
// - #1364: `'implicit'` (buyer-declared accounts) refuses inline
//   `account_id`; the `{ brand, operator }` natural key is durable.
// - #1647: `'derived'` (upstream-managed account-id namespace) is the
//   mirror image — `account_id` is durable and accepted, the natural key is
//   refused, `accounts.list` is mandatory, and `sync_accounts` natural-key
//   provisioning entries fail per-row with `UNSUPPORTED_PROVISIONING`.
//   This replaces #1468, which had the polarity backwards.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function buildImplicitPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolution: 'implicit',
      resolve: async () => ({
        id: 'acc_from_principal',
        name: 'Acme',
        status: 'active',
        ctx_metadata: {},
        authInfo: { kind: 'oauth', principal: 'p1' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({
        cache_scope: 'account',
        products: [
          {
            product_id: 'p1',
            name: 'sample',
            description: 'fixture',
            format_options: [{ format_kind: 'image', params: {} }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 5.0, currency: 'USD' }],
          },
        ],
      }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

const SERVER_OPTS = {
  name: 'implicit-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

describe("#1364 — accounts.resolution: 'implicit' refuses inline account_id", () => {
  it('rejects { account_id } reference with INVALID_REQUEST and field=account.account_id', async () => {
    let resolveCalled = false;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => {
          resolveCalled = true;
          return null;
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'snap_act_123' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
    assert.match(result.structuredContent.adcp_error.message, /sync_accounts/);
    assert.strictEqual(resolveCalled, false, 'resolve must not be invoked when implicit-mode rejects upfront');
  });

  it('permits the brand+operator union arm — only account_id is refused', async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'acc_from_brand_lookup',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' });
  });

  it("'explicit' resolution (default) accepts inline account_id — no enforcement leaks across modes", async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'explicit',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: ref?.account_id ?? 'acc_default',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'acc_explicit' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { account_id: 'acc_explicit' });
  });

  it('omitted resolution (defaults to explicit) accepts inline account_id', async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        // resolution omitted — framework defaults to 'explicit'
        resolve: async ref => {
          sawRef = ref;
          return {
            id: ref?.account_id ?? 'acc_default',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'acc_explicit_default' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { account_id: 'acc_explicit_default' });
  });

  it('implicit + omitted account flows to auth-derived resolution (no enforcement, no rejection)', async () => {
    // Implicit-mode tools where the request omits `account` entirely should
    // route through the auth-derived path. The framework calls
    // `accounts.resolve(undefined, ctx)`; the platform looks up by
    // `ctx.authInfo.principal` (or whichever field). No INVALID_REQUEST here.
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'acc_from_principal',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          // no `account` field — auth-derived path
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawRef, undefined, 'auth-derived path passes undefined ref');
  });

  it('tasks_get rejects { account_id } with INVALID_REQUEST on implicit platforms', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => null,
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'tasks_get',
        arguments: {
          task_id: 'task_does_not_matter',
          account: { account_id: 'snap_act_123' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });

  it('get_account_financials rejects { account_id } with INVALID_REQUEST on implicit platforms', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => null,
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
        getAccountFinancials: async () => ({
          financials: { spend: { amount: 0, currency: 'USD' } },
        }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_account_financials',
        arguments: {
          account: { account_id: 'snap_act_123' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });
});

// #1647 (supersedes #1468) — `accounts.resolution: 'derived'` is an
// upstream-managed account-id namespace: `account_id` is the durable wire
// reference and the `{ brand, operator }` natural key is refused. The
// pre-14 behavior was the exact inverse; see docs/migration-13-to-14.md.
function buildDerivedPlatform(accountOverrides = {}) {
  const singleton = {
    id: 'upstream_acct_1',
    name: 'Upstream Account',
    status: 'active',
    ctx_metadata: {},
  };
  return buildImplicitPlatform({
    accounts: {
      resolution: 'derived',
      // Verified resolution: only ids the credential can reach resolve.
      resolve: async ref => (ref?.account_id === undefined || ref.account_id === singleton.id ? singleton : null),
      list: async () => ({ items: [singleton] }),
      ...accountOverrides,
    },
  });
}

describe("#1647 — accounts.resolution: 'derived' accepts account_id and refuses the natural key", () => {
  it('accepts an inline { account_id } reference and threads it to resolve', async () => {
    let sawRef;
    const platform = buildDerivedPlatform({
      resolve: async ref => {
        sawRef = ref;
        return { id: 'upstream_acct_1', name: 'Upstream Account', status: 'active', ctx_metadata: {} };
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'upstream_acct_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { account_id: 'upstream_acct_1' });
  });

  it('an unrecognized resolution string is refused at construction, never silently gated as derived', () => {
    // Untyped JS can put anything here. A typo must not inherit another
    // mode's wire enforcement — pre-#1647 it meant "no enforcement", and
    // after the inversion it would have meant "derived enforcement", the
    // exact inverse of what an 'Implicit' typo intends.
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'Implicit',
        resolve: async () => null,
        list: async () => ({ items: [] }),
      },
    });
    assert.throws(() => createAdcpServerFromPlatform(platform, SERVER_OPTS), /not a recognized resolution mode/);
  });

  it('refuses the brand+operator arm with INVALID_REQUEST, field=account.brand, before resolve runs', async () => {
    let resolveCalled = false;
    const platform = buildDerivedPlatform({
      resolve: async () => {
        resolveCalled = true;
        return null;
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.brand');
    assert.match(result.structuredContent.adcp_error.suggestion, /list_accounts/);
    assert.doesNotMatch(
      result.structuredContent.adcp_error.message,
      /sync_accounts/,
      'derived-mode recovery is list_accounts, not sync_accounts'
    );
    assert.strictEqual(resolveCalled, false, 'resolve must not run when the ref shape is refused upfront');
  });

  it('an account_id the resolver cannot reach becomes ACCOUNT_NOT_FOUND (fail closed, no detail leak)', async () => {
    const platform = buildDerivedPlatform();
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'someone_elses_account' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  });

  it('derived + omitted account flows to auth-derived resolution (no enforcement, no rejection)', async () => {
    let sawRef = 'unset';
    const platform = buildDerivedPlatform({
      resolve: async ref => {
        sawRef = ref;
        return { id: 'upstream_acct_1', name: 'Upstream Account', status: 'active', ctx_metadata: {} };
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          // no `account` field — auth-derived path
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawRef, undefined, 'auth-derived path passes undefined ref');
  });

  it('tasks_get accepts { account_id } and refuses the natural key on derived platforms', async () => {
    const platform = buildDerivedPlatform();
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const refused = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'tasks_get',
        arguments: {
          task_id: 'task_does_not_matter',
          account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
        },
      },
    });
    assert.strictEqual(refused.isError, true);
    assert.strictEqual(refused.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(refused.structuredContent.adcp_error.field, 'account.brand');

    const accepted = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'tasks_get',
        arguments: {
          task_id: 'task_does_not_matter',
          account: { account_id: 'upstream_acct_1' },
        },
      },
    });
    // The task itself doesn't exist; what matters is that the account ref
    // shape was accepted rather than refused as INVALID_REQUEST.
    assert.notStrictEqual(accepted.structuredContent?.adcp_error?.code, 'INVALID_REQUEST');
  });

  it('get_account_financials accepts { account_id } on derived platforms', async () => {
    const platform = buildDerivedPlatform({
      getAccountFinancials: async () => ({
        financials: { spend: { amount: 0, currency: 'USD' } },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_account_financials',
        arguments: {
          account: { account_id: 'upstream_acct_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
  });

  it('refusal fires regardless of auth posture — authenticated natural-key refs are still refused', async () => {
    // Locks the contract: an authenticated buyer that sends the natural key
    // to a derived agent gets the same INVALID_REQUEST as an unauthenticated
    // one. Prevents future drift where someone softens the refusal "for
    // authenticated principals only" — the upstream owns the namespace
    // regardless of who is asking.
    let resolveCalled = false;
    const platform = buildDerivedPlatform({
      resolve: async () => {
        resolveCalled = true;
        return null;
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      ...SERVER_OPTS,
      authenticate: () => ({
        kind: 'oauth',
        credential: { kind: 'oauth', client_id: 'authed-buyer', scopes: [] },
      }),
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.brand');
    assert.strictEqual(resolveCalled, false, 'authed principal does not soften the refusal');
  });
});

describe("#1647 — 'derived' platform configuration gates", () => {
  it('throws PlatformConfigError when a derived store omits accounts.list', () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => null,
      },
    });
    assert.throws(
      () => createAdcpServerFromPlatform(platform, SERVER_OPTS),
      err => {
        assert.strictEqual(err.name, 'PlatformConfigError');
        assert.match(err.message, /accounts\.list/);
        assert.match(err.message, /list_accounts/);
        return true;
      }
    );
  });

  it('accepts list_accounts wired through the merge seam instead of the platform interface', () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => null,
      },
    });
    // `opts.accounts.listAccounts` is a documented wiring — the gate is
    // about serving list_accounts, not about which seam provides it.
    assert.doesNotThrow(() =>
      createAdcpServerFromPlatform(platform, {
        ...SERVER_OPTS,
        accounts: { listAccounts: async () => ({ accounts: [] }) },
      })
    );
  });

  it('projects account.require_operator_auth: true for derived platforms', async () => {
    const platform = buildDerivedPlatform();
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    assert.strictEqual(result.structuredContent.account.require_operator_auth, true);
  });
});

describe('#1647 — sync_accounts on a derived platform', () => {
  const UPSTREAM_ACCOUNT = {
    id: 'upstream_acct_1',
    name: 'Upstream',
    status: 'active',
    brand: { domain: 'acme.com' },
    operator: 'pinnacle.com',
    ctx_metadata: {},
  };
  // Verified resolution: only the credential's own account resolves.
  const derivedSyncPlatform = (upsert, extra = {}) =>
    buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref =>
          ref?.account_id === undefined || ref.account_id === UPSTREAM_ACCOUNT.id ? UPSTREAM_ACCOUNT : null,
        list: async () => ({ items: [UPSTREAM_ACCOUNT] }),
        upsert,
        ...extra,
      },
    });
  // A settings-update row still has to satisfy `sync-accounts-response.json`,
  // which requires brand + operator on every row — the seller echoes them
  // from its own account record.
  const settingsUpdateRow = () => ({
    account_id: UPSTREAM_ACCOUNT.id,
    brand: UPSTREAM_ACCOUNT.brand,
    operator: UPSTREAM_ACCOUNT.operator,
    action: 'updated',
    status: 'active',
  });

  it('fails natural-key provisioning entries per-row with UNSUPPORTED_PROVISIONING, without calling upsert', async () => {
    let upsertCalled = false;
    const platform = derivedSyncPlatform(async () => {
      upsertCalled = true;
      return [];
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-1-0000000000000000',
          accounts: [{ brand: { domain: 'acme.com' }, operator: 'pinnacle.com', billing: 'agent' }],
        },
      },
    });
    const rows = result.structuredContent.accounts;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].action, 'failed');
    assert.strictEqual(rows[0].errors[0].code, 'UNSUPPORTED_PROVISIONING');
    assert.match(rows[0].errors[0].suggestion, /list_accounts/);
    assert.strictEqual(upsertCalled, false, 'natural-key entries must not reach the adopter upsert');
  });

  it('passes account_id-keyed settings-update entries through to upsert', async () => {
    let sawEntries;
    const platform = derivedSyncPlatform(async entries => {
      sawEntries = entries;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-2-0000000000000000',
          accounts: [{ account: { account_id: 'upstream_acct_1' } }],
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawEntries.length, 1);
    assert.deepStrictEqual(sawEntries[0].account, { account_id: 'upstream_acct_1' });
  });

  it('mixed batches apply the settings-update entry and fail only the natural-key entry', async () => {
    const platform = derivedSyncPlatform(async entries => entries.map(settingsUpdateRow));
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-3-0000000000000000',
          accounts: [
            { brand: { domain: 'acme.com' }, operator: 'pinnacle.com', billing: 'agent' },
            { account: { account_id: 'upstream_acct_1' } },
          ],
        },
      },
    });
    const rows = result.structuredContent.accounts;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].action, 'failed');
    assert.strictEqual(rows[0].errors[0].code, 'UNSUPPORTED_PROVISIONING');
    assert.strictEqual(rows[1].action, 'updated');
  });

  it('produces a schema-valid response under strict validation (rows carry brand + operator)', async () => {
    // The settings-update path is only usable if the seller can emit rows
    // that satisfy `sync-accounts-response.json` (brand + operator are
    // required on every row). Runs with validation ON — the rest of this
    // file runs with it off.
    const platform = derivedSyncPlatform(async entries => entries.map(settingsUpdateRow));
    const server = createAdcpServerFromPlatform(platform, {
      ...SERVER_OPTS,
      validation: { requests: 'strict', responses: 'strict' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-strict-00000000000',
          accounts: [{ account: { account_id: 'upstream_acct_1' } }],
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent.accounts[0].action, 'updated');
  });

  it('refuses a settings-update entry naming an account the credential cannot reach, before any write', async () => {
    let upsertCalled = false;
    const platform = derivedSyncPlatform(async entries => {
      upsertCalled = true;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-foreign-000000000',
          accounts: [{ account: { account_id: 'someone_elses_account' } }],
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    assert.strictEqual(upsertCalled, false, 'no write may run for an account the caller cannot reach');
  });

  it('refuses a natural-key settings-update reference with INVALID_REQUEST (ref shape, not mode)', async () => {
    const platform = derivedSyncPlatform(async entries => entries.map(settingsUpdateRow));
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-natkeyref-0000000',
          accounts: [{ account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' } }],
        },
      },
    });
    const row = result.structuredContent.accounts[0];
    assert.strictEqual(row.action, 'failed');
    assert.strictEqual(row.errors[0].code, 'INVALID_REQUEST');
    assert.strictEqual(row.errors[0].field, 'accounts[0].account.brand');
  });

  it('keeps per-entry error indices aligned with the request array', async () => {
    const platform = derivedSyncPlatform(async entries => entries.map(settingsUpdateRow), {});
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-indices-000000000',
          accounts: [
            { account: { account_id: 'upstream_acct_1' } },
            { brand: { domain: 'acme.com' }, operator: 'pinnacle.com', billing: 'agent' },
          ],
        },
      },
    });
    const rows = result.structuredContent.accounts;
    assert.strictEqual(rows[0].action, 'updated');
    assert.strictEqual(rows[1].errors[0].field, 'accounts[1].brand', 'index must be the buyer request index');
  });

  it('refuses a hybrid entry claiming two account references, with no write (relaxed validation)', async () => {
    // Request validation is relaxable, so the gate cannot assume the
    // schema's per-entry oneOf held. An entry carrying a root account_id AND
    // a nested natural-key ref must not be accepted on the id and then
    // written against the key nobody verified.
    let upsertCalled = false;
    const platform = derivedSyncPlatform(async entries => {
      upsertCalled = true;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-hybrid-000000000',
          accounts: [
            {
              account_id: 'upstream_acct_1',
              account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
            },
          ],
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.match(result.structuredContent.adcp_error.message, /more than one account reference/);
    assert.strictEqual(upsertCalled, false, 'an ambiguous entry must not reach the adopter');
  });

  it('refuses a hybrid entry that mixes id and natural key inside `account`', async () => {
    let upsertCalled = false;
    const platform = derivedSyncPlatform(async entries => {
      upsertCalled = true;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-hybrid2-00000000',
          accounts: [
            {
              account: { account_id: 'upstream_acct_1', brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
            },
          ],
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(upsertCalled, false);
  });

  it('refuses a provisioning trio that also carries a nested account ref', async () => {
    let upsertCalled = false;
    const platform = derivedSyncPlatform(async entries => {
      upsertCalled = true;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-hybrid3-00000000',
          accounts: [
            {
              brand: { domain: 'acme.com' },
              operator: 'pinnacle.com',
              billing: 'agent',
              account: { account_id: 'upstream_acct_1' },
            },
          ],
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(upsertCalled, false);
  });

  it('reports an incomplete natural key as INVALID_REQUEST, not "mode unsupported"', async () => {
    const platform = derivedSyncPlatform(async entries => entries.map(settingsUpdateRow));
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-halfkey-00000000',
          accounts: [{ operator: 'pinnacle.com', billing: 'agent' }],
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.match(result.structuredContent.adcp_error.message, /incomplete natural key/);
  });

  it('accepts a root-level account_id when it is the only reference', async () => {
    let sawEntries;
    const platform = derivedSyncPlatform(async entries => {
      sawEntries = entries;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-rootid-00000000',
          accounts: [{ account_id: 'upstream_acct_1' }],
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawEntries.length, 1);
  });

  it('verifies a root-level account_id against the reachable set', async () => {
    let upsertCalled = false;
    const platform = derivedSyncPlatform(async entries => {
      upsertCalled = true;
      return entries.map(settingsUpdateRow);
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-derived-rootid2-0000000',
          accounts: [{ account_id: 'someone_elses_account' }],
        },
      },
    });
    assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    assert.strictEqual(upsertCalled, false);
  });

  it('implicit platforms still provision by natural key (no cross-mode leak)', async () => {
    let sawEntries;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => ({ id: 'acc', name: 'Acme', status: 'active', ctx_metadata: {} }),
        list: async () => ({ items: [] }),
        upsert: async entries => {
          sawEntries = entries;
          return entries.map(e => ({ brand: e.brand, operator: e.operator, action: 'created', status: 'active' }));
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-implicit-1-0000000000000000',
          accounts: [{ brand: { domain: 'acme.com' }, operator: 'pinnacle.com', billing: 'agent' }],
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawEntries.length, 1);
    assert.strictEqual(result.structuredContent.accounts[0].action, 'created');
  });
});

describe('#1647 — merge-seam sync_accounts handler is gated too', () => {
  const ACCOUNT = {
    id: 'upstream_acct_1',
    name: 'Upstream',
    status: 'active',
    brand: { domain: 'acme.com' },
    operator: 'pinnacle.com',
    ctx_metadata: {},
  };
  const row = () => ({
    account_id: ACCOUNT.id,
    brand: ACCOUNT.brand,
    operator: ACCOUNT.operator,
    action: 'updated',
    status: 'active',
  });
  // No `accounts.upsert` on the platform: sync_accounts is served entirely
  // from `opts.accounts.syncAccounts`, the documented merge-seam wiring.
  const seamPlatform = () =>
    buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref => (ref?.account_id === undefined || ref.account_id === ACCOUNT.id ? ACCOUNT : null),
        list: async () => ({ items: [ACCOUNT] }),
      },
    });

  it('refuses natural-key provisioning before the adopter handler runs', async () => {
    let seen;
    const server = createAdcpServerFromPlatform(seamPlatform(), {
      ...SERVER_OPTS,
      accounts: {
        syncAccounts: async params => {
          seen = params.accounts;
          return { accounts: params.accounts.map(row) };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-seam-1-000000000000000000',
          accounts: [{ brand: { domain: 'acme.com' }, operator: 'pinnacle.com', billing: 'agent' }],
        },
      },
    });
    assert.strictEqual(result.structuredContent.accounts[0].errors[0].code, 'UNSUPPORTED_PROVISIONING');
    assert.strictEqual(seen, undefined, 'the adopter handler must not see refused entries');
  });

  it('realigns rows in a mixed batch without mutating the handler’s own array', async () => {
    // Adopters legitimately return cached results (the idempotency-replay
    // shape). Splicing into their array would corrupt the cache.
    const cached = { accounts: [row()] };
    const server = createAdcpServerFromPlatform(seamPlatform(), {
      ...SERVER_OPTS,
      accounts: { syncAccounts: async () => cached },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-seam-2-000000000000000000',
          accounts: [
            { brand: { domain: 'acme.com' }, operator: 'pinnacle.com', billing: 'agent' },
            { account: { account_id: 'upstream_acct_1' } },
          ],
        },
      },
    });
    const rows = result.structuredContent.accounts;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].errors[0].code, 'UNSUPPORTED_PROVISIONING');
    assert.strictEqual(rows[1].action, 'updated');
    assert.strictEqual(cached.accounts.length, 1, 'adopter-owned array must be untouched');
  });

  it('refuses a hybrid entry before the adopter handler runs (relaxed validation)', async () => {
    let called = false;
    const server = createAdcpServerFromPlatform(seamPlatform(), {
      ...SERVER_OPTS,
      accounts: {
        syncAccounts: async params => {
          called = true;
          return { accounts: params.accounts.map(row) };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-seam-hybrid-0000000000000',
          accounts: [
            {
              account_id: 'upstream_acct_1',
              account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
            },
          ],
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(called, false, 'the adopter handler must not run for an ambiguous entry');
  });

  it('refuses an unreachable account_id before the adopter handler runs', async () => {
    let called = false;
    const server = createAdcpServerFromPlatform(seamPlatform(), {
      ...SERVER_OPTS,
      accounts: {
        syncAccounts: async params => {
          called = true;
          return { accounts: params.accounts.map(row) };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'idem-seam-3-000000000000000000',
          accounts: [{ account: { account_id: 'someone_elses_account' } }],
        },
      },
    });
    assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    assert.strictEqual(called, false);
  });
});

describe('#1647 — sync_governance on a derived platform', () => {
  const ACCOUNT = { id: 'upstream_acct_1', name: 'Upstream', status: 'active', ctx_metadata: {} };
  const govPlatform = syncGovernance =>
    buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref => (ref?.account_id === undefined || ref.account_id === ACCOUNT.id ? ACCOUNT : null),
        list: async () => ({ items: [ACCOUNT] }),
        syncGovernance,
      },
    });
  const agents = [{ url: 'https://gov.example/mcp' }];

  it('persists an entry whose account the credential can reach', async () => {
    let seen;
    const server = createAdcpServerFromPlatform(
      govPlatform(async entries => {
        seen = entries;
        return entries.map(e => ({ account: e.account, status: 'synced', governance_agents: agents }));
      }),
      SERVER_OPTS
    );
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_governance',
        arguments: {
          idempotency_key: 'idem-gov-1-0000000000000000000',
          accounts: [{ account: { account_id: 'upstream_acct_1' }, governance_agents: agents }],
        },
      },
    });
    assert.strictEqual(result.structuredContent.accounts[0].status, 'synced');
    assert.strictEqual(seen.length, 1);
  });

  it('fails an entry naming an account the credential cannot reach, without persisting it', async () => {
    let seen = [];
    const server = createAdcpServerFromPlatform(
      govPlatform(async entries => {
        seen = entries;
        return entries.map(e => ({ account: e.account, status: 'synced', governance_agents: agents }));
      }),
      SERVER_OPTS
    );
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_governance',
        arguments: {
          idempotency_key: 'idem-gov-2-0000000000000000000',
          accounts: [
            { account: { account_id: 'someone_elses_account' }, governance_agents: agents },
            { account: { account_id: 'upstream_acct_1' }, governance_agents: agents },
          ],
        },
      },
    });
    const rows = result.structuredContent.accounts;
    assert.strictEqual(rows[0].status, 'failed');
    assert.strictEqual(rows[0].errors[0].code, 'ACCOUNT_NOT_FOUND');
    assert.strictEqual(rows[1].status, 'synced');
    assert.strictEqual(seen.length, 1, 'only the reachable entry reaches the adopter');
  });

  it('fails a hybrid reference (id + natural key) without persisting it', async () => {
    let seen = [];
    const server = createAdcpServerFromPlatform(
      govPlatform(async entries => {
        seen = entries;
        return entries.map(e => ({ account: e.account, status: 'synced', governance_agents: agents }));
      }),
      SERVER_OPTS
    );
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_governance',
        arguments: {
          idempotency_key: 'idem-gov-hybrid-000000000000',
          accounts: [
            {
              account: { account_id: 'upstream_acct_1', brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
              governance_agents: agents,
            },
          ],
        },
      },
    });
    const row = result.structuredContent.accounts[0];
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.errors[0].code, 'INVALID_REQUEST');
    assert.strictEqual(seen.length, 0, 'nothing may persist for an ambiguous reference');
  });

  it('fails a natural-key reference with INVALID_REQUEST', async () => {
    const server = createAdcpServerFromPlatform(
      govPlatform(async entries =>
        entries.map(e => ({ account: e.account, status: 'synced', governance_agents: agents }))
      ),
      SERVER_OPTS
    );
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_governance',
        arguments: {
          idempotency_key: 'idem-gov-3-0000000000000000000',
          accounts: [
            { account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' }, governance_agents: agents },
          ],
        },
      },
    });
    const row = result.structuredContent.accounts[0];
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.errors[0].code, 'INVALID_REQUEST');
  });
});

describe('#1647 — framework verifies the resolver honored the reference', () => {
  it('refuses a resolved account whose id is not the one the buyer named', async () => {
    // The pre-14 Shape D pattern: ignore `ref`, return the one account.
    // After the inversion that would serve caller A against whatever the
    // resolver returns, silently. The framework fails it closed instead.
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'the_only_account', name: 'Singleton', status: 'active', ctx_metadata: {} }),
        list: async () => ({ items: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'a_different_account' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    assert.match(result.structuredContent.adcp_error.suggestion, /list_accounts/);
  });

  it('still serves the ref-less path for the same resolver', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'the_only_account', name: 'Singleton', status: 'active', ctx_metadata: {} }),
        list: async () => ({ items: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'premium', promoted_offering: 'cars' } },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
  });
});
