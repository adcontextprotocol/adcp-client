/**
 * MCP auth credentials must reach an AdCP 3.1 seller served on a `/v3/mcp`
 * endpoint, across both protocol eras and with request signing on or off.
 *
 * This began as a repro attempt for a reported credential loss on that path.
 * That hypothesis was wrong: the SDK attaches `Authorization` /
 * `x-adcp-auth` on every hop in all four combinations below, and the real defect
 * turned out to be elsewhere — a `server/discover` probe refused with 401/403 was
 * classified as an auth failure instead of falling back to the legacy transport
 * (see `mcp-negotiation-401-legacy-fallback.test.js`).
 *
 * The file is kept because the coverage is worth having on its own terms: the
 * era × signing matrix is the cheapest place to catch a future regression in
 * header attachment, and the assertions read the wire rather than an internal
 * header-building helper. It is not a repro of anything currently broken, and it
 * passes on 13.0.0-rc.4.
 *
 * The seller stub answers an uncredentialed request the way the reported seller
 * does — a JSON-RPC error inside an HTTP 200 — and records the headers of every
 * inbound request.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { AgentClient } = require('../../dist/lib/core/AgentClient.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { defaultCapabilityCache } = require('../../dist/lib/signing/client.js');
const { InMemorySigningProvider, mintEphemeralEd25519Key } = require('../../dist/lib/signing/testing.js');

const API_KEY = 'plain-api-key-for-v3-seller-0123456789';
const TENANT_HEADER = 'x-tenant-id';
const TENANT = 'acme';
const SELLER_PATH = '/v3/mcp';

function capabilities(signingRequiredFor) {
  return {
    adcp: {
      major_versions: [3],
      supported_versions: ['3.1', '3.0'],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
    },
    supported_protocols: ['media_buy'],
    specialisms: ['sales-guaranteed'],
    request_signing: { supported: true, covers_content_digest: 'either', required_for: signingRequiredFor },
  };
}

const METRICS = { impressions: 1000, spend: 25.5 };
const DELIVERY = {
  reporting_period: { start: '2026-07-01T00:00:00Z', end: '2026-07-30T23:59:59Z' },
  currency: 'USD',
  media_buy_deliveries: [
    {
      media_buy_id: 'mb-1',
      status: 'active',
      totals: METRICS,
      by_package: [{ package_id: 'pkg-1', pricing_model: 'cpm', rate: 25.5, currency: 'USD', ...METRICS }],
    },
  ],
};

function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

/**
 * AdCP 3.1 seller stub on `/v3/mcp` that refuses any request without a
 * credential, exactly as the reported seller does: JSON-RPC error inside an
 * HTTP 200. Records the headers of every inbound request.
 *
 * @param era 'modern' serves the MCP 2026-07-28 protocol; 'legacy' serves the
 *   v1 Streamable HTTP protocol, so the two transport eras can be told apart.
 * @param signingRequiredFor ops the seller advertises under
 *   `request_signing.required_for`, which decides whether the outbound request
 *   goes through the RFC 9421 signing fetch.
 */
async function startV3Seller(era, signingRequiredFor) {
  const requests = [];
  const tools = {
    get_adcp_capabilities: () => jsonResult(capabilities(signingRequiredFor)),
    get_media_buy_delivery: () => jsonResult(DELIVERY),
  };

  let serveMcp;
  let closeMcp = async () => {};

  if (era === 'modern') {
    const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
    const { toNodeHandler } = require('@modelcontextprotocol/node');
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'v3-seller', version: '1.0.0' });
      for (const [name, result] of Object.entries(tools)) {
        server.registerTool(name, { description: name }, async () => result());
      }
      return server;
    });
    serveMcp = toNodeHandler(handler);
    closeMcp = () => handler.close();
  } else {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    // The v1 Streamable HTTP transport is stateless here, so each request gets
    // its own server instance.
    serveMcp = async (req, res) => {
      const server = new McpServer({ name: 'v3-seller-legacy', version: '1.0.0' });
      for (const [name, result] of Object.entries(tools)) {
        server.registerTool(name, { inputSchema: {} }, async () => result());
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        await server.close();
      }
    };
  }

  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== SELLER_PATH && req.url !== `${SELLER_PATH}/`) {
      res.writeHead(404).end('not found');
      return;
    }

    const entry = {
      authorization: req.headers.authorization,
      adcpAuth: req.headers['x-adcp-auth'],
      tenant: req.headers[TENANT_HEADER],
    };
    requests.push(entry);

    if (!entry.authorization && !entry.adcpAuth) {
      // Reproduces the seller's own gate: JSON-RPC error over HTTP 200.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32602, message: 'missing Bearer or x-adcp-auth header' },
        })
      );
      return;
    }

    await serveMcp(req, res);
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${httpServer.address().port}${SELLER_PATH}`,
    requests,
    stop: async () => {
      await closeMcp();
      httpServer.closeAllConnections();
      await new Promise(resolve => httpServer.close(() => resolve()));
    },
  };
}

/** The reported buyer config: plain API key + custom headers + provider signing. */
async function buyerAgent(url) {
  const { kid, algorithm, privateKey } = await mintEphemeralEd25519Key({ adcp_use: 'request-signing' });
  return {
    id: 'v3-seller',
    name: 'V3 Seller',
    agent_uri: url,
    protocol: 'mcp',
    auth_token: API_KEY,
    headers: { [TENANT_HEADER]: TENANT },
    request_signing: {
      kind: 'provider',
      provider: new InMemorySigningProvider({ keyid: kid, algorithm, privateKey }),
      agent_url: 'https://buyer.example.com',
    },
  };
}

function assertCredentialOnEveryRequest(requests) {
  assert.ok(requests.length > 0, 'the seller should have received at least one request');

  const bare = requests.filter(entry => !entry.authorization && !entry.adcpAuth);
  assert.equal(
    bare.length,
    0,
    `${bare.length}/${requests.length} requests arrived with neither Authorization nor x-adcp-auth`
  );

  for (const entry of requests) {
    assert.equal(entry.authorization, `Bearer ${API_KEY}`, 'Authorization must carry the configured auth_token');
    assert.equal(entry.adcpAuth, API_KEY, 'x-adcp-auth must carry the configured auth_token');
    assert.equal(entry.tenant, TENANT, 'agent.headers must survive alongside the auth headers');
  }
}

async function readDelivery(agent, clientConfig) {
  const client = new AgentClient(agent, clientConfig);
  return client.getMediaBuyDelivery({ media_buy_ids: ['mb-1'] }).catch(error => ({ error }));
}

const SCENARIOS = [
  { era: 'modern', signingRequiredFor: [], label: 'modern era, signing not required' },
  { era: 'legacy', signingRequiredFor: [], label: 'legacy era, signing not required' },
  { era: 'modern', signingRequiredFor: ['get_media_buy_delivery'], label: 'modern era, delivery read signed' },
  { era: 'legacy', signingRequiredFor: ['get_media_buy_delivery'], label: 'legacy era, delivery read signed' },
];

for (const { era, signingRequiredFor, label } of SCENARIOS) {
  test(`v3 MCP seller (${label}): delivery read carries auth headers on every request`, async t => {
    const seller = await startV3Seller(era, signingRequiredFor);
    t.after(async () => {
      await closeMCPConnections();
      defaultCapabilityCache.clear();
      await seller.stop();
    });

    const result = await readDelivery(await buyerAgent(seller.url));

    assertCredentialOnEveryRequest(seller.requests);
    assert.equal(result.success, true, String(result.error ?? 'delivery read should succeed'));
  });
}

test('v3 MCP seller: transport.fetchFn sees auth headers on every outbound request', async t => {
  const seller = await startV3Seller('modern', []);
  t.after(async () => {
    await closeMCPConnections();
    defaultCapabilityCache.clear();
    await seller.stop();
  });

  const outbound = [];
  const spyFetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    outbound.push({
      authorization: headers.get('authorization') ?? undefined,
      adcpAuth: headers.get('x-adcp-auth') ?? undefined,
      tenant: headers.get(TENANT_HEADER) ?? undefined,
    });
    return fetch(input, init);
  };

  const result = await readDelivery(await buyerAgent(seller.url), { transport: { fetchFn: spyFetch } });

  assertCredentialOnEveryRequest(outbound);
  assert.equal(result.success, true, String(result.error ?? 'delivery read should succeed'));
});
