const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const { DEFAULT_API_KEY } = require('../../../dist/lib/mock-server/signal-marketplace/seed-data.js');

describe('mock-server signal-marketplace', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'signal-marketplace', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${handle.url}/v2/cohorts`, {
      headers: { 'X-Operator-Id': 'op_pinnacle' },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'unauthorized');
  });

  it('rejects requests without X-Operator-Id (403 operator_required)', async () => {
    const res = await fetch(`${handle.url}/v2/cohorts`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'operator_required');
  });

  it('rejects unknown operator (403 unknown_operator)', async () => {
    const res = await fetch(`${handle.url}/v2/cohorts`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_nonexistent' },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'unknown_operator');
  });

  it('returns operator-scoped cohorts', async () => {
    const pinnacleRes = await fetch(`${handle.url}/v2/cohorts`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_pinnacle' },
    });
    assert.equal(pinnacleRes.status, 200);
    const pinnacleBody = await pinnacleRes.json();
    assert.equal(pinnacleBody.cohorts.length, 4);

    const summitRes = await fetch(`${handle.url}/v2/cohorts`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_summit' },
    });
    assert.equal(summitRes.status, 200);
    const summitBody = await summitRes.json();
    assert.equal(summitBody.cohorts.length, 2);
    for (const c of summitBody.cohorts) {
      assert.equal(c.data_provider_domain, 'tridentauto.example');
    }
  });

  it('applies operator-specific pricing overrides', async () => {
    const evbCohortId = 'ckhsh_us_evb_2024q4_001';
    const pinnacleRes = await fetch(`${handle.url}/v2/cohorts/${evbCohortId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_pinnacle' },
    });
    const pinnacleCohort = await pinnacleRes.json();
    assert.equal(pinnacleCohort.pricing[0].cpm_amount, 3.5);
    assert.equal(pinnacleCohort.pricing[0].pricing_id, 'tier_default_evb_cpm');

    const summitRes = await fetch(`${handle.url}/v2/cohorts/${evbCohortId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_summit' },
    });
    const summitCohort = await summitRes.json();
    assert.equal(summitCohort.pricing[0].cpm_amount, 4.5);
    assert.equal(summitCohort.pricing[0].pricing_id, 'tier_summit_evb_cpm');
  });

  it('returns 403 cohort_not_visible when fetching a cohort outside operator scope', async () => {
    const meridianCohortId = 'ckhsh_us_cv_2024q4_003';
    const res = await fetch(`${handle.url}/v2/cohorts/${meridianCohortId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_summit' },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'cohort_not_visible');
  });

  it('creates and walks an activation through pending → in_progress → active', async () => {
    const cohortId = 'ckhsh_us_evb_2024q4_001';
    const destinationId = 'dest_ttd_main';
    const pricingId = 'tier_default_evb_cpm';

    const createRes = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Operator-Id': 'op_pinnacle',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cohort_id: cohortId,
        destination_id: destinationId,
        pricing_id: pricingId,
        client_request_id: 'test-create-1',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.status, 'pending');
    const activationId = created.activation_id;

    const replayRes = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Operator-Id': 'op_pinnacle',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cohort_id: cohortId,
        destination_id: destinationId,
        pricing_id: pricingId,
        client_request_id: 'test-create-1',
      }),
    });
    assert.equal(replayRes.status, 200);
    const replayed = await replayRes.json();
    assert.equal(replayed.activation_id, activationId);

    const poll1 = await fetch(`${handle.url}/v2/activations/${activationId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_pinnacle' },
    });
    assert.equal(poll1.status, 200);
    const polled1 = await poll1.json();
    assert.equal(polled1.status, 'in_progress');

    const poll2 = await fetch(`${handle.url}/v2/activations/${activationId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_pinnacle' },
    });
    const polled2 = await poll2.json();
    assert.equal(polled2.status, 'active');
    assert.ok(polled2.platform_segment_id);
    assert.ok(polled2.match_rate > 0);

    const crossRead = await fetch(`${handle.url}/v2/activations/${activationId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_summit' },
    });
    assert.equal(crossRead.status, 403);
  });

  it('returns synchronous active status for agent destinations', async () => {
    const createRes = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Operator-Id': 'op_pinnacle',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cohort_id: 'ckhsh_us_evb_2024q4_001',
        destination_id: 'dest_wonderstruck_agent',
        pricing_id: 'tier_default_evb_cpm',
        client_request_id: 'test-agent-1',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.status, 'active');
    assert.ok(created.agent_activation_key);
  });

  it('returns 409 idempotency_conflict when client_request_id is reused with a different body', async () => {
    // Real upstreams (Stripe, AdCP spec) require returning a conflict on
    // idempotency-key reuse with mismatched body. Silently returning the
    // original would hide adapter bugs that reuse a single client_request_id
    // across logically-distinct AdCP requests.
    const auth = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'X-Operator-Id': 'op_pinnacle',
      'Content-Type': 'application/json',
    };

    const first = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        cohort_id: 'ckhsh_us_evb_2024q4_001',
        destination_id: 'dest_ttd_main',
        pricing_id: 'tier_default_evb_cpm',
        client_request_id: 'idem-conflict-test',
      }),
    });
    assert.equal(first.status, 201);

    const conflict = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        cohort_id: 'ckhsh_us_pp_2024q4_002',
        destination_id: 'dest_ttd_main',
        pricing_id: 'tier_default_pp_cpm',
        client_request_id: 'idem-conflict-test',
      }),
    });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.code, 'idempotency_conflict');
  });

  it('rejects an invalid pricing_id with 400 invalid_pricing', async () => {
    const res = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Operator-Id': 'op_pinnacle',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cohort_id: 'ckhsh_us_evb_2024q4_001',
        destination_id: 'dest_ttd_main',
        pricing_id: 'tier_does_not_exist',
        client_request_id: 'invalid-pricing-test',
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_pricing');
  });

  it('rejects malformed JSON body with 400 invalid_json', async () => {
    const res = await fetch(`${handle.url}/v2/activations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'X-Operator-Id': 'op_pinnacle',
        'Content-Type': 'application/json',
      },
      body: '{ this is not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_json');
  });

  it('exposes data_provider_name on every cohort (required for AdCP signal_id.data_provider)', async () => {
    const res = await fetch(`${handle.url}/v2/cohorts`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Operator-Id': 'op_pinnacle' },
    });
    const body = await res.json();
    for (const cohort of body.cohorts) {
      assert.ok(
        typeof cohort.data_provider_name === 'string' && cohort.data_provider_name.length > 0,
        `cohort ${cohort.cohort_id} missing data_provider_name`
      );
    }
  });
});
