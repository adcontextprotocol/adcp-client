const { test } = require('node:test');
const assert = require('node:assert/strict');

let sequence = 0;

function nextOperationId(label) {
  sequence += 1;
  return `webhook-registration-contract-${label}-${sequence}`;
}

function registration(label, overrides = {}) {
  const createdAt = Date.now();
  const operationId = nextOperationId(label);
  return {
    agentId: 'seller-contract',
    agentUrl: 'https://seller.example/mcp',
    protocol: 'mcp',
    operationId,
    taskType: 'create_media_buy',
    callbackUrl: `https://buyer.example/webhooks/create_media_buy/${operationId}`,
    method: 'POST',
    mode: 'rfc9421',
    authorizationContextVersion: 1,
    delegatedOperatorAuthorization: {
      brand: 'brand_a',
      scope: 'media_buying',
      country: 'GB',
    },
    previewMode: 'canonical',
    requiresDurableSettlement: true,
    createdAt,
    expiresAt: createdAt + 60_000,
    ...overrides,
  };
}

async function createHarness(factory) {
  const value = await factory();
  const harness = value && value.store ? value : { store: value };
  assert.ok(harness.store, 'store factory must return a store or { store, expire } harness');
  for (const method of ['get', 'putIfAbsent', 'markRequiresDurableSettlement', 'delete']) {
    assert.equal(typeof harness.store[method], 'function', `contract store must implement ${method}()`);
  }
  return harness;
}

/**
 * Register the shared WebhookRegistrationStore behavioral contract.
 *
 * `factory` may return a store directly or `{ store, expire }`. An expiry hook
 * may alternatively be supplied as `options.expire`. Hooks receive
 * `{ store, registration }` and must make that exact row expired according to
 * the backend before returning. Backend-specific TTL and corruption behavior
 * belongs in each adapter's own tests.
 */
function runWebhookRegistrationStoreContract(name, factory, options = {}) {
  test(`${name}: full round-trip is immutable and store-owned`, async () => {
    const { store } = await createHarness(factory);
    const input = registration('roundtrip');
    const expected = structuredClone(input);

    await store.putIfAbsent(input);
    input.callbackUrl = 'https://mutated.example/webhook';
    input.delegatedOperatorAuthorization.brand = 'mutated_brand';

    const first = await store.get(expected.agentId, expected.operationId);
    assert.deepEqual(first, expected);
    assert.equal(Object.isFrozen(first), true, 'returned registration must be frozen');
    assert.equal(
      Object.isFrozen(first.delegatedOperatorAuthorization),
      true,
      'returned delegated authorization must be frozen'
    );

    const second = await store.get(expected.agentId, expected.operationId);
    assert.deepEqual(second, expected, 'reads must not reflect caller-owned input mutations');
  });

  test(`${name}: agent and operation identifiers form an exact composite identity`, async () => {
    const { store } = await createHarness(factory);
    const first = registration('identity-first', {
      agentId: 'seller',
      operationId: 'region:operation',
      callbackUrl: 'https://buyer.example/webhooks/identity-first',
    });
    const second = registration('identity-second', {
      agentId: 'seller:region',
      operationId: 'operation',
      callbackUrl: 'https://buyer.example/webhooks/identity-second',
    });
    const third = registration('identity-third', {
      agentId: first.agentId,
      operationId: 'region:operation:sibling',
      callbackUrl: 'https://buyer.example/webhooks/identity-third',
    });

    await Promise.all([store.putIfAbsent(first), store.putIfAbsent(second), store.putIfAbsent(third)]);
    assert.deepEqual(await store.get(first.agentId, first.operationId), first);
    assert.deepEqual(await store.get(second.agentId, second.operationId), second);
    assert.deepEqual(await store.get(third.agentId, third.operationId), third);
    assert.equal(await store.get(second.agentId, first.operationId), undefined);
    assert.equal(await store.get(first.agentId, second.operationId), undefined);
  });

  test(`${name}: identical provenance is idempotent without replacing timestamps or settlement state`, async () => {
    const { store } = await createHarness(factory);
    const first = registration('idempotent');
    await store.putIfAbsent(first);

    await store.putIfAbsent({
      ...first,
      requiresDurableSettlement: false,
      createdAt: first.createdAt + 1_000,
      expiresAt: first.expiresAt + 10_000,
    });

    assert.deepEqual(
      await store.get(first.agentId, first.operationId),
      first,
      'an identical retry must preserve the winning row, including timestamps and a true settlement marker'
    );
  });

  test(`${name}: every immutable provenance dimension conflicts without overwriting the winner`, async () => {
    const { store } = await createHarness(factory);
    const first = registration('conflicts');
    await store.putIfAbsent(first);

    const conflicts = [
      { agentUrl: 'https://other-seller.example/mcp' },
      { protocol: 'a2a' },
      { taskType: 'sync_creatives' },
      { callbackUrl: 'https://buyer.example/webhooks/substituted' },
      { method: 'GET' },
      { mode: 'hmac-sha256' },
      { previewMode: 'legacy' },
      { authorizationContextVersion: undefined, delegatedOperatorAuthorization: undefined },
      { delegatedOperatorAuthorization: { ...first.delegatedOperatorAuthorization, brand: 'brand_b' } },
    ];

    for (const conflict of conflicts) {
      await assert.rejects(() => store.putIfAbsent({ ...first, ...conflict }));
      assert.deepEqual(await store.get(first.agentId, first.operationId), first);
    }
  });

  test(`${name}: durable-settlement marking is monotonic, exact-keyed, and rejects missing rows`, async () => {
    const { store } = await createHarness(factory);
    const first = registration('mark');
    delete first.requiresDurableSettlement;
    const sibling = registration('mark-sibling', { requiresDurableSettlement: false });
    await Promise.all([store.putIfAbsent(first), store.putIfAbsent(sibling)]);

    await store.markRequiresDurableSettlement(first.agentId, first.operationId);
    await store.markRequiresDurableSettlement(first.agentId, first.operationId);
    await store.putIfAbsent(first);

    const marked = await store.get(first.agentId, first.operationId);
    assert.deepEqual(marked, { ...first, requiresDurableSettlement: true });
    assert.deepEqual(await store.get(sibling.agentId, sibling.operationId), sibling);
    await assert.rejects(() => store.markRequiresDurableSettlement(first.agentId, nextOperationId('missing-mark')));
  });

  test(`${name}: delete removes only the exact composite key`, async () => {
    const { store } = await createHarness(factory);
    const first = registration('delete-first', { agentId: 'seller-delete' });
    const sameOperationOtherAgent = registration('delete-other-agent', {
      agentId: 'seller-delete-other',
      operationId: first.operationId,
    });
    const sameAgentOtherOperation = registration('delete-other-operation', { agentId: first.agentId });
    await Promise.all([first, sameOperationOtherAgent, sameAgentOtherOperation].map(value => store.putIfAbsent(value)));

    await store.delete(first.agentId, first.operationId);
    assert.equal(await store.get(first.agentId, first.operationId), undefined);
    assert.deepEqual(
      await store.get(sameOperationOtherAgent.agentId, sameOperationOtherAgent.operationId),
      sameOperationOtherAgent
    );
    assert.deepEqual(
      await store.get(sameAgentOtherOperation.agentId, sameAgentOtherOperation.operationId),
      sameAgentOtherOperation
    );
    await store.delete(first.agentId, first.operationId);
  });

  test(`${name}: an expired key can be atomically replaced`, async context => {
    const harness = await createHarness(factory);
    const expire = options.expire ?? harness.expire;
    if (expire === undefined) {
      context.skip('expiry contract requires an expire hook');
      return;
    }
    assert.equal(typeof expire, 'function', 'expiry hook must be a function');
    const first = registration('expiry');
    await harness.store.putIfAbsent(first);
    await expire({ store: harness.store, registration: first });
    assert.equal(await harness.store.get(first.agentId, first.operationId), undefined);

    // A deterministic in-memory clock may have advanced to the first row's
    // expiry, so keep the replacement's own interval valid in either clock.
    const replacementCreatedAt = Math.max(Date.now(), first.expiresAt + 1);
    const replacement = {
      ...first,
      callbackUrl: 'https://buyer.example/webhooks/replacement',
      createdAt: replacementCreatedAt,
      expiresAt: replacementCreatedAt + 60_000,
    };
    await harness.store.putIfAbsent(replacement);
    assert.deepEqual(await harness.store.get(replacement.agentId, replacement.operationId), replacement);
  });

  test(`${name}: concurrent identical and conflicting creates have one immutable winner`, async () => {
    const identicalHarness = await createHarness(factory);
    const identical = registration('concurrent-identical');
    const identicalResults = await Promise.allSettled(
      Array.from({ length: 12 }, () => identicalHarness.store.putIfAbsent(structuredClone(identical)))
    );
    assert.ok(identicalResults.every(result => result.status === 'fulfilled'));
    assert.deepEqual(await identicalHarness.store.get(identical.agentId, identical.operationId), identical);

    const conflictHarness = await createHarness(factory);
    const base = registration('concurrent-conflict');
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      ...base,
      callbackUrl: `https://buyer.example/webhooks/concurrent-winner-${index}`,
    }));
    const conflictResults = await Promise.allSettled(
      candidates.map(candidate => conflictHarness.store.putIfAbsent(candidate))
    );
    const winners = conflictResults.flatMap((result, index) => (result.status === 'fulfilled' ? [index] : []));
    assert.equal(winners.length, 1, 'exactly one conflicting concurrent create must win');
    assert.deepEqual(
      await conflictHarness.store.get(base.agentId, base.operationId),
      candidates[winners[0]],
      'the stored row must be the complete winning candidate'
    );
  });
}

module.exports = { runWebhookRegistrationStoreContract };
