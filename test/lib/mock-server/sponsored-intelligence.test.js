const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const {
  DEFAULT_API_KEY,
  BRANDS,
  OFFERINGS,
} = require('../../../dist/lib/mock-server/sponsored-intelligence/seed-data.js');

describe('mock-server sponsored-intelligence', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'sponsored-intelligence', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  const auth = () => ({ Authorization: `Bearer ${DEFAULT_API_KEY}`, 'Content-Type': 'application/json' });

  it('exposes the unified handle shape with brand mapping', () => {
    assert.equal(handle.auth.kind, 'static_bearer');
    assert.equal(handle.auth.apiKey, DEFAULT_API_KEY);
    assert.equal(handle.principalScope.includes('/v1/brands/'), true);
    assert.equal(handle.principalMapping.length, BRANDS.length);
    assert.equal(handle.principalMapping[0].adcpField, 'account.brand');
    assert.equal(handle.principalMapping[0].upstreamField.startsWith('path /v1/brands/'), true);
  });

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/offerings/off_acme_trailrun_summer26`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'unauthorized');
  });

  it('resolves AdCP brand identifier via /_lookup/brand (no auth)', async () => {
    const res = await fetch(`${handle.url}/_lookup/brand?adcp_brand=acmeoutdoor.example`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.brand_id, 'brand_acme_outdoor');
    assert.equal(body.display_name, 'Acme Outdoor');
  });

  it('returns 404 for unknown adcp_brand', async () => {
    const res = await fetch(`${handle.url}/_lookup/brand?adcp_brand=nope.example`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'brand_not_found');
  });

  it('rejects unknown brand_id with 404 brand_not_found', async () => {
    const res = await fetch(`${handle.url}/v1/brands/brand_does_not_exist/offerings/off_x`, {
      headers: auth(),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'brand_not_found');
  });

  it('returns offering with products when include_products=true', async () => {
    const res = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/offerings/off_acme_trailrun_summer26?include_products=true`,
      { headers: auth() }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.offering_id, 'off_acme_trailrun_summer26');
    assert.equal(body.available, true);
    assert.equal(Array.isArray(body.products), true);
    assert.equal(body.products.length >= 1, true);
    assert.equal(body.products[0].sku.startsWith('acme_tr_'), true);
    assert.equal(body.total_matching, OFFERINGS[0].products.length);
  });

  it('omits products when include_products is not set', async () => {
    const res = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/offerings/off_acme_trailrun_summer26`, {
      headers: auth(),
    });
    const body = await res.json();
    assert.equal(body.products.length, 0);
  });

  it('returns 404 offering_not_in_brand for cross-brand offering access', async () => {
    const res = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/offerings/off_summit_books_summer26`, {
      headers: auth(),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'offering_not_in_brand');
  });

  it('starts a conversation and returns initial assistant turn', async () => {
    const res = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'looking for trail running shoes for muddy terrain',
        offering_id: 'off_acme_trailrun_summer26',
        identity: { consent_granted: false },
        client_request_id: 'init-test-1',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(typeof body.conversation_id, 'string');
    assert.equal(body.status, 'active');
    assert.equal(body.brand_id, 'brand_acme_outdoor');
    assert.equal(body.turns.length, 1);
    assert.equal(typeof body.turns[0].assistant_message, 'string');
    assert.equal(body.session_ttl_seconds, 600);
  });

  it('replays the same conversation on identical client_request_id', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'idempotency replay test',
        offering_id: 'off_acme_trailrun_summer26',
        client_request_id: 'init-replay-1',
      }),
    });
    assert.equal(init.status, 201);
    const first = await init.json();

    const replay = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'idempotency replay test',
        offering_id: 'off_acme_trailrun_summer26',
        client_request_id: 'init-replay-1',
      }),
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.conversation_id, first.conversation_id);
  });

  it('routes "buy" keyword in turn message to a transaction handoff hint', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'shopping',
        offering_id: 'off_acme_trailrun_summer26',
        client_request_id: 'init-buy-test',
      }),
    });
    const conv = await init.json();

    const turn = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/turns`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        message: "I'd like to buy the black/green ones in size 10.",
        client_request_id: 'turn-buy-1',
      }),
    });
    assert.equal(turn.status, 200);
    const body = await turn.json();
    assert.equal(body.close_recommended.type, 'txn_ready');
    assert.equal(body.conversation_status, 'active');
  });

  it('rejects mismatched body on reused client_request_id with 409 idempotency_conflict', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'conflict test', client_request_id: 'init-conflict' }),
    });
    const conv = await init.json();

    await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/turns`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ message: 'first body', client_request_id: 'turn-conflict' }),
    });
    const conflict = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/turns`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ message: 'second body', client_request_id: 'turn-conflict' }),
      }
    );
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.code, 'idempotency_conflict');
  });

  it('closes conversation with reason=txn_ready and returns transaction_handoff', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'close test',
        offering_id: 'off_acme_trailrun_summer26',
        client_request_id: 'init-close',
      }),
    });
    const conv = await init.json();

    const close = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/close`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ reason: 'txn_ready', summary: 'User chose blackgreen-10.' }),
      }
    );
    assert.equal(close.status, 200);
    const body = await close.json();
    assert.equal(body.status, 'closed');
    assert.equal(body.close.reason, 'txn_ready');
    assert.ok(body.close.transaction_handoff);
    assert.equal(typeof body.close.transaction_handoff.checkout_url, 'string');
    assert.equal(typeof body.close.transaction_handoff.checkout_token, 'string');
    assert.equal(typeof body.close.transaction_handoff.expires_at, 'string');
  });

  it('rejects close with reason outside the upstream enum (loud rename gap with AdCP)', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'invalid reason test', client_request_id: 'init-invalid-reason' }),
    });
    const conv = await init.json();

    // 'handoff_transaction' is the AdCP value — adapter must translate to 'txn_ready'.
    const res = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/close`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ reason: 'handoff_transaction' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_close_reason');
  });

  it('close is idempotent on repeated calls (mirrors si_terminate_session having no idempotency_key)', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'idem close', client_request_id: 'init-idem-close' }),
    });
    const conv = await init.json();

    const first = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/close`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ reason: 'user_left' }),
      }
    );
    const firstBody = await first.json();
    const second = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/close`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ reason: 'host_closed' }),
      }
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.close.reason, 'user_left');
    assert.equal(secondBody.close.closed_at, firstBody.close.closed_at);
  });

  it('rejects new turns on a closed conversation with 409 conversation_closed', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'closed turn test', client_request_id: 'init-closed' }),
    });
    const conv = await init.json();
    await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/close`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ reason: 'user_left' }),
    });
    const turn = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/turns`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ message: 'hello?', client_request_id: 'turn-after-close' }),
    });
    assert.equal(turn.status, 409);
    const body = await turn.json();
    assert.equal(body.code, 'conversation_closed');
  });

  it('rejects POST /conversations replay with mismatched body (idempotency_conflict)', async () => {
    const first = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'first intent', client_request_id: 'init-mismatch' }),
    });
    assert.equal(first.status, 201);

    const conflict = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'second intent', client_request_id: 'init-mismatch' }),
    });
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.code, 'idempotency_conflict');
  });

  it('isolates conversations across brands (cross-brand 404)', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'cross-brand isolation', client_request_id: 'init-xbrand' }),
    });
    const conv = await init.json();

    // Same conversation_id under the other brand → 404, not leaked.
    const sneak = await fetch(`${handle.url}/v1/brands/brand_summit_books/conversations/${conv.conversation_id}`, {
      headers: auth(),
    });
    assert.equal(sneak.status, 404);
    const body = await sneak.json();
    assert.equal(body.code, 'conversation_not_found');
  });

  it('GET conversation after close still returns the closed payload', async () => {
    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ intent: 'get-after-close', client_request_id: 'init-get-after-close' }),
    });
    const conv = await init.json();

    await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}/close`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ reason: 'done' }),
    });

    const get = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations/${conv.conversation_id}`, {
      headers: auth(),
    });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.status, 'closed');
    assert.equal(body.close.reason, 'done');
    assert.equal(body.close.transaction_handoff, null);
  });

  it('round-trips offering_query_id from GET /offerings into POST /conversations (offering_token correlation)', async () => {
    const offeringRes = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/offerings/off_acme_trailrun_summer26?include_products=true`,
      { headers: auth() }
    );
    const offering = await offeringRes.json();
    assert.equal(typeof offering.offering_query_id, 'string');
    assert.equal(offering.offering_query_id.startsWith('oqt_'), true);

    const init = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'follow up on shown products',
        offering_query_id: offering.offering_query_id,
        client_request_id: 'init-token-roundtrip',
      }),
    });
    assert.equal(init.status, 201);
    const conv = await init.json();
    assert.equal(conv.offering_query_id, offering.offering_query_id);
    assert.equal(conv.offering_id, 'off_acme_trailrun_summer26');
    assert.deepEqual(
      conv.shown_product_skus,
      offering.products.map(p => p.sku)
    );
  });

  it('rejects unknown offering_query_id with 404 offering_query_not_found', async () => {
    const res = await fetch(`${handle.url}/v1/brands/brand_acme_outdoor/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'bad token',
        offering_query_id: 'oqt_does_not_exist',
        client_request_id: 'init-bad-token',
      }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'offering_query_not_found');
  });

  it('rejects offering_query_id from a different brand', async () => {
    const offRes = await fetch(
      `${handle.url}/v1/brands/brand_acme_outdoor/offerings/off_acme_trailrun_summer26?include_products=true`,
      { headers: auth() }
    );
    const off = await offRes.json();

    const sneak = await fetch(`${handle.url}/v1/brands/brand_summit_books/conversations`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        intent: 'wrong brand for token',
        offering_query_id: off.offering_query_id,
        client_request_id: 'init-token-wrong-brand',
      }),
    });
    assert.equal(sneak.status, 404);
    const body = await sneak.json();
    assert.equal(body.code, 'offering_query_not_in_brand');
  });

  it('records traffic counters for façade detection', async () => {
    const res = await fetch(`${handle.url}/_debug/traffic`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.traffic['POST /v1/brands/{brand}/conversations'] > 0);
    assert.ok(body.traffic['POST /v1/brands/{brand}/conversations/{id}/turns'] > 0);
    assert.ok(body.traffic['POST /v1/brands/{brand}/conversations/{id}/close'] > 0);
    assert.ok(body.traffic['GET /v1/brands/{brand}/offerings/{id}'] > 0);
  });
});
