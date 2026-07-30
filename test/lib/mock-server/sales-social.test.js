const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const { OAUTH_CLIENTS, ADVERTISERS } = require('../../../dist/lib/mock-server/sales-social/seed-data.js');

const CLIENT_ID = OAUTH_CLIENTS[0].client_id;
const CLIENT_SECRET = OAUTH_CLIENTS[0].client_secret;
const ADV = ADVERTISERS[0].advertiser_id;

function sha256Hex(s) {
  return createHash('sha256').update(s.toLowerCase().trim()).digest('hex');
}

async function getAccessToken(handle) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(`${handle.url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (res.status !== 200) throw new Error(`token endpoint returned ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

describe('mock-server sales-social', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'sales-social', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  describe('OAuth handshake', () => {
    it('issues access + refresh tokens for valid client_credentials', async () => {
      const tokens = await getAccessToken(handle);
      assert.ok(tokens.access_token);
      assert.ok(tokens.refresh_token);
      assert.equal(tokens.token_type, 'bearer');
      assert.ok(tokens.expires_in > 0);
    });

    it('rejects bad client_secret with 400 invalid_client', async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: 'wrong',
      });
      const res = await fetch(`${handle.url}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.code, 'invalid_client');
    });

    it('refresh_token grant rotates the refresh token (old becomes invalid)', async () => {
      const original = await getAccessToken(handle);
      const refreshBody = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: original.refresh_token,
      });
      const refreshRes = await fetch(`${handle.url}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshBody.toString(),
      });
      assert.equal(refreshRes.status, 200);
      const rotated = await refreshRes.json();
      assert.notEqual(rotated.access_token, original.access_token);
      assert.notEqual(rotated.refresh_token, original.refresh_token);

      // Original refresh token no longer valid
      const replayRes = await fetch(`${handle.url}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshBody.toString(),
      });
      assert.equal(replayRes.status, 400);
      const replay = await replayRes.json();
      assert.equal(replay.code, 'invalid_grant');
    });

    it('boot handle reports oauth_client_credentials auth shape', () => {
      assert.equal(handle.auth.kind, 'oauth_client_credentials');
      assert.equal(handle.auth.clientId, CLIENT_ID);
      assert.equal(handle.auth.clientSecret, CLIENT_SECRET);
      assert.equal(handle.auth.tokenPath, '/oauth/token');
    });
  });

  describe('Bearer authentication on API routes', () => {
    it('rejects API call without bearer with 401', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/info`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, 'unauthorized');
    });

    it('rejects API call with garbage bearer with 401', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/info`, {
        headers: { Authorization: 'Bearer not_a_real_token' },
      });
      assert.equal(res.status, 401);
    });

    it('accepts API call with freshly-issued access token', async () => {
      const { access_token } = await getAccessToken(handle);
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/info`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      assert.equal(res.status, 200);
      const adv = await res.json();
      assert.equal(adv.advertiser_id, ADV);
    });

    it('returns 404 for advertiser not in OAuth client scope', async () => {
      const { access_token } = await getAccessToken(handle);
      const res = await fetch(`${handle.url}/v1.3/advertiser/adv_does_not_exist/info`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('Custom audience flow (sync_audiences mapping)', () => {
    let token;
    before(async () => {
      token = (await getAccessToken(handle)).access_token;
    });

    it('creates an audience and uploads hashed members', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const createRes = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: 'Outdoor Enthusiasts US',
          source_type: 'customer_file',
          client_request_id: 'audience-create-test',
        }),
      });
      assert.equal(createRes.status, 201);
      const audience = await createRes.json();
      assert.equal(audience.status, 'building');
      assert.equal(audience.member_count, 0);

      const hashedMembers = ['alice@example.com', 'bob@example.com', 'charlie@example.com'].map(sha256Hex);
      const uploadRes = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/upload`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          audience_id: audience.audience_id,
          identifier_type: 'hashed_email_sha256',
          members: hashedMembers,
        }),
      });
      assert.equal(uploadRes.status, 202);
      const uploadResult = await uploadRes.json();
      assert.equal(uploadResult.status, 'active');
      assert.equal(uploadResult.batch_size, 3);
    });

    it('rejects raw (unhashed) PII upload with 400 invalid_hash_format', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const createRes = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: 'raw pii test',
          source_type: 'customer_file',
          client_request_id: 'raw-pii-create-test',
        }),
      });
      const audience = await createRes.json();
      const uploadRes = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/upload`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          audience_id: audience.audience_id,
          identifier_type: 'hashed_email_sha256',
          members: ['alice@example.com', 'bob@example.com'], // NOT hashed
        }),
      });
      assert.equal(uploadRes.status, 400);
      const err = await uploadRes.json();
      assert.equal(err.code, 'invalid_hash_format');
    });

    it('returns 409 idempotency_conflict on body-mismatched replay', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const first = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: 'idem original',
          source_type: 'customer_file',
          client_request_id: 'audience-conflict-test',
        }),
      });
      assert.equal(first.status, 201);
      const conflict = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: 'idem CHANGED',
          source_type: 'customer_file',
          client_request_id: 'audience-conflict-test',
        }),
      });
      assert.equal(conflict.status, 409);
      const c = await conflict.json();
      assert.equal(c.code, 'idempotency_conflict');
    });
  });

  describe('Conversion API / events (log_event mapping)', () => {
    let token;
    let pixelId;
    before(async () => {
      token = (await getAccessToken(handle)).access_token;
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const px = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/pixel/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'capi-test', client_request_id: 'pixel-create-test' }),
      });
      pixelId = (await px.json()).pixel_id;
    });

    it('ingests events with hashed identifiers', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/event/track`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          pixel_id: pixelId,
          events: [
            {
              event_name: 'Purchase',
              event_id: 'evt_001',
              event_time: Math.floor(Date.now() / 1000),
              user_data: { email_sha256: sha256Hex('alice@example.com') },
              custom_data: { value: 49.99, currency: 'USD' },
            },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const result = await res.json();
      assert.equal(result.events_received, 1);
      assert.equal(result.events_dropped, 0);
    });

    it('drops events without a matchable identifier', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/event/track`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          pixel_id: pixelId,
          events: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              user_data: {
                /* no hashed identifiers */
              },
              custom_data: { value: 1 },
            },
          ],
        }),
      });
      assert.equal(res.status, 400);
      const err = await res.json();
      assert.equal(err.code, 'no_matchable_events');
    });

    it('returns 404 for unknown pixel_id', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/event/track`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          pixel_id: 'px_does_not_exist',
          events: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              user_data: { email_sha256: sha256Hex('alice@example.com') },
            },
          ],
        }),
      });
      assert.equal(res.status, 404);
    });
  });

  describe('Catalog and creative flows', () => {
    let token;
    before(async () => {
      token = (await getAccessToken(handle)).access_token;
    });

    it('creates a catalog and uploads items', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const catRes = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/catalog/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'outdoor-gear', vertical: 'retail', client_request_id: 'cat-test' }),
      });
      assert.equal(catRes.status, 201);
      const catalog = await catRes.json();
      const upload = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/catalog/upload`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          catalog_id: catalog.catalog_id,
          items: [
            {
              item_id: 'sku_001',
              title: 'Trail Pro Tent',
              link: 'https://example.test/p/sku_001',
              image_url: 'https://example.test/img/sku_001.jpg',
              availability: 'in_stock',
              price: '299.99 USD',
            },
          ],
        }),
      });
      assert.equal(upload.status, 202);
      const result = await upload.json();
      assert.equal(result.batch_size, 1);
    });

    it('uploads a native creative with status pending_review', async () => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/creative/create`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: 'trail-pro-spring',
          format_id: 'native_feed',
          primary_text: 'Built for the trail.',
          cta_label: 'Shop Now',
          landing_page_url: 'https://example.test/spring',
          media_url: 'https://example.test/media/trail-pro.jpg',
          client_request_id: 'creative-test',
        }),
      });
      assert.equal(res.status, 201);
      const creative = await res.json();
      assert.equal(creative.status, 'pending_review');
    });
  });

  it('reports unified principal-mapping shape on the boot handle', () => {
    assert.ok(Array.isArray(handle.principalMapping));
    assert.ok(handle.principalMapping.length >= 2);
    for (const entry of handle.principalMapping) {
      assert.ok(entry.adcpField);
      assert.ok(entry.upstreamField);
    }
    assert.ok(/path|advertiser/i.test(handle.principalScope));
  });

  describe('Planning surface — delivery_estimate + audience_reach + lookalike (issue #1378)', () => {
    let token;
    before(async () => {
      token = (await getAccessToken(handle)).access_token;
    });

    function authJson() {
      return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    }

    it('POST /delivery_estimate returns a forward forecast (spend → outcomes) when budget is provided', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          targeting: { geo: ['US'], age: { min: 25, max: 54 }, interests: ['outdoor'] },
          optimization_goal: 'conversions',
          budget: 50_000,
          flight_dates: { start: '2026-04-01', end: '2026-04-30' },
        }),
      });
      assert.equal(res.status, 200);
      const est = await res.json();
      assert.equal(est.optimization_goal, 'conversions');
      assert.equal(est.forecast_range_unit, 'spend');
      assert.equal(est.currency, ADVERTISERS[0].currency);
      assert.ok(est.estimated_daily_reach.min > 0);
      assert.ok(est.estimated_daily_reach.max >= est.estimated_daily_reach.min);
      assert.ok(est.estimated_cpm.median > 0);
      assert.ok(est.bid_recommendation.median > 0);
      assert.ok(Array.isArray(est.delivery_curve) && est.delivery_curve.length >= 3);
      // Curve is monotonic in budget for reach.
      for (let i = 1; i < est.delivery_curve.length; i++) {
        assert.ok(est.delivery_curve[i].daily_budget > est.delivery_curve[i - 1].daily_budget);
        assert.ok(
          est.delivery_curve[i].estimated_daily_reach.min >= est.delivery_curve[i - 1].estimated_daily_reach.min
        );
      }
    });

    it('POST /delivery_estimate returns reverse forecast (target → required_budget) when target_outcome is provided', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          targeting: { geo: ['US-CA'] },
          optimization_goal: 'conversions',
          target_outcome: 200,
        }),
      });
      assert.equal(res.status, 200);
      const est = await res.json();
      assert.equal(est.forecast_range_unit, 'conversions');
      assert.ok(est.required_budget);
      assert.ok(est.required_budget.min > 0);
      assert.ok(est.required_budget.max >= est.required_budget.min);
    });

    it('POST /delivery_estimate is deterministic — same inputs yield identical numbers', async () => {
      const body = {
        targeting: { geo: ['US'], age: { min: 18, max: 34 } },
        optimization_goal: 'reach',
        budget: 10_000,
        flight_dates: { start: '2026-05-01', end: '2026-05-31' },
      };
      const a = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify(body),
      }).then(r => r.json());
      const b = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify(body),
      }).then(r => r.json());
      delete a.generated_at;
      delete b.generated_at;
      assert.deepStrictEqual(a, b);
    });

    it('POST /delivery_estimate varies by targeting hash so input-sensitivity is observable', async () => {
      const body = targeting => ({
        targeting,
        optimization_goal: 'reach',
        budget: 5_000,
      });
      const broad = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify(body({ geo: ['US'] })),
      }).then(r => r.json());
      const narrow = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify(body({ geo: ['US-NY-MANHATTAN'], interests: ['ultra-marathon'] })),
      }).then(r => r.json());
      assert.notEqual(broad.estimated_daily_reach.max, narrow.estimated_daily_reach.max);
    });

    it('POST /delivery_estimate varies CPM band by optimization_goal', async () => {
      const reach = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'reach', budget: 10_000 }),
      }).then(r => r.json());
      const conversions = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'conversions', budget: 10_000 }),
      }).then(r => r.json());
      // Conversions optimization should be more expensive than reach optimization.
      assert.ok(conversions.estimated_cpm.median > reach.estimated_cpm.median);
    });

    it('POST /delivery_estimate rejects budget <= 0 (regression: was silently coerced to 1000)', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'reach', budget: 0 }),
      });
      assert.equal(res.status, 400);
    });

    it('POST /delivery_estimate rejects target_outcome <= 0', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'conversions', target_outcome: -5 }),
      });
      assert.equal(res.status, 400);
    });

    it('POST /delivery_estimate clamps below-floor budgets and emits min_budget_warning', async () => {
      // target_outcome small enough that derived budget < $40/day floor for conversions.
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          targeting: { geo: ['US'] },
          optimization_goal: 'conversions',
          target_outcome: 1, // 1 conversion/day → tiny derived budget
        }),
      });
      assert.equal(res.status, 200);
      const est = await res.json();
      assert.ok(est.min_budget_warning, 'expected min_budget_warning when derived budget below floor');
      assert.equal(est.min_budget_warning.floor, 40);
      // daily_budget_recommendation.min is hard-clamped to the floor.
      assert.ok(est.daily_budget_recommendation.min >= 40);
    });

    it('POST /delivery_estimate uses reach-curve inversion for reach-goal reverse forecast (not conversion math)', async () => {
      // Reverse forecast on reach goal should not derive budget from conversion rate;
      // should invert the saturating reach curve. Two different target reach values
      // should produce monotonically increasing required budgets.
      const small = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'reach', target_outcome: 100_000 }),
      }).then(r => r.json());
      const big = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'reach', target_outcome: 500_000 }),
      }).then(r => r.json());
      assert.ok(big.required_budget.min > small.required_budget.min);
      // Reach-goal reverse forecast classifies as 'conversions' range_unit (broadcast 'reach_freq' is broadcast-shaped).
      assert.equal(small.forecast_range_unit, 'conversions');
    });

    it('POST /delivery_estimate rejects when neither budget nor target_outcome is provided', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, optimization_goal: 'reach' }),
      });
      assert.equal(res.status, 400);
    });

    it('POST /delivery_estimate rejects without optimization_goal', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/delivery_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ targeting: { geo: ['US'] }, budget: 100 }),
      });
      assert.equal(res.status, 400);
    });

    it('POST /audience_reach_estimate returns audience size + matchable size', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience_reach_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          targeting: { geo: ['US-CA', 'US-OR', 'US-WA'], interests: ['hiking', 'outdoor'] },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.estimated_audience_size.min > 0);
      assert.ok(body.matchable_size_at_platform.max >= body.matchable_size_at_platform.min);
      assert.ok(body.matchable_size_at_platform.max <= body.estimated_audience_size.max);
      assert.ok(['narrow', 'specific', 'broad'].includes(body.reach_quality));
    });

    it('POST /audience_reach_estimate rejects without targeting object', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience_reach_estimate`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });

    it('POST /audience/{id}/lookalike returns size + ETA scaled by similarity_pct', async () => {
      // Create a seed audience first.
      const created = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          name: 'lookalike-seed',
          source_type: 'customer_file',
          client_request_id: 'lookalike-seed-create',
        }),
      });
      const seed = await created.json();

      const tight = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience/${seed.audience_id}/lookalike`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ similarity_pct: 1, country: 'US' }),
      }).then(r => r.json());
      const broad = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience/${seed.audience_id}/lookalike`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ similarity_pct: 10, country: 'US' }),
      }).then(r => r.json());
      assert.ok(broad.estimated_size.max > tight.estimated_size.max);
      assert.ok(tight.activation_eta_hours >= 4 && tight.activation_eta_hours <= 24);
    });

    it('POST /audience/{id}/lookalike clamps to country-population × similarity_pct (regression: large seeds used to overflow country pop)', async () => {
      // Mock seed audiences from the upload tests have member_count = batch size (small).
      // Use country=US (~260M adult internet pop). At similarity_pct=10, cap = 26M.
      // With our `Math.min(cap × 0.6, seedContribution)` formula, mock should never
      // emit estimated_size.max > cap.
      const created = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          name: 'lookalike-clamp-test',
          source_type: 'customer_file',
          client_request_id: 'lookalike-clamp',
        }),
      });
      const seed = await created.json();
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience/${seed.audience_id}/lookalike`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ similarity_pct: 10, country: 'US' }),
      });
      const body = await res.json();
      const usPop = 260_000_000;
      const cap = usPop * (10 / 100); // 26M
      assert.ok(
        body.estimated_size.max <= cap,
        `lookalike max (${body.estimated_size.max}) exceeded country cap (${cap})`
      );
    });

    it('POST /audience/{id}/lookalike returns 404 for unknown audience', async () => {
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience/aud_does_not_exist/lookalike`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ similarity_pct: 5, country: 'US' }),
      });
      assert.equal(res.status, 404);
    });

    it('POST /audience/{id}/lookalike rejects similarity_pct out of range', async () => {
      const created = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/custom_audience/create`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({
          name: 'lookalike-seed-range-test',
          source_type: 'customer_file',
          client_request_id: 'lookalike-range-create',
        }),
      });
      const seed = await created.json();
      const res = await fetch(`${handle.url}/v1.3/advertiser/${ADV}/audience/${seed.audience_id}/lookalike`, {
        method: 'POST',
        headers: authJson(),
        body: JSON.stringify({ similarity_pct: 50, country: 'US' }),
      });
      assert.equal(res.status, 400);
    });

    it('planning routes appear in /_debug/traffic', async () => {
      const res = await fetch(`${handle.url}/_debug/traffic`);
      const body = await res.json();
      assert.ok((body.traffic['POST /v1.3/advertiser/{id}/delivery_estimate'] ?? 0) >= 1);
      assert.ok((body.traffic['POST /v1.3/advertiser/{id}/audience_reach_estimate'] ?? 0) >= 1);
      assert.ok((body.traffic['POST /v1.3/advertiser/{id}/audience/{audience_id}/lookalike'] ?? 0) >= 1);
    });
  });
});
