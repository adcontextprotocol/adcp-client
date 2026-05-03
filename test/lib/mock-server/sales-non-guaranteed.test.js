const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const { DEFAULT_API_KEY, NETWORKS } = require('../../../dist/lib/mock-server/sales-non-guaranteed/seed-data.js');

const NETWORK = NETWORKS[0].network_code; // net_remnant_us
const PUBLISHER = NETWORKS[0].adcp_publisher;

describe('mock-server sales-non-guaranteed', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'sales-non-guaranteed', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  function authHeaders(body = false) {
    const h = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'X-Network-Code': NETWORK,
    };
    if (body) h['Content-Type'] = 'application/json';
    return h;
  }

  it('boot handle reports static_bearer auth shape', () => {
    assert.equal(handle.auth.kind, 'static_bearer');
    assert.equal(handle.auth.apiKey, DEFAULT_API_KEY);
    assert.equal(handle.principalScope, 'X-Network-Code header (required on every request)');
  });

  it('lookup endpoint resolves AdCP publisher domain to network_code', async () => {
    const res = await fetch(`${handle.url}/_lookup/network?adcp_publisher=${encodeURIComponent(PUBLISHER)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network_code, NETWORK);
  });

  it('lookup endpoint 404s on unknown publisher', async () => {
    const res = await fetch(`${handle.url}/_lookup/network?adcp_publisher=unknown.example`);
    assert.equal(res.status, 404);
  });

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${handle.url}/v1/products`, {
      headers: { 'X-Network-Code': NETWORK },
    });
    assert.equal(res.status, 401);
  });

  it('rejects requests without X-Network-Code (403 network_required)', async () => {
    const res = await fetch(`${handle.url}/v1/products`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'network_required');
  });

  it('lists network-scoped products with floor pricing (no forecast when no query params)', async () => {
    const res = await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.products.length > 0);
    for (const p of body.products) {
      assert.equal(p.delivery_type, 'non_guaranteed');
      assert.ok(p.pricing.min_cpm > 0, `${p.product_id} must have a positive min_cpm`);
      assert.equal(p.forecast, undefined, 'no forecast embed when no query params');
    }
  });

  it('embeds per-query forecast on /v1/products when budget is supplied', async () => {
    const res = await fetch(`${handle.url}/v1/products?budget=10000&flight_start=2026-05-01&flight_end=2026-06-01`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const p of body.products) {
      assert.ok(p.forecast, `${p.product_id} should have inline forecast`);
      assert.equal(p.forecast.forecast_range_unit, 'spend');
      assert.equal(p.forecast.method, 'modeled');
    }
  });

  it('forecast endpoint returns spend-unit deterministic curve', async () => {
    const productId = 'display_medrec_remnant';
    const body = JSON.stringify({ product_id: productId, budget: 5000 });
    const r1 = await fetch(`${handle.url}/v1/forecast`, { method: 'POST', headers: authHeaders(true), body });
    const r2 = await fetch(`${handle.url}/v1/forecast`, { method: 'POST', headers: authHeaders(true), body });
    assert.equal(r1.status, 200);
    const f1 = await r1.json();
    const f2 = await r2.json();
    assert.equal(f1.forecast_range_unit, 'spend');
    assert.deepEqual(f1, f2, 'same input must produce identical forecast (deterministic)');
  });

  it('forecast adds min_budget_warning when budget < product min_spend', async () => {
    // ctv_15s_remnant has min_spend: 5000.
    const body = JSON.stringify({ product_id: 'ctv_15s_remnant', budget: 100 });
    const res = await fetch(`${handle.url}/v1/forecast`, { method: 'POST', headers: authHeaders(true), body });
    assert.equal(res.status, 200);
    const f = await res.json();
    assert.ok(f.min_budget_warning, 'min_budget_warning expected when budget below min_spend');
    assert.equal(f.min_budget_warning.required, 5000);
  });

  it('POST /v1/orders returns sync confirmed status (no HITL approval task)', async () => {
    const body = JSON.stringify({
      name: 'sync test order',
      advertiser_id: 'adv_test',
      budget: 5000,
      currency: 'USD',
      flight_start: '2026-05-01T00:00:00Z',
      flight_end: '2026-06-01T00:00:00Z',
      line_items: [{ product_id: 'display_medrec_remnant', budget: 5000 }],
    });
    const res = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body });
    assert.equal(res.status, 201);
    const order = await res.json();
    assert.equal(order.status, 'confirmed', 'sync auction-cleared confirmation, no pending_approval');
    assert.ok(order.order_id);
    assert.equal(order.approval_task_id, undefined, 'must not return an approval_task_id');
    assert.equal(order.line_items.length, 1);
  });

  it('POST /v1/orders rejects with budget_too_low when LI budget < product min_spend', async () => {
    const body = JSON.stringify({
      name: 'underbudget',
      advertiser_id: 'adv_test',
      budget: 500,
      currency: 'USD',
      // ctv_15s_remnant has min_spend: 5000; a 500 LI is below floor.
      line_items: [{ product_id: 'ctv_15s_remnant', budget: 500 }],
    });
    const res = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body });
    assert.equal(res.status, 400);
    const err = await res.json();
    assert.equal(err.code, 'budget_too_low');
    assert.equal(err.field, 'line_items[].budget');
  });

  it('idempotency: same client_request_id with same body replays', async () => {
    const reqBody = JSON.stringify({
      name: 'idempotent',
      advertiser_id: 'adv_test',
      budget: 1000,
      currency: 'USD',
      client_request_id: 'idemp-1',
      line_items: [],
    });
    const r1 = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body: reqBody });
    const r2 = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body: reqBody });
    const o1 = await r1.json();
    const o2 = await r2.json();
    assert.equal(o1.order_id, o2.order_id, 'same client_request_id must replay same order_id');
    assert.equal(o2.replayed, true, 'replay must surface replayed:true');
  });

  it('idempotency: same client_request_id with different body returns 409', async () => {
    const body1 = JSON.stringify({
      name: 'first',
      advertiser_id: 'adv_test',
      budget: 100,
      currency: 'USD',
      client_request_id: 'idemp-conflict',
      line_items: [],
    });
    const body2 = JSON.stringify({
      name: 'second',
      advertiser_id: 'adv_test',
      budget: 200, // different
      currency: 'USD',
      client_request_id: 'idemp-conflict',
      line_items: [],
    });
    const r1 = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body: body1 });
    assert.equal(r1.status, 201);
    const r2 = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body: body2 });
    assert.equal(r2.status, 409);
    const err = await r2.json();
    assert.equal(err.code, 'idempotency_conflict');
  });

  it('GET /v1/orders/{id}/delivery synthesizes budget × elapsed × pacing', async () => {
    // Create an order with flight in progress (started yesterday, ends in 30d) so elapsed is small but non-zero.
    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const body = JSON.stringify({
      name: 'delivery test',
      advertiser_id: 'adv_test',
      budget: 10000,
      currency: 'USD',
      pacing: 'even',
      flight_start: start,
      flight_end: end,
      line_items: [{ product_id: 'display_medrec_remnant', budget: 10000 }],
    });
    const r1 = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body });
    const order = await r1.json();
    const r2 = await fetch(`${handle.url}/v1/orders/${order.order_id}/delivery`, { headers: authHeaders() });
    assert.equal(r2.status, 200);
    const delivery = await r2.json();
    assert.equal(delivery.pacing, 'even');
    assert.ok(delivery.totals.impressions > 0, 'mid-flight order should have non-zero impressions');
    assert.ok(delivery.totals.spend > 0);
    assert.ok(delivery.totals.budget_remaining < 10000, 'some budget should be spent');
    assert.ok(delivery.totals.budget_remaining > 0, 'not all budget should be spent (still mid-flight)');
  });

  it('delivery curves differ by pacing mode (asap > even > front_loaded at early elapsed)', async () => {
    // Same flight at 10% elapsed (start 1d ago, end 9d from now).
    const start = new Date(Date.now() - 86_400_000).toISOString();
    const end = new Date(Date.now() + 9 * 86_400_000).toISOString();
    const mkBody = pacing =>
      JSON.stringify({
        name: `pacing-${pacing}`,
        advertiser_id: 'adv_test',
        budget: 10000,
        currency: 'USD',
        pacing,
        flight_start: start,
        flight_end: end,
        line_items: [{ product_id: 'display_medrec_remnant', budget: 10000 }],
      });
    const orders = {};
    for (const p of ['even', 'asap', 'front_loaded']) {
      const r = await fetch(`${handle.url}/v1/orders`, { method: 'POST', headers: authHeaders(true), body: mkBody(p) });
      orders[p] = (await r.json()).order_id;
    }
    const deliveries = {};
    for (const [p, id] of Object.entries(orders)) {
      const r = await fetch(`${handle.url}/v1/orders/${id}/delivery`, { headers: authHeaders() });
      deliveries[p] = (await r.json()).totals.spend;
    }
    // At 10% elapsed: asap = min(0.3, 1.0) = 0.3; front_loaded = sqrt(0.1) ≈ 0.316; even = 0.1.
    // Both front-loaded curves should outpace `even`. (asap-vs-front_loaded
    // crossover lands at t = 1/9 ≈ 0.111; we don't lock the order between
    // them since it depends on exact elapsed.)
    assert.ok(deliveries.asap > deliveries.even, `asap (${deliveries.asap}) should outpace even (${deliveries.even})`);
    assert.ok(
      deliveries.front_loaded > deliveries.even,
      `front_loaded (${deliveries.front_loaded}) should outpace even (${deliveries.even})`
    );
  });

  it('cross-network isolation: order from network A is 404 to network B', async () => {
    const orderRes = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({
        name: 'isolation test',
        advertiser_id: 'adv_test',
        budget: 100,
        currency: 'USD',
        line_items: [],
      }),
    });
    const order = await orderRes.json();
    // Same Bearer, different network header.
    const otherNetwork = NETWORKS.find(n => n.network_code !== NETWORK);
    if (!otherNetwork) {
      throw new Error('seed must have at least 2 networks');
    }
    const res = await fetch(`${handle.url}/v1/orders/${order.order_id}`, {
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Network-Code': otherNetwork.network_code,
      },
    });
    assert.equal(res.status, 404, "cross-network read must return 404, not the other tenant's order");
  });

  it('GET /_debug/traffic counts hits per route for façade detection', async () => {
    // Hit a few routes.
    await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/orders`, { headers: authHeaders() });
    const res = await fetch(`${handle.url}/_debug/traffic`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.traffic['GET /v1/products'] >= 1);
    assert.ok(body.traffic['GET /v1/orders'] >= 1);
  });
});
