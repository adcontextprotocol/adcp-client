/**
 * CI gates for `examples/hello_si_adapter_brand.ts`.
 *
 * SI is currently a *protocol* in AdCP 3.0, not a specialism, so there is
 * no compliance storyboard to drive. The shared three-gate runner expects
 * a storyboard, so this file rolls its own runtime gates while keeping
 * gate 1 (strict tsc) and gate 3 (façade detection) parallel to peer
 * adapter tests.
 *
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. The booted adapter answers all four AdCP SI tools end-to-end through
 *      the MCP wire — `si_get_offering`, `si_initiate_session`,
 *      `si_send_message`, `si_terminate_session`. Verifies
 *      upstream-to-AdCP rename gaps (conversation_id → session_id,
 *      offering_query_id → offering_token, transaction_handoff →
 *      acp_handoff, handoff_transaction → upstream txn_ready) project
 *      correctly through the adapter.
 *   3. Every expected upstream route shows ≥1 hit at /_debug/traffic
 *      (façade-resistance gate).
 */

const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { bootMockServer } = require('@adcp/sdk/mock-server');
const net = require('node:net');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_si_adapter_brand.ts');
const ADCP_AUTH_TOKEN = 'sk_harness_do_not_use_in_prod';

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, host, () => {
        s.end();
        resolve();
      });
      s.on('error', () => {
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${host}:${port}`));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

describe('examples/hello_si_adapter_brand', () => {
  // ── Gate 1 — strict tsc ──
  it('passes tsc with --strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noPropertyAccessFromIndexSignature', () => {
    const res = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        EXAMPLE_FILE,
        '--target',
        'ES2022',
        '--module',
        'commonjs',
        '--moduleResolution',
        'node',
        '--esModuleInterop',
        '--skipLibCheck',
        '--strict',
        '--noUncheckedIndexedAccess',
        '--exactOptionalPropertyTypes',
        '--noImplicitOverride',
        '--noFallthroughCasesInSwitch',
        '--noPropertyAccessFromIndexSignature',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }
    );
    assert.equal(res.status, 0, `tsc reported errors:\n${(res.stdout || '') + (res.stderr || '')}`);
  });

  // ── Gates 2 + 3 — runtime ──
  let mockHandle;
  let agent;
  let agentPort;
  let mcpClient;

  before(async () => {
    agentPort = await pickFreePort();
    mockHandle = await bootMockServer({
      specialism: 'sponsored-intelligence',
      port: 0,
      apiKey: 'mock_si_brand_key_do_not_use_in_prod',
    });
    agent = spawn('npx', ['tsx', EXAMPLE_FILE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(agentPort),
        UPSTREAM_URL: mockHandle.url,
        UPSTREAM_API_KEY: 'mock_si_brand_key_do_not_use_in_prod',
        ADCP_AUTH_TOKEN,
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout.on('data', () => {});
    agent.stderr.on('data', () => {});
    await waitForPort('127.0.0.1', agentPort, 30_000);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${agentPort}/mcp`), {
      requestInit: { headers: { 'x-adcp-auth': ADCP_AUTH_TOKEN } },
    });
    mcpClient = new Client({ name: 'si-test-harness', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
  });

  after(async () => {
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch {
        // ignore close errors
      }
    }
    if (agent && agent.exitCode === null) {
      agent.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (agent.exitCode === null) agent.kill('SIGKILL');
    }
    if (mockHandle) await mockHandle.close();
  });

  function callSiTool(name, args) {
    return mcpClient.callTool({ name, arguments: args });
  }

  function structured(result) {
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find(c => c.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  }

  it('si_get_offering projects upstream offering shape onto AdCP SIGetOfferingResponse', async () => {
    const result = await callSiTool('si_get_offering', {
      offering_id: 'off_acme_trailrun_summer26',
      include_products: true,
    });
    const body = structured(result);
    assert.equal(body.available, true);
    // offering_query_id → offering_token rename
    assert.equal(typeof body.offering_token, 'string');
    assert.equal(body.offering_token.startsWith('oqt_'), true);
    // hero_image_url → image_url, landing_page_url → landing_url
    assert.equal(body.offering.title, 'Trail Runner Summer Collection');
    assert.equal(typeof body.offering.image_url, 'string');
    assert.equal(typeof body.offering.landing_url, 'string');
    // sku → product_id, thumbnail_url → image_url, pdp_url → url
    assert.ok(Array.isArray(body.matching_products) && body.matching_products.length >= 1);
    const p0 = body.matching_products[0];
    assert.equal(typeof p0.product_id, 'string');
    assert.equal(p0.product_id.startsWith('acme_tr_'), true);
    assert.equal(typeof p0.image_url, 'string');
    assert.equal(typeof p0.url, 'string');
    // inventory_status → availability_summary
    assert.equal(typeof p0.availability_summary, 'string');
  });

  it('si_initiate_session round-trips offering_token and projects conversation_id → session_id', async () => {
    const offering = await callSiTool('si_get_offering', {
      offering_id: 'off_acme_trailrun_summer26',
      include_products: true,
    });
    const offeringBody = structured(offering);

    const init = await callSiTool('si_initiate_session', {
      intent: 'looking for muddy-trail running shoes',
      offering_id: 'off_acme_trailrun_summer26',
      offering_token: offeringBody.offering_token,
      identity: { consent_granted: false },
      idempotency_key: 'idem_si_init_e2e_aaaaaaaa',
    });
    const body = structured(init);
    if (!body || typeof body.session_id !== 'string') {
      throw new Error('initiate_session returned unexpected shape: ' + JSON.stringify(init, null, 2));
    }
    assert.equal(typeof body.session_id, 'string');
    assert.equal(body.session_id.startsWith('conv_'), true);
    assert.equal(body.session_status, 'active');
    assert.equal(typeof body.session_ttl_seconds, 'number');
    // First turn from the brand greets the user.
    assert.equal(typeof body.response.message, 'string');
    assert.ok(Array.isArray(body.response.ui_elements));
  });

  it('si_send_message routes "buy" keyword to a pending_handoff projection (eager hint)', async () => {
    const init = await callSiTool('si_initiate_session', {
      intent: 'shopping',
      offering_id: 'off_acme_trailrun_summer26',
      identity: { consent_granted: false },
      idempotency_key: 'idem_si_init_buy_aaaaaaaa',
    });
    const initBody = structured(init);
    if (!initBody || typeof initBody.session_id !== 'string') {
      throw new Error('initiate_session returned unexpected shape: ' + JSON.stringify(init, null, 2));
    }
    const sessionId = initBody.session_id;

    const turn = await callSiTool('si_send_message', {
      session_id: sessionId,
      message: "I'd like to buy the black/green ones in size 10.",
      idempotency_key: 'idem_si_send_buy_aaaaaaaa',
    });
    const body = structured(turn);
    if (!body || body.session_id === undefined) {
      throw new Error('si_send_message returned unexpected shape: ' + JSON.stringify(turn, null, 2));
    }
    assert.equal(body.session_id, sessionId);
    // Adapter projects upstream close_recommended.type=txn_ready into AdCP
    // session_status: 'pending_handoff' + handoff: { type: 'transaction' }.
    assert.equal(body.session_status, 'pending_handoff');
    assert.equal(body.handoff?.type, 'transaction');
    assert.equal(body.handoff?.intent?.action, 'purchase');
  });

  it('si_terminate_session projects AdCP reason → upstream + transaction_handoff → acp_handoff', async () => {
    const init = await callSiTool('si_initiate_session', {
      intent: 'shopping',
      offering_id: 'off_acme_trailrun_summer26',
      identity: { consent_granted: false },
      idempotency_key: 'idem_si_init_term_aaaaaaaa',
    });
    const initBody = structured(init);
    if (!initBody || typeof initBody.session_id !== 'string') {
      throw new Error('initiate_session returned unexpected shape: ' + JSON.stringify(init, null, 2));
    }
    const sessionId = initBody.session_id;

    const term = await callSiTool('si_terminate_session', {
      session_id: sessionId,
      reason: 'handoff_transaction',
      termination_context: { summary: 'User chose blackgreen-10.' },
    });
    const body = structured(term);
    assert.equal(body.session_id, sessionId);
    assert.equal(body.terminated, true);
    assert.equal(body.session_status, 'terminated');
    // transaction_handoff → acp_handoff rename
    assert.ok(body.acp_handoff, 'acp_handoff present when AdCP reason maps to upstream txn_ready');
    assert.equal(typeof body.acp_handoff.checkout_url, 'string');
    assert.equal(typeof body.acp_handoff.checkout_token, 'string');
  });

  it('façade gate — every expected upstream route shows ≥1 hit', async () => {
    // SI tool requests don't carry `account` on the wire (the schema omits
    // it — session continuity flows through `session_id` instead), so
    // `accounts.resolve(undefined)` falls back to DEFAULT_LISTING_BRAND
    // without exercising `/_lookup/brand`. That route fires only on
    // production paths that resolve `account.brand.domain` from
    // `ctx.authInfo` per-tenant binding, which this fixture flow doesn't
    // simulate. Test the four tool-driven routes here.
    const expectedRoutes = [
      'GET /v1/brands/{brand}/offerings/{id}',
      'POST /v1/brands/{brand}/conversations',
      'POST /v1/brands/{brand}/conversations/{id}/turns',
      'POST /v1/brands/{brand}/conversations/{id}/close',
    ];
    const res = await fetch(`${mockHandle.url}/_debug/traffic`);
    const body = await res.json();
    const traffic = body.traffic || {};
    const missing = expectedRoutes.filter(r => (traffic[r] || 0) < 1);
    assert.deepEqual(
      missing,
      [],
      `These upstream routes had zero hits — the adapter is a façade for them:\n  ${missing.join('\n  ')}\n\nFull traffic:\n${JSON.stringify(traffic, null, 2)}`
    );
  });
});
