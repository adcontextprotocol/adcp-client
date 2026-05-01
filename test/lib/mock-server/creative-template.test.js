const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const { DEFAULT_API_KEY } = require('../../../dist/lib/mock-server/creative-template/seed-data.js');

describe('mock-server creative-template', () => {
  let handle;
  before(async () => {
    handle = await bootMockServer({ specialism: 'creative-template', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/templates`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'unauthorized');
  });

  it('rejects unknown workspace_id with 404 workspace_not_found', async () => {
    const res = await fetch(`${handle.url}/v3/workspaces/ws_does_not_exist/templates`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'workspace_not_found');
  });

  it('returns workspace-scoped template list', async () => {
    const acmeRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/templates`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(acmeRes.status, 200);
    const acmeBody = await acmeRes.json();
    assert.equal(acmeBody.templates.length, 4); // 3 display + 1 video

    // Summit doesn't have video access — only display templates
    const summitRes = await fetch(`${handle.url}/v3/workspaces/ws_summit_studio/templates`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const summitBody = await summitRes.json();
    assert.equal(summitBody.templates.length, 3);
    for (const t of summitBody.templates) {
      assert.equal(t.channel, 'display');
    }
  });

  it('filters templates by channel query', async () => {
    const res = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/templates?channel=video`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const body = await res.json();
    assert.equal(body.templates.length, 1);
    assert.equal(body.templates[0].channel, 'video');
  });

  it('returns template detail with slot definitions', async () => {
    const res = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/templates/tpl_celtra_display_medrec_v2`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(res.status, 200);
    const tpl = await res.json();
    assert.equal(tpl.template_id, 'tpl_celtra_display_medrec_v2');
    assert.ok(Array.isArray(tpl.slots));
    assert.ok(tpl.slots.length >= 3);
  });

  it('returns 404 template_not_visible when template is not in workspace scope', async () => {
    // Summit doesn't have the video preroll template
    const res = await fetch(`${handle.url}/v3/workspaces/ws_summit_studio/templates/tpl_celtra_video_preroll_v1`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'template_not_visible');
  });

  it('walks render lifecycle: queued → running → complete', async () => {
    const auth = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'Content-Type': 'application/json',
    };

    const createRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        template_id: 'tpl_celtra_display_medrec_v2',
        mode: 'build',
        inputs: [
          { slot_id: 'image', asset_type: 'image', url: 'https://example.test/image.jpg', width: 300, height: 250 },
          { slot_id: 'headline', asset_type: 'text', text: 'Built for the trail.' },
          { slot_id: 'cta', asset_type: 'text', text: 'Shop' },
          { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
        ],
        client_request_id: 'lifecycle-test',
      }),
    });
    assert.equal(createRes.status, 202);
    const created = await createRes.json();
    assert.equal(created.status, 'queued');
    const renderId = created.render_id;

    // First poll → running
    const poll1 = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const polled1 = await poll1.json();
    assert.equal(polled1.status, 'running');

    // Second poll → complete with HTML output
    const poll2 = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const polled2 = await poll2.json();
    assert.equal(polled2.status, 'complete');
    assert.ok(polled2.output);
    assert.ok(typeof polled2.output.tag_html === 'string');
    assert.ok(polled2.output.preview_url);
  });

  it('synthesizes VAST XML output for video templates', async () => {
    const createRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: 'tpl_celtra_video_preroll_v1',
        mode: 'build',
        inputs: [
          { slot_id: 'video', asset_type: 'video', url: 'https://example.test/v.mp4' },
          { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
        ],
        client_request_id: 'video-test',
      }),
    });
    assert.equal(createRes.status, 202);
    const created = await createRes.json();
    const renderId = created.render_id;

    // Walk to complete
    await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const finalRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const final = await finalRes.json();
    assert.equal(final.status, 'complete');
    assert.ok(final.output.vast_xml.includes('<VAST'));
  });

  it('returns 200 idempotent replay when client_request_id is reused with the same body', async () => {
    const auth = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const body = {
      template_id: 'tpl_celtra_display_medrec_v2',
      mode: 'build',
      inputs: [
        { slot_id: 'image', asset_type: 'image', url: 'https://example.test/image.jpg' },
        { slot_id: 'headline', asset_type: 'text', text: 'h' },
        { slot_id: 'cta', asset_type: 'text', text: 'c' },
        { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
      ],
      client_request_id: 'replay-test',
    };
    const first = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 202);
    const replay = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.render_id, (await first.json()).render_id);
  });

  it('returns 409 idempotency_conflict on body mismatch', async () => {
    const auth = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const baseBody = {
      template_id: 'tpl_celtra_display_medrec_v2',
      mode: 'build',
      inputs: [
        { slot_id: 'image', asset_type: 'image', url: 'https://example.test/a.jpg' },
        { slot_id: 'headline', asset_type: 'text', text: 'h' },
        { slot_id: 'cta', asset_type: 'text', text: 'c' },
        { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
      ],
      client_request_id: 'conflict-test',
    };
    const first = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(baseBody),
    });
    assert.equal(first.status, 202);

    const conflictBody = { ...baseBody, mode: 'preview' };
    const conflict = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(conflictBody),
    });
    assert.equal(conflict.status, 409);
    const cBody = await conflict.json();
    assert.equal(cBody.code, 'idempotency_conflict');
  });

  it('returns 404 when reading a render that belongs to a different workspace', async () => {
    const createRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: 'tpl_celtra_display_medrec_v2',
        mode: 'build',
        inputs: [
          { slot_id: 'image', asset_type: 'image', url: 'https://example.test/image.jpg' },
          { slot_id: 'headline', asset_type: 'text', text: 'h' },
          { slot_id: 'cta', asset_type: 'text', text: 'c' },
          { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
        ],
        client_request_id: 'cross-ws-test',
      }),
    });
    const created = await createRes.json();
    const renderId = created.render_id;

    const cross = await fetch(`${handle.url}/v3/workspaces/ws_summit_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    assert.equal(cross.status, 404);
    const cBody = await cross.json();
    assert.equal(cBody.code, 'render_not_in_workspace');
  });

  it('rejects malformed JSON body with 400 invalid_json', async () => {
    const res = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_json');
  });

  it('rejects unknown template_id with 404 template_not_found', async () => {
    const res = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: 'tpl_does_not_exist',
        mode: 'build',
        inputs: [],
        client_request_id: 'unknown-tpl-test',
      }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'template_not_found');
  });

  it('keeps `complete` as a terminal state — subsequent polls do not mutate output', async () => {
    // Regression for the auto-promote chain: an `else if` ladder means
    // `complete` does NOT advance to anything else. Pin this so a future
    // contributor adding a new state can't accidentally promote past
    // complete (e.g., complete → archived).
    const auth = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const create = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        template_id: 'tpl_celtra_display_medrec_v2',
        mode: 'build',
        inputs: [
          { slot_id: 'image', asset_type: 'image', url: 'https://example.test/i.jpg' },
          { slot_id: 'headline', asset_type: 'text', text: 'h' },
          { slot_id: 'cta', asset_type: 'text', text: 'c' },
          { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
        ],
        client_request_id: 'terminal-state-test',
      }),
    });
    const renderId = (await create.json()).render_id;
    // Walk through queued → running → complete
    await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const completeRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    });
    const completeBody = await completeRes.json();
    assert.equal(completeBody.status, 'complete');
    const firstUpdated = completeBody.updated_at;
    const firstOutput = JSON.stringify(completeBody.output);

    // Two more polls — should still be complete with same output.
    for (let i = 0; i < 2; i++) {
      const pollRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders/${renderId}`, {
        headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
      });
      const pollBody = await pollRes.json();
      assert.equal(pollBody.status, 'complete', 'status remains complete after additional polls');
      assert.equal(pollBody.updated_at, firstUpdated, 'updated_at does not advance once complete');
      assert.equal(JSON.stringify(pollBody.output), firstOutput, 'output is stable once complete');
    }
  });

  it('isolates client_request_id across workspaces — same key in different workspaces produces distinct renders', async () => {
    // Documents that the `${workspace_id}::${key}` keying scheme keeps two
    // workspaces' idempotency tables independent. Important: real customers
    // sharing a single API key across workspaces (different teams) commonly
    // reuse simple ids like 'q3-launch-spot' across teams and would not
    // expect collisions.
    const sharedKey = 'shared-key-cross-ws';
    const body = (workspace, hint) => ({
      template_id: 'tpl_celtra_display_medrec_v2',
      mode: 'build',
      inputs: [
        { slot_id: 'image', asset_type: 'image', url: `https://example.test/${hint}.jpg` },
        { slot_id: 'headline', asset_type: 'text', text: 'h' },
        { slot_id: 'cta', asset_type: 'text', text: 'c' },
        { slot_id: 'click_through', asset_type: 'click_url', url: 'https://example.test' },
      ],
      client_request_id: sharedKey,
    });
    const auth = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const acmeRes = await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body('ws_acme_studio', 'acme')),
    });
    assert.equal(acmeRes.status, 202);
    // Summit can use the same client_request_id without collision.
    const summitRes = await fetch(`${handle.url}/v3/workspaces/ws_summit_studio/renders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body('ws_summit_studio', 'summit')),
    });
    assert.equal(summitRes.status, 202, 'cross-workspace replay is independent — should NOT 409');
    const acmeRenderId = (await acmeRes.json()).render_id;
    const summitRenderId = (await summitRes.json()).render_id;
    assert.notEqual(acmeRenderId, summitRenderId, 'distinct render_ids across workspaces');
  });

  it('reports unified principal-mapping shape on the boot handle', async () => {
    assert.ok(Array.isArray(handle.principalMapping));
    assert.ok(handle.principalMapping.length >= 2);
    for (const entry of handle.principalMapping) {
      assert.ok(entry.adcpField);
      assert.ok(entry.adcpValue);
      assert.ok(entry.upstreamField);
      assert.ok(entry.upstreamValue);
    }
    assert.ok(/path|workspace/i.test(handle.principalScope));
  });

  describe('Façade-detection instrumentation (issue #1225)', () => {
    it('GET /_lookup/workspace resolves AdCP-side identifiers to upstream workspace_id', async () => {
      const res = await fetch(`${handle.url}/_lookup/workspace?adcp_advertiser=acmeoutdoor.example`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.adcp_advertiser, 'acmeoutdoor.example');
      assert.equal(body.workspace_id, 'ws_acme_studio');
    });

    it('GET /_lookup/workspace returns 404 for unknown adcp_advertiser', async () => {
      const res = await fetch(`${handle.url}/_lookup/workspace?adcp_advertiser=does-not-exist.example`);
      assert.equal(res.status, 404);
    });

    it('GET /_debug/traffic returns hit counts for exercised routes', async () => {
      await fetch(`${handle.url}/_lookup/workspace?adcp_advertiser=acmeoutdoor.example`);
      await fetch(`${handle.url}/v3/workspaces/ws_acme_studio/templates`, {
        headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
      });
      const res = await fetch(`${handle.url}/_debug/traffic`);
      const body = await res.json();
      assert.ok((body.traffic['GET /_lookup/workspace'] ?? 0) >= 1);
      assert.ok((body.traffic['GET /v3/workspaces/{ws}/templates'] ?? 0) >= 1);
    });
  });
});
