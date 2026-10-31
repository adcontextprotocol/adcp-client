/**
 * `client.accounts.ensure` reshaped (AdCP 3.3): capability routing to `request_account`, the
 * discriminated `AccountOutcome` (`ready | pending | ambiguous | rejected`, with pending as a value),
 * `refresh` and `pending`, and the agent-facing `nextStep` / `formatPendingAction`.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { AccountRequestError, BuyerAccountRegistry, formatPendingAction, nextStep } = require('../../dist/lib/index.js');
const { parseCapabilitiesResponse } = require('../../dist/lib/utils/capabilities.js');

const KEY = { brand: { domain: 'renault.fr', countries: ['FR'] }, operator: 'wppmedia.fr' };
const NOW = '2026-11-01T00:00:00Z';

function wireRequest(state, extra = {}) {
  return {
    request_id: 'req-1',
    state,
    requested: { ...KEY },
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

/** A seller advertising account.requests, with a scripted request lifecycle. */
function requestSeller(script) {
  const sent = [];
  const reads = [];
  const seller = {
    state: script.initial,
    sent,
    reads,
    requests: {
      supported: async () => true,
      request: async params => {
        sent.push(structuredClone(params));
        const reply = script.request(params, seller);
        return reply.success === false
          ? reply
          : { success: true, status: 'completed', metadata: {}, data: { status: 'completed', request: reply } };
      },
      read: async ids => {
        reads.push([...ids]);
        return seller.state && ids.includes(seller.state.request_id) ? [structuredClone(seller.state)] : [];
      },
    },
  };
  return seller;
}

function registryFor(seller, options = {}) {
  return new BuyerAccountRegistry(
    () => options.scope ?? 'seller:caller',
    async () => {
      throw new Error('sync_accounts must not be called when the seller advertises account.requests');
    },
    options.storage,
    options.repair,
    { requests: seller.requests }
  );
}

describe('nextStep and formatPendingAction', () => {
  test('nextStep switches on whose turn it is, never on the extensible kind', () => {
    assert.equal(nextStep({ kind: 'ready', via: 'sync_accounts' }), 'none');
    assert.equal(
      nextStep({ kind: 'ambiguous', candidates: [], request_id: 'r', via: 'request_account' }),
      'pick_candidate'
    );
    assert.equal(nextStep({ kind: 'rejected', errors: [], via: 'sync_accounts' }), 'contact_seller');
    const pending = action => ({ kind: 'pending', action, via: 'request_account' });
    assert.equal(nextStep(pending({ waiting_on: 'seller', kind: 'review', message: '' })), 'wait_for_seller');
    assert.equal(
      nextStep(pending({ waiting_on: 'buyer', kind: 'sign_up', message: '', url: 'https://seller.example/x' })),
      'send_human_to_url'
    );
    assert.equal(nextStep(pending({ waiting_on: 'buyer', kind: 'future_kind', message: '' })), 'contact_seller');
  });

  test('formatPendingAction treats the seller message as untrusted text', () => {
    const text = formatPendingAction({
      waiting_on: 'buyer',
      kind: 'accept_terms',
      message: 'Sign   the "terms"‮ now\u0007',
      url: 'https://seller.example/terms',
      expires_at: '2026-11-08T00:00:00Z',
    });
    assert.equal(
      text,
      [
        'Waiting on you: accept_terms.',
        `Seller says: "Sign the 'terms' now"`,
        'A person completes it at https://seller.example/terms',
        'Expires 2026-11-08T00:00:00Z.',
      ].join('\n')
    );
    const long = formatPendingAction({ waiting_on: 'seller', kind: 'review', message: 'x'.repeat(5000) });
    assert.match(long, /^Waiting on the seller: review\./);
    assert.ok(long.length < 1100, 'the message is capped');
  });
});

describe('ensure routes to request_account when the seller advertises account.requests', () => {
  test('in review is a pending value; a repeat ensure re-reads it and never opens a duplicate', async () => {
    const seller = requestSeller({
      initial: undefined,
      request: (params, s) => {
        s.state = wireRequest('in_review', {
          pending_action: { waiting_on: 'seller', kind: 'review', message: 'Credit check' },
        });
        return s.state;
      },
    });
    const registry = registryFor(seller);
    const first = await registry.ensure(KEY, { billing: 'operator', currency: 'EUR', timezone: 'Europe/Paris' });
    assert.equal(first.kind, 'pending');
    assert.equal(first.via, 'request_account');
    assert.equal(first.request_id, 'req-1');
    assert.equal(first.action.message, 'Credit check');
    assert.equal(nextStep(first), 'wait_for_seller');
    // The natural key gained currency and timezone; billing terms rode along once.
    assert.equal(seller.sent[0].currency, 'EUR');
    assert.equal(seller.sent[0].timezone, 'Europe/Paris');
    assert.equal(seller.sent[0].billing, 'operator');
    assert.match(seller.sent[0].idempotency_key, /^adcp-ensure-[0-9a-f]{48}$/);

    const again = await registry.ensure(KEY, { currency: 'EUR', timezone: 'Europe/Paris' });
    assert.equal(again.kind, 'pending');
    assert.equal(seller.sent.length, 1, 'no second request_account');
    assert.deepEqual(seller.reads.at(-1), ['req-1']);

    // pending() is local; refresh() reports what moved.
    assert.deepEqual(
      (await registry.pending()).map(item => [item.kind, item.request_id]),
      [['pending', 'req-1']]
    );
    assert.deepEqual(await registry.refresh(), [], 'nothing moved');
    // adcp#8620: a created account carries its money terms, which can differ from those requested.
    seller.state = wireRequest('resolved', {
      account_id: 'acc-renault',
      resolution: 'created',
      account: { account_id: 'acc-renault', name: 'Renault', status: 'active', payment_terms: 'net_45' },
    });
    const moved = await registry.refresh();
    assert.equal(moved.length, 1);
    assert.equal(moved[0].kind, 'ready');
    assert.equal(moved[0].account_id, 'acc-renault');
    assert.equal(moved[0].resolution, 'created');
    assert.equal(moved[0].account.payment_terms, 'net_45');
    assert.deepEqual(await registry.pending(), []);
    // The account_id alias is published for account-scoped tasks.
    assert.equal((await registry.getByAccountId('acc-renault')).status, 'active');
    const ready = await registry.ensure({ ...KEY, currency: 'EUR', timezone: 'Europe/Paris' });
    assert.equal(ready.kind, 'ready');
    assert.equal(ready.account_id, 'acc-renault');
    assert.equal(seller.sent.length, 1);
  });

  test('ambiguous carries candidates, and choose continues the same request', async () => {
    const candidates = [{ account_id: 'acc-a' }, { account_id: 'acc-b' }];
    const seller = requestSeller({
      request: (params, s) => {
        s.state = params.request_id
          ? wireRequest('resolved', { account_id: params.account_id })
          : wireRequest('ambiguous', { candidates });
        return s.state;
      },
    });
    const registry = registryFor(seller);
    const outcome = await registry.ensure(KEY, { billing: 'operator' });
    assert.equal(outcome.kind, 'ambiguous');
    assert.equal(nextStep(outcome), 'pick_candidate');
    assert.deepEqual(outcome.candidates, candidates);
    await assert.rejects(outcome.choose('acc-z'), /not one of this request's candidates/);
    const chosen = await outcome.choose('acc-b');
    assert.equal(chosen.kind, 'ready');
    assert.equal(chosen.account_id, 'acc-b');
    assert.equal(seller.sent[1].request_id, 'req-1');
    assert.equal(seller.sent[1].account_id, 'acc-b');
  });

  test('rejected is a value; a later ensure opens a new request with a new key', async () => {
    let attempt = 0;
    const seller = requestSeller({
      request: (params, s) => {
        attempt += 1;
        s.state =
          attempt === 1
            ? wireRequest('rejected', { errors: [{ code: 'ACCOUNT_REQUEST_REJECTED', message: 'No credit' }] })
            : wireRequest('in_review', { request_id: 'req-2' });
        return s.state;
      },
    });
    const registry = registryFor(seller);
    const rejected = await registry.ensure(KEY, { billing: 'operator' });
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.errors[0].message, 'No credit');
    assert.equal(nextStep(rejected), 'contact_seller');
    const retried = await registry.ensure(KEY, { billing: 'operator' });
    assert.equal(retried.kind, 'pending');
    assert.notEqual(seller.sent[1].idempotency_key, seller.sent[0].idempotency_key);
  });

  test('a failure to process throws AccountRequestError with the wire code', async () => {
    const seller = requestSeller({
      request: () => ({
        success: false,
        status: 'completed',
        metadata: {},
        error: 'bad',
        data: {
          status: 'failed',
          errors: [{ code: 'INVALID_REQUEST', message: 'brand.domain is required', recovery: 'correctable' }],
        },
      }),
    });
    await assert.rejects(registryFor(seller).ensure(KEY), error => {
      assert.ok(error instanceof AccountRequestError);
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.recovery, 'correctable');
      assert.equal(error.operation, 'request_account');
      return true;
    });
  });

  test('registries sharing storage send the same key for the same request', async () => {
    const records = new Map();
    const storage = {
      get: async key => records.get(key),
      set: async (key, value) => records.set(key, structuredClone(value)),
      list: async scope => [...records.entries()].filter(([key]) => key.startsWith(`${scope}:`)).map(([, v]) => v),
    };
    const keys = [];
    const seller = requestSeller({
      request: (params, s) => {
        keys.push(params.idempotency_key);
        s.state = undefined; // the seller forgot it, so the second registry asks again
        return wireRequest('in_review');
      },
    });
    await registryFor(seller, { storage }).ensure(KEY, { billing: 'operator' });
    await registryFor(seller, { storage }).ensure(KEY, { billing: 'operator' });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'the seller replays one request instead of opening two');
    // A fresh registry over the same storage enumerates it for pending().
    assert.equal((await registryFor(seller, { storage }).pending()).length, 1);
  });
});

test('refresh reports a resolved request even when another account fails to re-read', async () => {
  const seller = requestSeller({
    request: (params, s) => {
      s.state = wireRequest('in_review');
      return s.state;
    },
  });
  const registry = new BuyerAccountRegistry(
    () => 'seller:caller',
    async () => ({
      success: true,
      status: 'completed',
      metadata: {},
      data: {
        accounts: [
          {
            brand: { domain: 'other.example' },
            operator: 'wppmedia.fr',
            account_id: 'acc-2',
            status: 'pending_approval',
            action: 'created',
          },
        ],
      },
    }),
    undefined,
    async () => {
      throw new Error('list_accounts unavailable');
    },
    { requests: { ...seller.requests, supported: async () => false } }
  );
  // A sync-path account pending approval, whose re-read will fail...
  await registry.ensure({ brand: { domain: 'other.example' }, operator: 'wppmedia.fr' }, { billing: 'operator' });
  // ...and an open request, through a registry option that now advertises account.requests.
  const requestRegistry = registry;
  requestRegistry['registryOptions'].requests.supported = async () => true;
  assert.equal((await requestRegistry.ensure(KEY, { billing: 'operator' })).kind, 'pending');
  seller.state = wireRequest('resolved', { account_id: 'acc-renault' });
  const moved = await requestRegistry.refresh();
  assert.deepEqual(
    moved.map(item => [item.kind, item.account_id]),
    [['ready', 'acc-renault']]
  );
  assert.equal((await requestRegistry.pending()).length, 1, 'the account that failed to re-read stays pending');
});

describe('ensure on the sync_accounts path returns the same outcome type', () => {
  function syncRegistry(row, repair) {
    return new BuyerAccountRegistry(
      () => 'seller:caller',
      async () => ({ success: true, status: 'completed', metadata: {}, data: { accounts: [{ ...KEY, ...row }] } }),
      undefined,
      repair
    );
  }

  test('an active account is ready', async () => {
    const outcome = await syncRegistry({ account_id: 'acc-1', status: 'active', action: 'created' }).ensure(KEY, {
      billing: 'operator',
    });
    assert.deepEqual(outcome, { kind: 'ready', account_id: 'acc-1', status: 'active', via: 'sync_accounts' });
  });

  test('pending_approval with setup is a pending value carrying the human action', async () => {
    let listed = 'pending_approval';
    const registry = syncRegistry(
      {
        account_id: 'acc-1',
        status: 'pending_approval',
        action: 'created',
        setup: {
          url: 'https://seller.example/onboard',
          message: 'Complete onboarding',
          waiting_on: 'buyer',
          kind: 'sign_up',
        },
      },
      async () => [{ ...KEY, account_id: 'acc-1', status: listed }]
    );
    const outcome = await registry.ensure(KEY, { billing: 'operator' });
    assert.equal(outcome.kind, 'pending');
    assert.equal(outcome.via, 'sync_accounts');
    assert.equal(outcome.account_id, 'acc-1');
    assert.equal(outcome.action.url, 'https://seller.example/onboard');
    assert.equal(nextStep(outcome), 'send_human_to_url');
    assert.equal((await registry.pending())[0].action.kind, 'sign_up');
    listed = 'active';
    const moved = await registry.refresh();
    assert.deepEqual(
      moved.map(item => [item.kind, item.account_id, item.status]),
      [['ready', 'acc-1', 'active']]
    );
  });

  test('a failed row is a rejected value, not an exception', async () => {
    const outcome = await syncRegistry({
      action: 'failed',
      errors: [{ code: 'ACCOUNT_REJECTED', message: 'Brand not eligible' }],
    }).ensure(KEY, { billing: 'operator' });
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.via, 'sync_accounts');
    assert.equal(outcome.errors[0].message, 'Brand not eligible');
  });

  test('provision keeps the pre-3.3 ProvisionedAccount return', async () => {
    const entry = await syncRegistry({ account_id: 'acc-1', status: 'active', action: 'created' }).provision(KEY);
    assert.equal(entry.status, 'active');
    assert.deepEqual(entry.account, KEY);
  });
});

test('capabilities expose account.requests support', () => {
  const caps = parseCapabilitiesResponse({
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    account: {
      supported_billing: ['operator'],
      requests: { supported: true, request_task: 'request_account', read_task: 'list_accounts' },
    },
  });
  assert.equal(caps.account.requestsSupported, true);
  const without = parseCapabilitiesResponse({
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    account: { supported_billing: ['operator'] },
  });
  assert.equal(without.account.requestsSupported, undefined);
});
