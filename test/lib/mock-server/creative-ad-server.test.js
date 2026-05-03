const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const {
  DEFAULT_API_KEY,
  NETWORKS,
  FORMATS,
  CREATIVES,
} = require('../../../dist/lib/mock-server/creative-ad-server/seed-data.js');

const NETWORK = NETWORKS[0].network_code; // net_creative_us
const PUBLISHER = NETWORKS[0].adcp_publisher;
const ACME_NETWORK = NETWORKS[1].network_code; // net_acmeoutdoor — has seed creatives

describe('mock-server creative-ad-server', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'creative-ad-server', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  const authHeaders = (network = NETWORK, body = false) => {
    const h = { Authorization: `Bearer ${DEFAULT_API_KEY}`, 'X-Network-Code': network };
    if (body) h['Content-Type'] = 'application/json';
    return h;
  };

  it('boot handle reports static_bearer auth + correct principal scope', () => {
    assert.equal(handle.auth.kind, 'static_bearer');
    assert.equal(handle.auth.apiKey, DEFAULT_API_KEY);
    assert.equal(handle.principalScope, 'X-Network-Code header (required on every request)');
    assert.ok(handle.principalMapping.length >= 3);
  });

  it('rejects requests without bearer (401) or without X-Network-Code (403)', async () => {
    const noBearer = await fetch(`${handle.url}/v1/formats`, { headers: { 'X-Network-Code': NETWORK } });
    assert.equal(noBearer.status, 401);
    const noNetwork = await fetch(`${handle.url}/v1/formats`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(noNetwork.status, 403);
  });

  it('GET /_lookup/network resolves AdCP publisher → network_code', async () => {
    const res = await fetch(`${handle.url}/_lookup/network?adcp_publisher=${encodeURIComponent(PUBLISHER)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network_code, NETWORK);
  });

  it('POST /v1/creatives writes to library; format_id auto-detected from upload_mime', async () => {
    const res = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(NETWORK, true),
      body: JSON.stringify({
        name: 'Auto-detect 300x250',
        advertiser_id: 'adv_test',
        upload_mime: 'image/jpeg',
        width: 300,
        height: 250,
        click_url: 'https://example.com/x',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.format_id, 'display_300x250');
    assert.equal(body.advertiser_id, 'adv_test');
    assert.match(body.creative_id, /^cr_/);
  });

  it('POST /v1/creatives 422s when format auto-detection fails', async () => {
    const res = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(NETWORK, true),
      body: JSON.stringify({
        name: 'Unknown mime',
        advertiser_id: 'adv_test',
        upload_mime: 'application/x-unknown',
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, 'format_auto_detect_failed');
  });

  it('POST /v1/creatives 400s when neither format_id nor upload_mime supplied', async () => {
    const res = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(NETWORK, true),
      body: JSON.stringify({ name: 'No format hint', advertiser_id: 'adv_test' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /v1/creatives is idempotent on client_request_id; conflicts on body change', async () => {
    const requestId = `cr-test-${Date.now()}`;
    const body1 = {
      name: 'Idempotent A',
      advertiser_id: 'adv_test',
      format_id: 'display_300x250',
      client_request_id: requestId,
    };
    const r1 = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(NETWORK, true),
      body: JSON.stringify(body1),
    });
    assert.equal(r1.status, 201);
    const created = await r1.json();
    const r2 = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(NETWORK, true),
      body: JSON.stringify(body1),
    });
    assert.equal(r2.status, 200);
    const replayed = await r2.json();
    assert.equal(replayed.creative_id, created.creative_id);
    assert.equal(replayed.replayed, true);

    const r3 = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(NETWORK, true),
      body: JSON.stringify({ ...body1, name: 'Idempotent A (mutated)' }),
    });
    assert.equal(r3.status, 409);
  });

  it('GET /v1/creatives lists library entries; filters by advertiser/format/status', async () => {
    // ACME network has 2 seed creatives, both adv_acmeoutdoor.
    const all = await fetch(`${handle.url}/v1/creatives`, { headers: authHeaders(ACME_NETWORK) });
    const allBody = await all.json();
    assert.ok(Array.isArray(allBody.creatives));
    assert.ok(allBody.creatives.length >= 2);

    const filtered = await fetch(`${handle.url}/v1/creatives?format_id=display_300x250`, {
      headers: authHeaders(ACME_NETWORK),
    });
    const fBody = await filtered.json();
    assert.ok(fBody.creatives.every(c => c.format_id === 'display_300x250'));

    const byAdv = await fetch(`${handle.url}/v1/creatives?advertiser_id=adv_acmeoutdoor`, {
      headers: authHeaders(ACME_NETWORK),
    });
    const advBody = await byAdv.json();
    assert.ok(advBody.creatives.every(c => c.advertiser_id === 'adv_acmeoutdoor'));
  });

  it('GET /v1/creatives respects creative_ids filter (multi-id pass-through)', async () => {
    const seedIds = CREATIVES.filter(c => c.network_code === ACME_NETWORK).map(c => c.creative_id);
    const res = await fetch(`${handle.url}/v1/creatives?creative_ids=${seedIds.join(',')}`, {
      headers: authHeaders(ACME_NETWORK),
    });
    const body = await res.json();
    assert.equal(body.creatives.length, seedIds.length);
  });

  it('cross-network isolation — ACME creatives not visible from US network', async () => {
    const res = await fetch(`${handle.url}/v1/creatives`, { headers: authHeaders(NETWORK) });
    const body = await res.json();
    // Seed creatives belong to ACME / Pinnacle — none on US network.
    assert.ok(body.creatives.every(c => c.network_code === NETWORK || c.network_code === undefined));
  });

  it('POST /v1/creatives/{id}/render substitutes macros into format template', async () => {
    // Create a fresh creative without an explicit snippet so the format's
    // template is used at render time — that's where the macros live.
    const create = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(ACME_NETWORK, true),
      body: JSON.stringify({
        name: 'Render macro test',
        advertiser_id: 'adv_render_test',
        format_id: 'display_300x250',
      }),
    });
    const created = await create.json();
    const res = await fetch(`${handle.url}/v1/creatives/${created.creative_id}/render`, {
      method: 'POST',
      headers: authHeaders(ACME_NETWORK, true),
      body: JSON.stringify({
        context: {
          click_url: 'https://buyer.example/click?x=1',
          impression_pixel: 'https://buyer.example/imp?cr=ABC',
          cb: '12345',
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.tag_html, /https:\/\/buyer\.example\/click/);
    assert.match(body.tag_html, /https:\/\/buyer\.example\/imp/);
    assert.ok(body.tag_url.includes(`/serve/${created.creative_id}`));
  });

  it('GET /serve/{id} returns real iframe-embeddable HTML (no auth required)', async () => {
    const create = await fetch(`${handle.url}/v1/creatives`, {
      method: 'POST',
      headers: authHeaders(ACME_NETWORK, true),
      body: JSON.stringify({
        name: 'Serve test',
        advertiser_id: 'adv_serve_test',
        format_id: 'display_728x90',
      }),
    });
    const created = await create.json();
    const ctx = encodeURIComponent(JSON.stringify({ click_url: 'https://buyer.example/c' }));
    const res = await fetch(`${handle.url}/serve/${created.creative_id}?ctx=${ctx}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    const html = await res.text();
    assert.match(html, /<!doctype html>/);
    assert.match(html, /https:\/\/buyer\.example\/c/);
  });

  it('GET /v1/creatives/{id}/delivery returns CTR-baseline-scaled metrics', async () => {
    const seedDisplay = CREATIVES.find(c => c.format_id === 'display_300x250');
    const seedVideo = CREATIVES.find(c => c.format_id === 'video_30s');
    assert.ok(seedDisplay && seedVideo);
    const start = '2026-04-01T00:00:00Z';
    const end = '2026-04-08T00:00:00Z';
    const dRes = await fetch(
      `${handle.url}/v1/creatives/${seedDisplay.creative_id}/delivery?start=${start}&end=${end}`,
      { headers: authHeaders(seedDisplay.network_code) }
    );
    const dBody = await dRes.json();
    const vRes = await fetch(`${handle.url}/v1/creatives/${seedVideo.creative_id}/delivery?start=${start}&end=${end}`, {
      headers: authHeaders(seedVideo.network_code),
    });
    const vBody = await vRes.json();
    // Display CTR ~0.10%, video CTR ~1.5% — ratio ≥ 10x
    assert.ok(dBody.totals.ctr < 0.005, `display CTR should be < 0.5%, got ${dBody.totals.ctr}`);
    assert.ok(vBody.totals.ctr > 0.01, `video CTR should be > 1%, got ${vBody.totals.ctr}`);
    assert.ok(dBody.breakdown.length === 7);
    assert.ok(dBody.totals.impressions > 0);
  });

  it('PATCH /v1/creatives/{id} mutates snippet/status/click_url', async () => {
    const seed = CREATIVES.find(c => c.network_code === ACME_NETWORK);
    assert.ok(seed);
    const res = await fetch(`${handle.url}/v1/creatives/${seed.creative_id}`, {
      method: 'PATCH',
      headers: authHeaders(ACME_NETWORK, true),
      body: JSON.stringify({ status: 'paused' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'paused');
  });

  it('GET /v1/formats returns the network format catalog', async () => {
    const res = await fetch(`${handle.url}/v1/formats`, { headers: authHeaders(NETWORK) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.formats));
    assert.ok(body.formats.length >= 4);
    assert.ok(body.formats.every(f => typeof f.format_id === 'string'));
  });

  it('GET /_debug/traffic counts hits per route for façade detection', async () => {
    const res = await fetch(`${handle.url}/_debug/traffic`);
    const body = await res.json();
    assert.ok(typeof body.traffic === 'object');
    // Multiple prior tests hit POST /v1/creatives — counter should be ≥ 1
    assert.ok((body.traffic['POST /v1/creatives'] ?? 0) >= 1);
    assert.ok((body.traffic['POST /v1/creatives/{id}/render'] ?? 0) >= 1);
    assert.ok((body.traffic['GET /serve/{id}'] ?? 0) >= 1);
  });
});
