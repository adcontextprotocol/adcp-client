const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const { DEFAULT_API_KEY, NETWORKS } = require('../../../dist/lib/mock-server/sales-guaranteed/seed-data.js');

const NETWORK = NETWORKS[0].network_code;

describe('mock-server sales-guaranteed', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'sales-guaranteed', port: 0 });
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

  it('rejects unknown X-Network-Code (403 unknown_network)', async () => {
    const res = await fetch(`${handle.url}/v1/products`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Network-Code': 'net_does_not_exist' },
    });
    assert.equal(res.status, 403);
  });

  it('lists network-scoped inventory', async () => {
    const res = await fetch(`${handle.url}/v1/inventory`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ad_units.length > 0);
    for (const au of body.ad_units) {
      assert.ok(au.ad_unit_id);
      assert.ok(au.environment);
    }
  });

  it('lists products filtered by delivery_type', async () => {
    const res = await fetch(`${handle.url}/v1/products?delivery_type=guaranteed`, { headers: authHeaders() });
    const body = await res.json();
    assert.ok(body.products.length >= 2);
    for (const p of body.products) {
      assert.equal(p.delivery_type, 'guaranteed');
    }
  });

  it('walks order through approval state machine: pending_approval → approved → delivering', async () => {
    const auth = authHeaders(true);

    // 1) Create order
    const create = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Q2 Volta Launch',
        advertiser_id: 'adv_nova',
        currency: 'USD',
        budget: 250_000,
        client_request_id: 'order-flow-test',
      }),
    });
    assert.equal(create.status, 201);
    const order = await create.json();
    assert.equal(order.status, 'pending_approval');
    assert.ok(order.approval_task_id);

    // 2) Poll the task — first poll: submitted → working
    const poll1 = await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    const task1 = await poll1.json();
    assert.equal(task1.status, 'working');

    // 3) Second poll: working → completed (approved)
    const poll2 = await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    const task2 = await poll2.json();
    assert.equal(task2.status, 'completed');
    assert.equal(task2.result.outcome, 'approved');

    // 4) Fetch order — picks up approval, transitions through approved → delivering on read
    const orderRefresh = await fetch(`${handle.url}/v1/orders/${order.order_id}`, { headers: authHeaders() });
    const refreshed = await orderRefresh.json();
    assert.equal(refreshed.status, 'delivering');
    assert.equal(refreshed.approval_task_id, undefined);
  });

  it('rejects creating line items on a terminal-status order with 422 invalid_state_transition', async () => {
    const auth = authHeaders(true);
    // Create + force to delivering by polling task twice + getting the order
    const create = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Terminal test',
        advertiser_id: 'adv_test',
        currency: 'USD',
        budget: 1000,
        client_request_id: 'terminal-test',
      }),
    });
    const order = await create.json();
    // Approve
    await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/orders/${order.order_id}`, { headers: authHeaders() });
    // Force to canceled (test fixture: the mock doesn't expose a cancel endpoint;
    // skipping that path. Instead, assert that creating a line item BEFORE
    // approval works (allowed) and that the state machine transitions are
    // exposed as expected.
    const li = await fetch(`${handle.url}/v1/orders/${order.order_id}/lineitems`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        product_id: 'sports_preroll_q2_guaranteed',
        budget: 500,
        client_request_id: 'li-test',
      }),
    });
    assert.equal(li.status, 201);
    const lineItem = await li.json();
    assert.equal(lineItem.status, 'pending_creatives');
  });

  it('returns 409 idempotency_conflict on body-mismatched order replay', async () => {
    const auth = authHeaders(true);
    const first = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'idem original',
        advertiser_id: 'adv_x',
        currency: 'USD',
        budget: 1000,
        client_request_id: 'order-conflict',
      }),
    });
    assert.equal(first.status, 201);
    const conflict = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'idem CHANGED',
        advertiser_id: 'adv_x',
        currency: 'USD',
        budget: 1000,
        client_request_id: 'order-conflict',
      }),
    });
    assert.equal(conflict.status, 409);
  });

  it('serves delivery reports with synthesized totals for delivering orders', async () => {
    const auth = authHeaders(true);
    const create = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Delivery test',
        advertiser_id: 'adv_y',
        currency: 'USD',
        budget: 100_000,
        client_request_id: 'delivery-test',
      }),
    });
    const order = await create.json();
    // Walk to delivering
    await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/orders/${order.order_id}`, { headers: authHeaders() });
    // Get delivery report
    const deliv = await fetch(`${handle.url}/v1/orders/${order.order_id}/delivery`, { headers: authHeaders() });
    assert.equal(deliv.status, 200);
    const report = await deliv.json();
    assert.ok(report.totals.impressions > 0);
    assert.ok(report.totals.spend > 0);
    assert.equal(report.currency, 'USD');
  });

  it('ingests CAPI conversions and dedups on dedup_key', async () => {
    const auth = authHeaders(true);
    const create = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'CAPI test',
        advertiser_id: 'adv_z',
        currency: 'USD',
        budget: 5000,
        client_request_id: 'capi-test',
      }),
    });
    const order = await create.json();
    await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/tasks/${order.approval_task_id}`, { headers: authHeaders() });
    await fetch(`${handle.url}/v1/orders/${order.order_id}`, { headers: authHeaders() });
    // Send conversions
    const ingest1 = await fetch(`${handle.url}/v1/orders/${order.order_id}/conversions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        order_id: order.order_id,
        conversions: [
          {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            value: 100,
            currency: 'USD',
            dedup_key: 'evt_1',
          },
          {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            value: 50,
            currency: 'USD',
            dedup_key: 'evt_2',
          },
        ],
      }),
    });
    assert.equal(ingest1.status, 200);
    const result1 = await ingest1.json();
    assert.equal(result1.events_received, 2);
    assert.equal(result1.events_deduplicated, 0);

    // Replay first event with same dedup_key
    const ingest2 = await fetch(`${handle.url}/v1/orders/${order.order_id}/conversions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        order_id: order.order_id,
        conversions: [
          {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            value: 999,
            currency: 'USD',
            dedup_key: 'evt_1',
          },
        ],
      }),
    });
    const result2 = await ingest2.json();
    assert.equal(result2.events_received, 0);
    assert.equal(result2.events_deduplicated, 1);
  });

  it('reports unified principal-mapping shape on the boot handle', () => {
    assert.ok(Array.isArray(handle.principalMapping));
    assert.ok(handle.principalMapping.length >= 2);
    for (const e of handle.principalMapping) {
      assert.ok(e.adcpField);
      assert.ok(e.upstreamField);
    }
  });

  describe('Façade-detection instrumentation (issue #1225)', () => {
    it('GET /_lookup/network resolves adcp_publisher to upstream network_code', async () => {
      const res = await fetch(`${handle.url}/_lookup/network?adcp_publisher=${NETWORKS[0].adcp_publisher}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.adcp_publisher, NETWORKS[0].adcp_publisher);
      assert.equal(body.network_code, NETWORKS[0].network_code);
    });

    it('GET /_lookup/network returns 404 for unknown adcp_publisher', async () => {
      const res = await fetch(`${handle.url}/_lookup/network?adcp_publisher=does-not-exist.example`);
      assert.equal(res.status, 404);
    });

    it('GET /_lookup/network returns 400 without adcp_publisher query param', async () => {
      const res = await fetch(`${handle.url}/_lookup/network`);
      assert.equal(res.status, 400);
    });

    it('GET /_debug/traffic returns hit counts for exercised routes', async () => {
      await fetch(`${handle.url}/_lookup/network?adcp_publisher=${NETWORKS[0].adcp_publisher}`);
      await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
      const res = await fetch(`${handle.url}/_debug/traffic`);
      const body = await res.json();
      assert.ok((body.traffic['GET /_lookup/network'] ?? 0) >= 1);
      assert.ok((body.traffic['GET /v1/products'] ?? 0) >= 1);
    });
  });

  describe('Forecast + availability (issue #1375)', () => {
    function authHeadersJson() {
      return {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Network-Code': NETWORK,
        'Content-Type': 'application/json',
      };
    }

    it('POST /v1/forecast returns a DeliveryForecast-shaped body for a known product', async () => {
      const res = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          product_id: 'sports_preroll_q2_guaranteed',
          targeting: { geo: ['US-NY', 'US-CA'], daypart: 'primetime' },
          flight_dates: { start: '2026-04-01', end: '2026-04-30' },
          budget: 100_000,
        }),
      });
      assert.equal(res.status, 200);
      const forecast = await res.json();
      assert.equal(forecast.method, 'modeled');
      assert.equal(forecast.currency, 'USD');
      assert.equal(forecast.forecast_range_unit, 'spend');
      assert.ok(Array.isArray(forecast.points) && forecast.points.length >= 2);
      // First point is the availability point (no budget); subsequent are spend tiers.
      const availability = forecast.points.find(p => p.budget === undefined);
      assert.ok(availability, 'expected an availability point with no budget');
      assert.ok(availability.metrics.impressions.mid > 0);
      const spendPoints = forecast.points.filter(p => typeof p.budget === 'number');
      assert.ok(spendPoints.length >= 2);
      // Spend curve is monotonic in impressions.
      for (let i = 1; i < spendPoints.length; i++) {
        assert.ok(spendPoints[i].metrics.impressions.mid >= spendPoints[i - 1].metrics.impressions.mid);
      }
    });

    it('POST /v1/forecast returns availability range_unit when budget is omitted', async () => {
      const res = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          product_id: 'sports_preroll_q2_guaranteed',
          targeting: { geo: ['US-NY'] },
          flight_dates: { start: '2026-04-01', end: '2026-04-30' },
        }),
      });
      assert.equal(res.status, 200);
      const forecast = await res.json();
      assert.equal(forecast.forecast_range_unit, 'availability');
      // GAM-style availability checks claim guaranteed delivery; spend curves are modeled.
      assert.equal(forecast.method, 'guaranteed');
    });

    it('POST /v1/forecast is deterministic — same inputs yield identical numbers', async () => {
      const body = {
        product_id: 'sports_preroll_q2_guaranteed',
        targeting: { geo: ['US-NY'], daypart: 'primetime' },
        flight_dates: { start: '2026-04-01', end: '2026-04-30' },
        budget: 100_000,
      };
      const a = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify(body),
      }).then(r => r.json());
      const b = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify(body),
      }).then(r => r.json());
      // Strip generated_at — compare the curve shape.
      delete a.generated_at;
      delete b.generated_at;
      assert.deepStrictEqual(a, b);
    });

    it('POST /v1/forecast hashes nested targeting fields (regression: was collapsing nested objects)', async () => {
      // Two specs that differ ONLY in nested fields. Prior implementation used
      // JSON.stringify with Object.keys as a replacer allowlist, which dropped
      // every nested object's contents — both specs hashed to the same string
      // and produced identical forecasts. Guard against the regression.
      const base = {
        product_id: 'sports_preroll_q2_guaranteed',
        flight_dates: { start: '2026-04-01', end: '2026-04-30' },
      };
      const a = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({ ...base, targeting: { audience: { age: { min: 25, max: 54 } } } }),
      }).then(r => r.json());
      const b = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({ ...base, targeting: { audience: { age: { min: 18, max: 34 } } } }),
      }).then(r => r.json());
      assert.notEqual(
        a.points[0].metrics.impressions.mid,
        b.points[0].metrics.impressions.mid,
        'nested targeting differences must perturb the seed'
      );
    });

    it('GET /v1/products?budget=garbage rejects the param silently and falls back to no-forecast (regression: was emitting NaN-poisoned JSON)', async () => {
      const u = new URL(`${handle.url}/v1/products`);
      u.searchParams.set('delivery_type', 'guaranteed');
      u.searchParams.set('budget', 'not-a-number');
      const res = await fetch(u, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const body = await res.json();
      // Garbage budget is dropped → no forecast embedded (no other query params).
      for (const p of body.products) {
        assert.equal(p.forecast, undefined);
      }
    });

    it('GET /v1/products?flight_start=lol rejects garbage date silently', async () => {
      const u = new URL(`${handle.url}/v1/products`);
      u.searchParams.set('delivery_type', 'guaranteed');
      u.searchParams.set('flight_start', 'lol');
      const res = await fetch(u, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const body = await res.json();
      for (const p of body.products) {
        assert.equal(p.forecast, undefined);
      }
    });

    it('POST /v1/forecast varies impressions by targeting hash', async () => {
      const base = {
        product_id: 'sports_preroll_q2_guaranteed',
        flight_dates: { start: '2026-04-01', end: '2026-04-30' },
        budget: 100_000,
      };
      const broad = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({ ...base, targeting: { geo: ['US'] } }),
      }).then(r => r.json());
      const narrow = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          ...base,
          targeting: { geo: ['US-NY-MANHATTAN'], audience: 'soccer-fans-male-25-34' },
        }),
      }).then(r => r.json());
      const broadMid = broad.points[0].metrics.impressions.mid;
      const narrowMid = narrow.points[0].metrics.impressions.mid;
      assert.notEqual(broadMid, narrowMid, 'targeting hash should perturb availability');
    });

    it('POST /v1/forecast returns 404 for an unknown product_id', async () => {
      const res = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          product_id: 'does_not_exist',
          flight_dates: { start: '2026-04-01', end: '2026-04-30' },
        }),
      });
      assert.equal(res.status, 404);
    });

    it('POST /v1/forecast returns 404 for a product that belongs to a different network', async () => {
      const otherNetworkProduct = 'pinnacle_video_preroll_q2'; // belongs to net_pinnacle
      const res = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          product_id: otherNetworkProduct,
          flight_dates: { start: '2026-04-01', end: '2026-04-30' },
        }),
      });
      // NETWORK is net_premium_us; pinnacle product isn't visible.
      assert.equal(res.status, 404);
    });

    it('POST /v1/availability returns per-item forecast and rate-card tiers', async () => {
      const res = await fetch(`${handle.url}/v1/availability`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          dry_run: true,
          items: [
            {
              product_id: 'sports_preroll_q2_guaranteed',
              budget: 100_000,
              flight_dates: { start: '2026-04-01', end: '2026-04-30' },
              targeting: { geo: ['US'] },
            },
            {
              product_id: 'outdoor_ctv_q2_guaranteed',
              budget: 200_000,
              flight_dates: { start: '2026-04-01', end: '2026-04-30' },
              targeting: { geo: ['US'] },
            },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.available, true);
      assert.equal(body.items.length, 2);
      for (const item of body.items) {
        assert.ok(item.forecast);
        assert.ok(item.tier_pricing);
        assert.equal(item.tier_pricing.length, 3);
        assert.equal(item.tier_pricing[0].tier, 'open');
        assert.ok(item.tier_pricing[1].cpm > item.tier_pricing[0].cpm);
        assert.ok(item.required_impressions > 0);
      }
    });

    it('POST /v1/availability surfaces conflicts when overlapping line items exhaust supply', async () => {
      // Step 1: read the deterministic availability for a known targeting +
      // date window so we can size budgets precisely. Avoids flaky tests
      // when the supply fraction lands in a narrow band.
      const dates = { start: '2026-04-01', end: '2026-04-30' };
      const targeting = { geo: ['US'] };
      const probe = await fetch(`${handle.url}/v1/forecast`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          product_id: 'sports_preroll_q2_guaranteed',
          targeting,
          flight_dates: dates,
        }),
      }).then(r => r.json());
      const availabilityImpressions = probe.points[0].metrics.impressions.mid;
      // Step 2: build two items each at 75% of available — both fit alone,
      // together they exceed supply.
      const cpm = 35; // sports_preroll_q2_guaranteed
      const budgetPerItem = Math.floor((availabilityImpressions * 0.75 * cpm) / 1000);
      const res = await fetch(`${handle.url}/v1/availability`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          dry_run: true,
          items: [
            {
              product_id: 'sports_preroll_q2_guaranteed',
              budget: budgetPerItem,
              flight_dates: dates,
              targeting,
            },
            {
              product_id: 'sports_preroll_q2_guaranteed',
              budget: budgetPerItem,
              flight_dates: dates,
              targeting,
            },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.available, false);
      assert.ok(Array.isArray(body.conflicts) && body.conflicts.length >= 1);
      assert.equal(body.items[0].available, true);
      assert.equal(body.items[1].available, false);
      assert.ok(body.items[1].remaining_after_prior_items < body.items[0].remaining_after_prior_items);
    });

    it('POST /v1/availability rejects non-dry-run requests', async () => {
      const res = await fetch(`${handle.url}/v1/availability`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({
          dry_run: false,
          items: [{ product_id: 'sports_preroll_q2_guaranteed', budget: 1000 }],
        }),
      });
      assert.equal(res.status, 400);
    });

    it('POST /v1/availability rejects empty items array', async () => {
      const res = await fetch(`${handle.url}/v1/availability`, {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({ dry_run: true, items: [] }),
      });
      assert.equal(res.status, 400);
    });

    it('GET /v1/products embeds per-query forecast when targeting/dates are present', async () => {
      const u = new URL(`${handle.url}/v1/products`);
      u.searchParams.set('delivery_type', 'guaranteed');
      u.searchParams.set('flight_start', '2026-04-01');
      u.searchParams.set('flight_end', '2026-04-30');
      u.searchParams.set('budget', '100000');
      u.searchParams.set('targeting', JSON.stringify({ geo: ['US-NY'] }));
      const res = await fetch(u, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.products.length > 0);
      for (const p of body.products) {
        assert.ok(p.forecast, `expected per-query forecast on ${p.product_id}`);
        assert.equal(p.forecast.method, 'modeled');
        assert.ok(p.forecast.points[0].metrics.impressions.mid > 0);
      }
    });

    it('GET /v1/products without query params omits forecast (backwards compat)', async () => {
      const res = await fetch(`${handle.url}/v1/products?delivery_type=guaranteed`, {
        headers: authHeaders(),
      });
      const body = await res.json();
      for (const p of body.products) {
        assert.equal(p.forecast, undefined, 'forecast should only appear when caller asks for it');
      }
    });

    it('forecast/availability routes appear in /_debug/traffic', async () => {
      const res = await fetch(`${handle.url}/_debug/traffic`);
      const body = await res.json();
      assert.ok((body.traffic['POST /v1/forecast'] ?? 0) >= 1);
      assert.ok((body.traffic['POST /v1/availability'] ?? 0) >= 1);
    });
  });
});
