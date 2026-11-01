/**
 * Seller side of AdCP 3.3 `account.requests` (adcp-client#3575): registering `request_account`
 * advertises the capability block and feature id, and `accounts.listRequests` serves the caller's
 * requests on `list_accounts`. A TS buyer's `client.accounts.ensure` routes through this server.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { AgentClient, ADCP_VERSION } = require('../../dist/lib/index.js');
const { toReleasePrecisionVersion } = require('../../dist/lib/version.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { PlatformConfigError } = require('../../dist/lib/server/decisioning/index.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');
const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');

const WIRE = toReleasePrecisionVersion(ADCP_VERSION);
const NOW = '2026-11-01T00:00:00Z';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * An in-memory seller: one account the caller can reach, and request records per caller. Opens for
 * `review.example` go in review; everything else resolves by creating an account.
 */
function sellerWorld() {
  const world = {
    accounts: new Map([
      ['acct_1', { account_id: 'acct_1', name: 'Acme', status: 'active', revision: 3, timezone: 'UTC' }],
    ]),
    requests: new Map(),
    listRequestCalls: [],
    seq: 0,
  };
  const owner = ctx => ctx?.authInfo?.clientId ?? 'anonymous';
  world.record = (ctx, requested, fields) => {
    const record = {
      request_id: `areq_${++world.seq}`,
      requested,
      created_at: NOW,
      updated_at: NOW,
      ...fields,
    };
    world.requests.set(record.request_id, { owner: owner(ctx), record });
    return record;
  };
  world.requestAccount = async (params, ctx) => {
    const {
      idempotency_key: _k,
      adcp_version: _v,
      adcp_major_version: _m,
      context: _c,
      ext: _e,
      ...requested
    } = params;
    if (requested.brand?.domain === 'review.example') {
      return {
        request: world.record(ctx, requested, {
          state: 'in_review',
          pending_action: { waiting_on: 'seller', kind: 'review', message: 'Credit check' },
        }),
      };
    }
    const accountId = `acct_${requested.brand.domain.split('.')[0]}`;
    const account = { account_id: accountId, name: requested.brand.domain, status: 'active', revision: 1 };
    world.accounts.set(accountId, account);
    return {
      request: world.record(ctx, requested, {
        state: 'resolved',
        resolution: 'created',
        account_id: accountId,
        account,
      }),
    };
  };
  world.approve = requestId => {
    const entry = world.requests.get(requestId);
    const accountId = 'acct_review';
    const account = { account_id: accountId, name: 'Review', status: 'active', revision: 1 };
    world.accounts.set(accountId, account);
    const { pending_action: _p, ...rest } = entry.record;
    entry.record = {
      ...rest,
      state: 'resolved',
      resolution: 'created',
      account_id: accountId,
      account,
      updated_at: '2026-11-02T00:00:00Z',
    };
  };
  world.store = {
    resolution: 'explicit',
    resolve: async ref => {
      const account = ref?.account_id ? world.accounts.get(ref.account_id) : undefined;
      return account ? { id: account.account_id, name: account.name, status: account.status, ctx_metadata: {} } : null;
    },
    list: async () => ({
      items: [...world.accounts.values()].map(account => ({ ...account, id: account.account_id, ctx_metadata: {} })),
    }),
    listRequests: async (filter, ctx) => {
      world.listRequestCalls.push(structuredClone(filter));
      const wanted = filter.request_ids ? new Set(filter.request_ids) : undefined;
      const items = [...world.requests.values()]
        .filter(entry => entry.owner === owner(ctx) && (!wanted || wanted.has(entry.record.request_id)))
        .map(entry => structuredClone(entry.record))
        .reverse();
      const start = Number(filter.requests_pagination?.cursor ?? 0);
      const limit = filter.requests_pagination?.max_results ?? 100;
      const page = items.slice(start, start + limit);
      return {
        items: page,
        ...(start + limit < items.length && { nextCursor: String(start + limit) }),
        totalCount: items.length,
      };
    },
  };
  return world;
}

function platformServer(world, extra = {}) {
  return createAdcpServerFromPlatform(
    {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        supportedBillings: ['operator'],
        config: {},
        accountRequests: {
          changeableAttributes: ['billing', 'payment_terms', 'timezone'],
          pendingActionKinds: ['review', 'accept_terms'],
        },
        ...extra.capabilities,
      },
      sales: { getProducts: async () => ({ products: [] }) },
      accounts: { ...world.store, ...extra.accounts },
    },
    {
      name: 'account-requests-seller',
      version: '1.0.0',
      adcpVersion: ADCP_VERSION,
      logger: silent,
      idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
      validation: { requests: 'strict', responses: 'strict' },
      accounts: { requestAccount: world.requestAccount },
      ...extra.options,
    }
  );
}

const AUTH = { authInfo: { token: 'buyer-token', clientId: 'buyer-1', scopes: [] } };

async function call(server, name, args, auth = AUTH) {
  const response = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name, arguments: { adcp_version: WIRE, ...args } } },
    auth
  );
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return response.structuredContent;
}

async function capabilities(server, version = WIRE) {
  return call(server, 'get_adcp_capabilities', { adcp_version: version });
}

describe('account.requests on the platform path', () => {
  test('registering requestAccount advertises the block and the experimental feature id', async t => {
    const server = platformServer(sellerWorld());
    t.after(() => server.close());
    const caps = await capabilities(server);
    assert.deepEqual(caps.account.requests, {
      supported: true,
      request_task: 'request_account',
      read_task: 'list_accounts',
      changeable_attributes: ['billing', 'payment_terms', 'timezone'],
      pending_action_kinds: ['review', 'accept_terms'],
    });
    assert.ok(caps.experimental_features.includes('account.requests'));
    assert.deepEqual(caps.account.supported_billing, ['operator'], 'the platform account block is kept');
    const validate = getSchemaValidatorByRef('protocol/get-adcp-capabilities-response.json');
    assert.equal(validate(caps), true, JSON.stringify(validate.errors));
  });

  test('a release without request_account sees neither the block nor the feature id', async t => {
    const server = platformServer(sellerWorld(), {
      capabilities: { supported_versions: ['3.2', WIRE] },
    });
    t.after(() => server.close());
    const caps = await capabilities(server, '3.2');
    assert.equal(caps.account.requests, undefined);
    assert.ok(!(caps.experimental_features ?? []).includes('account.requests'));
  });

  test('a platform without requestAccount advertises nothing, even through overrides', async t => {
    const world = sellerWorld();
    const server = createAdcpServerFromPlatform(
      {
        capabilities: {
          specialisms: ['sales-non-guaranteed'],
          creative_agents: [],
          channels: ['display'],
          pricingModels: ['cpm'],
          supportedBillings: ['operator'],
          config: {},
          overrides: { experimental_features: ['account.requests'] },
        },
        sales: {},
        accounts: { resolve: world.store.resolve, list: world.store.list },
      },
      { name: 'no-requests', version: '1.0.0', adcpVersion: ADCP_VERSION, logger: silent }
    );
    t.after(() => server.close());
    const caps = await capabilities(server);
    assert.equal(caps.account.requests, undefined);
    assert.ok(!(caps.experimental_features ?? []).includes('account.requests'));
  });

  test('list_accounts returns the caller’s requests only when asked, schema-valid under strict validation', async t => {
    const world = sellerWorld();
    const server = platformServer(world);
    t.after(() => server.close());
    const opened = await call(server, 'request_account', {
      idempotency_key: 'open-review-0000000001',
      brand: { domain: 'review.example' },
      operator: 'agency.example',
    });
    assert.equal(opened.request.state, 'in_review');
    await call(server, 'request_account', {
      idempotency_key: 'open-ready-00000000001',
      brand: { domain: 'ready.example' },
      operator: 'agency.example',
    });
    // Another caller's request is never listed.
    await call(
      server,
      'request_account',
      { idempotency_key: 'other-caller-000000001', brand: { domain: 'other.example' }, operator: 'agency.example' },
      { authInfo: { token: 'other', clientId: 'buyer-2', scopes: [] } }
    );

    const plain = await call(server, 'list_accounts', {});
    // Buyers read the revision a change is based on from list_accounts.
    assert.equal(plain.accounts.find(account => account.account_id === 'acct_1').revision, 3);
    assert.equal(plain.account_requests, undefined);
    assert.equal(plain.account_requests_pagination, undefined);
    assert.equal(world.listRequestCalls.length, 0, 'listRequests runs only when requests are asked for');

    const validate = getSchemaValidatorByRef('account/list-accounts-response.json');
    const all = await call(server, 'list_accounts', { include_requests: true });
    assert.deepEqual(
      all.account_requests.map(item => [item.request_id, item.state]),
      [
        ['areq_2', 'resolved'],
        ['areq_1', 'in_review'],
      ]
    );
    assert.deepEqual(all.account_requests_pagination, { has_more: false, total_count: 2 });
    assert.ok(all.accounts.length >= 1, 'the accounts page is unchanged');
    assert.equal(validate(all), true, JSON.stringify(validate.errors));

    const one = await call(server, 'list_accounts', { request_ids: ['areq_1', 'areq_3', 'unknown'] });
    assert.deepEqual(
      one.account_requests.map(item => item.request_id),
      ['areq_1'],
      'unknown IDs and other callers’ IDs are omitted'
    );

    const paged = await call(server, 'list_accounts', { requests_pagination: { max_results: 1 } });
    assert.deepEqual(paged.account_requests_pagination, { has_more: true, cursor: '1', total_count: 2 });
    assert.equal(validate(paged), true, JSON.stringify(validate.errors));
  });

  test('listRequests needs accounts.list', () => {
    const world = sellerWorld();
    assert.throws(
      () => platformServer(world, { accounts: { list: undefined } }),
      error => error instanceof PlatformConfigError && /listRequests/.test(error.message)
    );
  });

  test('requestAccount without listRequests warns that buyers cannot poll', t => {
    const world = sellerWorld();
    const warnings = [];
    const server = platformServer(world, {
      accounts: { listRequests: undefined },
      options: { logger: { ...silent, warn: message => warnings.push(message) } },
    });
    t.after(() => server.close());
    assert.ok(warnings.some(message => /without accounts\.listRequests/.test(message)));
  });
});

describe('account.requests on createAdcpServer', () => {
  test('a seller with no account capabilities gets a minimal account block carrying requests', async t => {
    const server = createAdcpServer({
      name: 'direct',
      version: '1.0.0',
      adcpVersion: ADCP_VERSION,
      logger: silent,
      capabilities: { supported_versions: ['3.2', WIRE], accountRequests: { changeableAttributes: ['timezone'] } },
      validation: { requests: 'strict', responses: 'strict' },
      accounts: { requestAccount: sellerWorld().requestAccount },
    });
    t.after(() => server.close());
    const caps = await capabilities(server);
    assert.deepEqual(caps.account, {
      supported_billing: ['agent'],
      requests: {
        supported: true,
        request_task: 'request_account',
        read_task: 'list_accounts',
        changeable_attributes: ['timezone'],
      },
    });
    assert.ok(caps.experimental_features.includes('account.requests'));
    const legacy = await capabilities(server, '3.2');
    assert.equal(legacy.account, undefined, 'the synthesized block is not shown to a release without requests');
  });

  test('an adopter override keeps its optional fields; the task names stay fixed', async t => {
    const server = createAdcpServer({
      name: 'direct',
      version: '1.0.0',
      adcpVersion: ADCP_VERSION,
      logger: silent,
      capabilities: {
        account: { supportedBilling: ['operator'] },
        overrides: { account: { requests: { supported: true, pending_action_kinds: ['sign_up'] } } },
      },
      accounts: { requestAccount: sellerWorld().requestAccount },
    });
    t.after(() => server.close());
    const caps = await capabilities(server);
    assert.deepEqual(caps.account.requests, {
      supported: true,
      request_task: 'request_account',
      read_task: 'list_accounts',
      pending_action_kinds: ['sign_up'],
    });
  });

  test('accountRequests without requestAccount is a configuration error', () => {
    assert.throws(
      () =>
        createAdcpServer({
          name: 'direct',
          version: '1.0.0',
          logger: silent,
          capabilities: { accountRequests: { changeableAttributes: ['timezone'] } },
          accounts: {},
        }),
      /register accounts\.requestAccount/
    );
  });
});

describe('a TS buyer routes ensure through request_account against this server', () => {
  async function connect(t, server) {
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'TS buyer', version: '1.0.0' });
    await server.connect(sellerTransport);
    const dispatch = sellerTransport.onmessage;
    sellerTransport.onmessage = (message, extra) => dispatch(message, { ...extra, ...AUTH });
    await mcp.connect(buyerTransport);
    t.after(async () => {
      await mcp.close();
      await server.close();
    });
    return AgentClient.fromMCPClient(mcp, { adcpVersion: ADCP_VERSION });
  }

  test('ready, then pending and refreshed to ready through list_accounts', async t => {
    const world = sellerWorld();
    const buyer = await connect(t, platformServer(world));

    const ready = await buyer.accounts.ensure(
      { brand: { domain: 'ready.example' }, operator: 'agency.example' },
      { billing: 'operator' }
    );
    assert.equal(ready.kind, 'ready');
    assert.equal(ready.via, 'request_account');
    assert.equal(ready.account_id, 'acct_ready');

    const pending = await buyer.accounts.ensure(
      { brand: { domain: 'review.example' }, operator: 'agency.example' },
      { billing: 'operator' }
    );
    assert.equal(pending.kind, 'pending');
    assert.equal(pending.via, 'request_account');
    assert.equal(pending.action.message, 'Credit check');
    assert.deepEqual(await buyer.accounts.refresh(), [], 'nothing moved yet');

    world.approve(pending.request_id);
    const moved = await buyer.accounts.refresh();
    assert.deepEqual(
      moved.map(outcome => [outcome.kind, outcome.account_id]),
      [['ready', 'acct_review']]
    );
    assert.ok(world.listRequestCalls.some(filter => filter.request_ids?.includes(pending.request_id)));
    assert.equal(world.requests.size, 2, 'no duplicate request was opened');
  });
});
