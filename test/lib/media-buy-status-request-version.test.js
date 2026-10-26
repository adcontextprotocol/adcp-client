// adcp-client#3432: a buyer pinned to AdCP >= 3.1 must not receive a
// media-buy lifecycle the seller never sent. A conformant 3.2 seller may
// answer create_media_buy with `{ status: 'completed', media_buy_id, ... }`,
// omitting both the optional `media_buy_status` and the optional response
// `adcp_version` echo. From 3.1 that top-level `status` is the task envelope
// status; copying it into `media_buy_status` reports a finished buy.
//
// These tests drive the public AgentClient and runStoryboard surfaces over the
// real MCP client transport, with a scripted seller behind `trustedFetchFn`.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentClient } = require('../../dist/lib/index.js');
const { runStoryboard, extractContext } = require('../../dist/lib/testing/index.js');

const ENDPOINT = 'https://seller.example/mcp';
const account = { brand: { domain: 'acme.example' }, operator: 'acme.example', sandbox: true };
const caps32 = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['wholesale'] },
};

function created(extra = {}) {
  return {
    status: 'completed',
    media_buy_id: 'seller-buy',
    confirmed_at: '2026-10-23T00:00:00Z',
    revision: 1,
    packages: [{ package_id: 'seller-package', product_id: 'seller-product' }],
    ...extra,
  };
}

function readBack(status) {
  return {
    status: 'completed',
    media_buys: [
      {
        media_buy_id: 'seller-buy',
        status,
        currency: 'EUR',
        total_budget: 1000,
        confirmed_at: '2026-10-23T00:00:00Z',
        revision: 1,
        packages: [{ package_id: 'seller-package', product_id: 'seller-product' }],
      },
    ],
  };
}

function jsonRpc(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

/** Scripted MCP seller: `responses` maps tool name to the AdCP payload. */
function seller(responses) {
  const tools = Object.keys(responses);
  return async (_url, init = {}) => {
    if (!init.body) return new Response(null, { status: init.method === 'DELETE' ? 202 : 405 });
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') {
      return jsonRpc(msg.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'seller', version: '1' },
      });
    }
    if (msg.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') {
      return jsonRpc(msg.id, {
        tools: tools.map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      });
    }
    if (msg.method === 'tools/call') {
      const payload = responses[msg.params.name];
      if (payload === undefined) throw new Error(`unexpected tool ${msg.params.name}`);
      return jsonRpc(msg.id, { content: [{ type: 'text', text: JSON.stringify(payload) }] });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } }), {
      headers: { 'content-type': 'application/json' },
    });
  };
}

function createParams() {
  return {
    brand: account.brand,
    account,
    idempotency_key: 'status-request-version-0001',
    start_time: 'asap',
    end_time: '2099-01-01T00:00:00Z',
    packages: [{ product_id: 'seller-product', pricing_option_id: 'p', budget: 1000 }],
  };
}

describe('buyer client: un-echoed create_media_buy status at the requested release', () => {
  test('3.2 buyer: task status completed does not become media_buy_status', async () => {
    const client = new AgentClient(
      { id: 's', name: 's', agent_uri: ENDPOINT, protocol: 'mcp' },
      {
        adcpVersion: '3.2.7',
        transport: { trustedFetchFn: seller({ get_adcp_capabilities: caps32, create_media_buy: created() }) },
      }
    );

    const result = await client.createMediaBuy(createParams());

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.status, 'completed');
    assert.equal(result.data.media_buy_id, 'seller-buy');
    assert.ok(!('media_buy_status' in result.data), `fabricated media_buy_status: ${result.data.media_buy_status}`);
  });

  test('3.2 buyer: an explicit seller lifecycle is returned as sent', async () => {
    const client = new AgentClient(
      { id: 's', name: 's', agent_uri: ENDPOINT, protocol: 'mcp' },
      {
        adcpVersion: '3.2.7',
        transport: {
          trustedFetchFn: seller({
            get_adcp_capabilities: caps32,
            create_media_buy: created({ media_buy_status: 'pending_creatives' }),
          }),
        },
      }
    );

    const result = await client.createMediaBuy(createParams());

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.media_buy_status, 'pending_creatives');
  });

  test('3.0 buyer and 3.0 seller: lifecycle in status still surfaces as media_buy_status', async () => {
    const caps30 = {
      adcp: { major_versions: [3], idempotency: { supported: false } },
      account: { supported_billing: ['operator'] },
      supported_protocols: ['media_buy'],
      media_buy: { buying_modes: ['wholesale'] },
    };
    const legacyCreate = {
      media_buy_id: 'seller-buy',
      status: 'active',
      packages: [{ package_id: 'seller-package', product_id: 'seller-product' }],
    };
    const client = new AgentClient(
      { id: 's', name: 's', agent_uri: ENDPOINT, protocol: 'mcp' },
      {
        adcpVersion: '3.0',
        transport: { trustedFetchFn: seller({ get_adcp_capabilities: caps30, create_media_buy: legacyCreate }) },
      }
    );

    const result = await client.createMediaBuy(createParams());

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.status, 'active', 'the seller status is returned as sent');
    assert.equal(result.data.media_buy_status, 'active');
  });
});

const statusProbe = {
  id: 'media_buy_seller/status_request_version_probe',
  version: '1.0.0',
  title: 'Task status is not resource lifecycle',
  category: 'media_buy_seller',
  required_tools: ['create_media_buy'],
  phases: [
    {
      id: 'lifecycle',
      title: 'Create then read',
      steps: [
        {
          id: 'create',
          title: 'Create',
          task: 'create_media_buy',
          stateful: true,
          schema_ref: 'media-buy/create-media-buy-request.json',
          response_schema_ref: 'media-buy/create-media-buy-response.json',
          sample_request: {
            brand: account.brand,
            account,
            idempotency_key: 'status-probe-create',
            start_time: 'asap',
            end_time: '2099-09-30T23:59:59Z',
            packages: [{ product_id: 'seller-product', pricing_option_id: 'seller-price', budget: 1000 }],
          },
          context_outputs: [{ key: 'buy_id', path: 'media_buy_id' }],
          validations: [{ check: 'response_schema', description: 'Canonical create schema' }],
        },
        {
          id: 'read',
          title: 'Read',
          task: 'get_media_buys',
          stateful: true,
          schema_ref: 'media-buy/get-media-buys-request.json',
          response_schema_ref: 'media-buy/get-media-buys-response.json',
          sample_request: { account, media_buy_ids: ['$context.buy_id'] },
          validations: [{ check: 'response_schema', description: 'Canonical read schema' }],
        },
      ],
    },
  ],
};

async function runProbe(createResponse, readStatus) {
  const tools = ['get_adcp_capabilities', 'create_media_buy', 'get_media_buys'];
  return runStoryboard(ENDPOINT, statusProbe, {
    adcpVersion: '3.2.5',
    brand: account.brand,
    sandbox: true,
    timeout_ms: 3000,
    profile: { tools, raw_capabilities: caps32, supported_protocols: ['media_buy'] },
    transport: {
      trustedFetchFn: seller({
        get_adcp_capabilities: caps32,
        create_media_buy: createResponse,
        get_media_buys: readBack(readStatus),
      }),
    },
  });
}

function monotonicFailures(result) {
  return result.phases
    .flatMap(phase => phase.steps)
    .flatMap(step => step.validations.map(v => ({ step: step.step_id, ...v })))
    .filter(v => v.passed === false && /status\.monotonic|lifecycle graph/.test(JSON.stringify(v)));
}

describe('storyboard runner: status.monotonic at the requested release', () => {
  test('3.2.5 run: create without lifecycle then read active passes', async () => {
    const result = await runProbe(created(), 'active');
    assert.deepEqual(monotonicFailures(result), []);
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  });

  test('3.2.5 run: explicit create lifecycle then read active passes', async () => {
    const result = await runProbe(created({ media_buy_status: 'pending_creatives' }), 'active');
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  });

  test('3.2.5 run: a real terminal lifecycle followed by active still fails', async () => {
    const result = await runProbe(created({ media_buy_status: 'completed' }), 'active');
    assert.equal(result.overall_passed, false);
    const failures = monotonicFailures(result);
    assert.equal(failures.length, 1, JSON.stringify(failures));
    assert.equal(failures[0].step, 'read');
    assert.match(JSON.stringify(failures[0]), /completed → active/);
  });
});

describe('storyboard context: create_media_buy status at the requested release', () => {
  test('3.2 request: un-echoed task status is not captured as media_buy_status', () => {
    const extracted = extractContext('create_media_buy', created(), '3.2.5');
    assert.equal(extracted.media_buy_id, 'seller-buy');
    assert.ok(!('media_buy_status' in extracted), JSON.stringify(extracted));
  });

  test('3.0 request: lifecycle in status is still captured', () => {
    const extracted = extractContext('create_media_buy', created({ status: 'active' }), '3.0');
    assert.equal(extracted.media_buy_status, 'active');
  });

  test('explicit lifecycle is captured at any release', () => {
    const extracted = extractContext('create_media_buy', created({ media_buy_status: 'pending_creatives' }), '3.2.5');
    assert.equal(extracted.media_buy_status, 'pending_creatives');
  });
});
