/**
 * `client.accounts.change`, `changeStatus` and `use` (AdCP 3.3.0-beta.3 `request_account` with
 * `account_id`), driven by a TS buyer against an in-process platform seller. A money change needs the
 * revision the change was approved against; other changes read it. A separate or matched account
 * never re-points the registry on its own.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const {
  AccountRequestError,
  AgentClient,
  ADCP_VERSION,
  BuyerAccountRegistry,
  isPreDispatchError,
  nextStep,
} = require('../../dist/lib/index.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');
const { adcpError } = require('../../dist/lib/server/errors.js');

const NOW = '2026-11-01T00:00:00Z';
const KEY = { brand: { domain: 'acme.example' }, operator: 'agency.example' };
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const AUTH = { authInfo: { token: 'buyer-token', clientId: 'buyer-1', scopes: [] } };

/**
 * A seller with one account (acct_1, revision 3) and scripted change outcomes:
 * - money terms: updated, with effective_at;
 * - timezone: updated, or CONFLICT on a stale revision;
 * - currency: a separate account when allowed, otherwise ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT;
 * - operator_unit: matched to acct_2;
 * - brand countries: in review.
 */
function sellerWorld() {
  const world = {
    accounts: new Map([
      [
        'acct_1',
        {
          account_id: 'acct_1',
          name: 'Acme',
          status: 'active',
          brand: KEY.brand,
          operator: KEY.operator,
          revision: 3,
          timezone: 'UTC',
          payment_terms: 'net_30',
        },
      ],
      ['acct_2', { account_id: 'acct_2', name: 'Acme EU', status: 'active', revision: 1, timezone: 'UTC' }],
    ]),
    requests: new Map(),
    sent: [],
    seq: 0,
    /** Run once before the next request is handled: a concurrent change at the seller. */
    beforeNext: undefined,
  };
  const record = (requested, fields) => {
    const entry = { request_id: `areq_${++world.seq}`, requested, created_at: NOW, updated_at: NOW, ...fields };
    world.requests.set(entry.request_id, entry);
    return { request: structuredClone(entry) };
  };
  world.requestAccount = async params => {
    const { idempotency_key: _k, adcp_version: _v, adcp_major_version: _m, context: _c, ext: _e, ...body } = params;
    world.sent.push(structuredClone(body));
    const hook = world.beforeNext;
    world.beforeNext = undefined;
    hook?.();
    const account = world.accounts.get(body.account_id);
    if (!account) return adcpError('ACCOUNT_NOT_FOUND', { message: 'Account not found', recovery: 'terminal' });
    const { account_id: _a, revision, allow_separate_account: allowSeparate, ...changes } = body;
    if (revision !== undefined && revision !== account.revision)
      return adcpError('CONFLICT', { message: 'Stale revision', recovery: 'correctable' });
    const requested = { account_id: body.account_id, ...(revision !== undefined && { revision }), ...changes };
    if ('currency' in changes) {
      if (!allowSeparate)
        return record(requested, {
          state: 'rejected',
          errors: [{ code: 'ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT', message: 'EUR needs its own contract' }],
        });
      const created = {
        account_id: 'acct_eur',
        name: 'Acme EUR',
        status: 'active',
        currency: changes.currency,
        revision: 1,
      };
      world.accounts.set(created.account_id, created);
      return record(requested, {
        state: 'resolved',
        resolution: 'created',
        account_id: created.account_id,
        account: created,
        not_carried_over: ['reporting_delivery_configs', 'creatives'],
      });
    }
    if ('operator_unit' in changes) {
      return record(requested, {
        state: 'resolved',
        resolution: 'matched',
        account_id: 'acct_2',
        account: world.accounts.get('acct_2'),
      });
    }
    if ('brand' in changes) {
      return record(requested, {
        state: 'in_review',
        pending_action: { waiting_on: 'seller', kind: 'review', message: 'Checking the new market' },
      });
    }
    Object.assign(account, changes, { revision: account.revision + 1 });
    const money = ['billing', 'billing_entity', 'payment_terms'].some(name => name in changes);
    return record(requested, {
      state: 'resolved',
      resolution: 'updated',
      account_id: account.account_id,
      account: structuredClone(account),
      ...(money && { effective_at: '2026-12-01T00:00:00Z' }),
    });
  };
  world.store = {
    resolution: 'explicit',
    resolve: async ref => {
      const account = ref?.account_id ? world.accounts.get(ref.account_id) : undefined;
      return account ? { ...account, id: account.account_id, ctx_metadata: {} } : null;
    },
    list: async filter => ({
      items: [...world.accounts.values()]
        .filter(account => !filter.account?.account_id || filter.account.account_id === account.account_id)
        .map(account => ({ ...account, id: account.account_id, ctx_metadata: {} })),
    }),
    listRequests: async filter => ({
      items: [...world.requests.values()]
        .filter(entry => !filter.request_ids || filter.request_ids.includes(entry.request_id))
        .map(entry => structuredClone(entry)),
    }),
  };
  return world;
}

function sellerFor(world, { requests = true } = {}) {
  return createAdcpServerFromPlatform(
    {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        supportedBillings: ['operator'],
        config: {},
        ...(requests && {
          accountRequests: { changeableAttributes: ['billing', 'payment_terms', 'currency', 'timezone'] },
        }),
      },
      sales: { getProducts: async () => ({ products: [] }) },
      accounts: requests ? world.store : { ...world.store, listRequests: undefined },
    },
    {
      name: 'account-change-seller',
      version: '1.0.0',
      adcpVersion: ADCP_VERSION,
      logger: silent,
      idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
      validation: { requests: 'strict', responses: 'strict' },
      ...(requests && { accounts: { requestAccount: world.requestAccount } }),
    }
  );
}

async function buyerFor(t, world, options) {
  const server = sellerFor(world, options);
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

function refusedWith(code) {
  return error => {
    assert.ok(error instanceof AccountRequestError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.recovery, 'correctable');
    assert.equal(isPreDispatchError(error), true, 'nothing was sent');
    return true;
  };
}

describe('client.accounts.change against an in-process seller', () => {
  test('a money change needs the approved revision, and sends nothing without it', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    await assert.rejects(
      buyer.accounts.change('acct_1', { payment_terms: 'net_60' }),
      refusedWith('ACCOUNT_REVISION_REQUIRED')
    );
    assert.equal(world.sent.length, 0);
  });

  test('a money change with revision is updated, with the new revision and effective_at', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    const outcome = await buyer.accounts.change('acct_1', { payment_terms: 'net_60' }, { revision: 3 });
    assert.equal(outcome.kind, 'updated');
    assert.equal(outcome.account_id, 'acct_1');
    assert.equal(outcome.revision, 4);
    assert.equal(outcome.effective_at, '2026-12-01T00:00:00Z');
    assert.equal(outcome.account.payment_terms, 'net_60');
    assert.equal(nextStep(outcome), 'none');
    assert.deepEqual(world.sent, [{ account_id: 'acct_1', payment_terms: 'net_60', revision: 3 }]);
  });

  test('other changes read the revision from list_accounts', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    const outcome = await buyer.accounts.change('acct_1', { timezone: 'Europe/Paris' });
    assert.equal(outcome.kind, 'updated');
    assert.equal(outcome.revision, 4);
    assert.equal(outcome.effective_at, undefined, 'only money changes carry effective_at');
    assert.equal(world.sent[0].revision, 3);
    assert.equal(world.sent[0].allow_separate_account, undefined, 'allowSeparateAccount defaults to false');
  });

  test('an automatic revision retries once on a concurrent bump of other fields', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    world.beforeNext = () => {
      const account = world.accounts.get('acct_1');
      Object.assign(account, { name: 'Acme Corp', revision: account.revision + 1 });
    };
    const outcome = await buyer.accounts.change('acct_1', { timezone: 'Europe/Paris' });
    assert.equal(outcome.kind, 'updated');
    assert.equal(outcome.revision, 5);
    assert.deepEqual(
      world.sent.map(body => body.revision),
      [3, 4]
    );
  });

  test('a conflict on the field being changed is not retried', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    world.beforeNext = () => {
      const account = world.accounts.get('acct_1');
      Object.assign(account, { timezone: 'Asia/Tokyo', revision: account.revision + 1 });
    };
    await assert.rejects(buyer.accounts.change('acct_1', { timezone: 'Europe/Paris' }), error => {
      assert.ok(error instanceof AccountRequestError);
      assert.equal(error.code, 'CONFLICT');
      assert.equal(isPreDispatchError(error), false);
      return true;
    });
    assert.equal(world.sent.length, 1);
  });

  test('an explicit revision is never retried on CONFLICT', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    await assert.rejects(
      buyer.accounts.change('acct_1', { timezone: 'Europe/Paris' }, { revision: 2 }),
      error => error instanceof AccountRequestError && error.code === 'CONFLICT'
    );
    assert.equal(world.sent.length, 1);
  });

  test('a change the seller takes only as a new account is rejected with requiresNewAccount', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    const outcome = await buyer.accounts.change('acct_1', { currency: 'EUR' });
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.requiresNewAccount, true);
    assert.equal(nextStep(outcome), 'contact_seller');
  });

  test('a separate account lists what is missing and never re-points the registry until use()', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    await buyer.accounts.use(KEY, 'acct_1');
    assert.equal((await buyer.accounts.get(KEY)).account_id, 'acct_1');
    assert.equal((await buyer.accounts.get(KEY)).status, 'active', 'use() reads the status from list_accounts');

    const outcome = await buyer.accounts.change('acct_1', { currency: 'EUR' }, { allowSeparateAccount: true });
    assert.equal(outcome.kind, 'separate_account');
    assert.equal(outcome.account_id, 'acct_eur');
    assert.equal(outcome.previousAccountId, 'acct_1');
    assert.deepEqual(outcome.not_carried_over, ['reporting_delivery_configs', 'creatives']);
    assert.deepEqual(outcome.key, KEY);
    assert.deepEqual(outcome.subscriptionsNotCovering, [], 'best effort: this seller serves no subscriptions');
    assert.equal(world.sent.at(-1).allow_separate_account, true);
    assert.equal(nextStep(outcome), 'none');

    // Nothing moved: the key still names the old account until use().
    assert.equal((await buyer.accounts.get(KEY)).account_id, 'acct_1');
    await buyer.accounts.use(outcome.key, outcome.account_id);
    const moved = await buyer.accounts.get(KEY);
    assert.equal(moved.account_id, 'acct_eur');
    assert.equal(moved.status, 'active');
  });

  test('a matched account is reported, not adopted', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    await buyer.accounts.use(KEY, 'acct_1', { status: 'active' });
    const outcome = await buyer.accounts.change('acct_1', { operator_unit: { id: 'eu' } });
    assert.equal(outcome.kind, 'matched_existing');
    assert.equal(outcome.account_id, 'acct_2');
    assert.equal(outcome.previousAccountId, 'acct_1');
    assert.deepEqual(outcome.key, KEY);
    assert.equal((await buyer.accounts.get(KEY)).account_id, 'acct_1');
  });

  test('a pending change is read back with changeStatus', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    const pending = await buyer.accounts.change('acct_1', { brand: { domain: 'acme.example', countries: ['DE'] } });
    assert.equal(pending.kind, 'pending');
    assert.equal(pending.account_id, 'acct_1');
    assert.equal(pending.action.message, 'Checking the new market');
    assert.equal(nextStep(pending), 'wait_for_seller');

    const entry = world.requests.get(pending.request_id);
    delete entry.pending_action;
    Object.assign(entry, {
      state: 'resolved',
      resolution: 'updated',
      account_id: 'acct_1',
      account: { ...world.accounts.get('acct_1'), revision: 4 },
      updated_at: '2026-11-02T00:00:00Z',
    });
    const resolved = await buyer.accounts.changeStatus('acct_1', pending.request_id);
    assert.equal(resolved.kind, 'updated');
    assert.equal(resolved.revision, 4);

    const missing = await buyer.accounts.changeStatus('acct_1', 'areq_unknown');
    assert.equal(missing.kind, 'rejected');
    assert.equal(missing.errors[0].code, 'ACCOUNT_REQUEST_NOT_FOUND');
  });

  test('unknown attributes are refused before dispatch', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    await assert.rejects(buyer.accounts.change('acct_1', { sandbox: true }), refusedWith('ACCOUNT_CHANGE_INVALID'));
    await assert.rejects(buyer.accounts.change('acct_1', {}), refusedWith('ACCOUNT_CHANGE_INVALID'));
    assert.equal(world.sent.length, 0);
  });

  test('a seller without account.requests is refused before dispatch', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world, { requests: false });
    await assert.rejects(
      buyer.accounts.change('acct_1', { timezone: 'Europe/Paris' }),
      refusedWith('ACCOUNT_REQUESTS_UNSUPPORTED')
    );
    assert.equal(world.sent.length, 0);
  });

  test('use() refuses an account_id key and records an unlisted account as unknown', async t => {
    const world = sellerWorld();
    const buyer = await buyerFor(t, world);
    await assert.rejects(buyer.accounts.use({ account_id: 'acct_1' }, 'acct_2'), TypeError);
    await buyer.accounts.use(KEY, 'acct_missing');
    assert.equal((await buyer.accounts.get(KEY)).status, 'unknown');
  });
});

describe('subscriptionsNotCovering', () => {
  test('lists account_ids-scoped subscriptions naming the old account but not the new one', async () => {
    const separate = {
      request_id: 'areq_1',
      state: 'resolved',
      resolution: 'created',
      requested: { account_id: 'acct_1', currency: 'EUR' },
      account_id: 'acct_eur',
      account: { account_id: 'acct_eur', name: 'Acme EUR', status: 'active' },
      not_carried_over: [],
      created_at: NOW,
      updated_at: NOW,
    };
    const subscription = (id, scope) => ({ subscription_id: id, configuration: { subscription_id: id, scope } });
    const registry = new BuyerAccountRegistry(
      () => 'seller:caller',
      async () => {
        throw new Error('sync_accounts must not be called');
      },
      undefined,
      async () => [],
      {
        requests: {
          supported: async () => true,
          request: async () => ({ success: true, status: 'completed', metadata: {}, data: { request: separate } }),
          read: async () => [],
          subscriptions: async () => [
            subscription('sub_b', { account_ids: ['acct_1', 'acct_9'] }),
            subscription('sub_a', { account_ids: ['acct_1'] }),
            subscription('sub_both', { account_ids: ['acct_1', 'acct_eur'] }),
            subscription('sub_all', { all_authorized_accounts: true }),
            subscription('sub_other', { account_ids: ['acct_9'] }),
          ],
        },
      }
    );
    const outcome = await registry.change('acct_1', { currency: 'EUR' }, { revision: 3, allowSeparateAccount: true });
    assert.equal(outcome.kind, 'separate_account');
    assert.deepEqual(outcome.subscriptionsNotCovering, ['sub_a', 'sub_b']);
    assert.deepEqual(outcome.not_carried_over, [], '[] means everything carried over');
    assert.equal(outcome.key, undefined, 'no natural key is known for acct_1');
  });

  test('a failing subscription read is best effort', async () => {
    const registry = new BuyerAccountRegistry(
      () => 'seller:caller',
      async () => {
        throw new Error('unused');
      },
      undefined,
      async () => [],
      {
        requests: {
          supported: async () => true,
          request: async () => ({
            success: true,
            status: 'completed',
            metadata: {},
            data: {
              request: {
                request_id: 'areq_1',
                state: 'resolved',
                resolution: 'created',
                requested: { account_id: 'acct_1', currency: 'EUR' },
                account_id: 'acct_eur',
                account: { account_id: 'acct_eur', name: 'Acme EUR', status: 'active' },
                not_carried_over: ['creatives'],
                created_at: NOW,
                updated_at: NOW,
              },
            },
          }),
          read: async () => [],
          subscriptions: async () => {
            throw new Error('get_principal is not served');
          },
        },
      }
    );
    const outcome = await registry.change('acct_1', { currency: 'EUR' }, { revision: 3, allowSeparateAccount: true });
    assert.deepEqual(outcome.subscriptionsNotCovering, []);
  });
});
