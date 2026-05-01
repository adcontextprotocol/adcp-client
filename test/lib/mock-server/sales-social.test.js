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
});
