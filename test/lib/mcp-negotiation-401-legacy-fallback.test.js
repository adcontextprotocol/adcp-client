/**
 * Regression: a seller that answers `401`/`403` to the modern `server/discover`
 * probe must still be readable over the legacy transport.
 *
 * `versionNegotiation: { mode: 'auto' }` makes the MCP client probe
 * `server/discover` before `initialize`. Its classifier (`classifyHttpError` in
 * @modelcontextprotocol/client) treats `401`/`403` as the only probe outcome that
 * never falls back to the legacy era — every other refusal (404, 405, an
 * unrecognized JSON-RPC code, 4xx with a non-JSON-RPC body) yields a `legacy`
 * verdict, and 5xx yields `EraNegotiationFailed`. So a server that rejects the
 * modern discovery method while accepting the very same credential on
 * `initialize` became unreachable.
 *
 * Measured against a real seller: `server/discover` -> 401, `initialize` -> 200,
 * `tools/list` -> 200, all with one valid API key. The era header is irrelevant;
 * `MCP-Protocol-Version: 2026-07-28` returns 200 when the method is
 * `initialize`. The stub below mirrors exactly that.
 *
 * Whether this is also the 12.0.3 -> 13.0.0-rc.4 delta is unconfirmed. The
 * SDK-side probe logic is byte-identical across that window (the
 * `is401Error(error) ... throw` branch is unchanged since 11.2.0), so if the
 * behaviour did change it changed inside the MCP client, which moved
 * `2.0.0-beta.4` -> `2.0.0` over the same span. The fix stands on its own
 * either way: `createNegotiatedClient` now retries once with
 * `prior: { kind: 'legacy' }`, the escape hatch the MCP SDK documents for a
 * server known to be legacy.
 *
 * What each case is for:
 *
 *   - modern era / legacy era / header churn — the client and credential work
 *     normally. Controls: they pass with and without the fix, so a failure in
 *     the cases below is the negotiation path and not the harness.
 *   - `401s server/discover` / `403s server/discover` — the bug. Red without the
 *     fix, green with it.
 *   - `rejects with … everywhere still fails loudly` — the fix re-sends the
 *     credential to the same origin over a different transport after a refusal.
 *     These pin that it cannot launder a genuinely bad credential into a
 *     success. They pass either way by design; they exist to fail if someone
 *     later widens the retry into swallowing auth errors.
 *   - `uncredentialed client still gets the auth challenge` — the boundary the
 *     fix keys on. A probe 401 with no credential is a real challenge and must
 *     reach the caller; only a static credential refused on the probe alone
 *     earns the legacy retry. An OAuth provider is excluded for the same
 *     reason: there a 401 is the provider's cue to refresh.
 *   - `attempted at most once` — `skipProbe` is what stops a probe loop. This
 *     asserts the bound on the wire rather than trusting the flag.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { ADCPMultiAgentClient } = require('../../dist/lib/core/ADCPMultiAgentClient.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { defaultCapabilityCache } = require('../../dist/lib/signing/client.js');
const { InMemorySigningProvider, mintEphemeralEd25519Key } = require('../../dist/lib/signing/testing.js');

const API_KEY = 'plain-api-key-for-v3-seller-0123456789';
const AGENT_ID = '15';
const SELLER_PATH = '/v3/mcp';
const SOURCE_HEADER = 'x-storefront-source-id';
const SOURCE_ID = 'v3-seller-source';

const METRICS = { impressions: 1000, spend: 25.5 };
const DELIVERY = {
  reporting_period: { start: '2026-07-29T00:00:00Z', end: '2026-07-30T23:59:59Z' },
  currency: 'USD',
  media_buy_deliveries: [
    {
      media_buy_id: 'upstream-uuid-1',
      status: 'active',
      totals: METRICS,
      by_package: [{ package_id: 'pkg-1', pricing_model: 'cpm', rate: 25.5, currency: 'USD', ...METRICS }],
    },
  ],
};

function capabilities() {
  return {
    adcp: {
      major_versions: [3],
      supported_versions: ['3.1', '3.0'],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
    },
    supported_protocols: ['media_buy'],
    specialisms: ['sales-guaranteed'],
    request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
  };
}

function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

/** The reported seller's rejection: JSON-RPC error inside an HTTP 200. */
function credentialRejectionBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32602, message: 'missing Bearer or x-adcp-auth header' },
  });
}

/**
 * AdCP 3.1 seller on `/v3/mcp`, mirroring the reported seller's whole surface.
 *
 * @param options.era 'modern' serves the MCP 2026-07-28 protocol, 'legacy' the
 *   v1 Streamable HTTP protocol.
 * @param options.rejectDiscoverWith when set, `server/discover` is answered with
 *   this status (401 or 403) while every other method is served normally — the
 *   reported seller's shape.
 * @param options.rejectEverythingWith when set, EVERY request is answered with
 *   this status: a genuinely bad credential, as opposed to a server that merely
 *   refuses the modern discovery method.
 */
async function startV3Seller({ era = 'modern', rejectDiscoverWith = 0, rejectEverythingWith = 0 } = {}) {
  const requests = [];
  const tools = {
    get_adcp_capabilities: () => jsonResult(capabilities()),
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
    serveMcp = async (req, res, parsedBody) => {
      const server = new McpServer({ name: 'v3-seller-legacy', version: '1.0.0' });
      for (const [name, result] of Object.entries(tools)) {
        server.registerTool(name, { inputSchema: {} }, async () => result());
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } finally {
        await server.close();
      }
    };
  }

  const httpServer = http.createServer(async (req, res) => {
    let rawBody = '';
    for await (const chunk of req) rawBody += String(chunk);
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = undefined;
    }
    // Record every request on every path, so discovery probes are visible.
    const entry = {
      path: req.url,
      method: parsedBody?.method,
      protocolVersion: req.headers['mcp-protocol-version'],
      authorization: req.headers.authorization,
      adcpAuth: req.headers['x-adcp-auth'],
      source: req.headers[SOURCE_HEADER],
    };
    requests.push(entry);

    // The reported seller 401s this sibling path regardless of credential.
    // `discoverMCPEndpoint` needs a 401 from somewhere to raise
    // AuthenticationRequiredError at all.
    if (req.url === '/v2/mcp') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    // A seller that rejects every request, credential or not: a genuinely bad
    // credential, or an endpoint gated behind auth the client has not satisfied.
    // Deliberately outranks the uncredentialed branch below so this mode really
    // does mean every request.
    if (rejectEverythingWith !== 0) {
      res
        .writeHead(rejectEverythingWith, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    if (!entry.authorization && !entry.adcpAuth) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(credentialRejectionBody());
      return;
    }

    // The reported seller rejects the modern discovery METHOD, not the era
    // header: `MCP-Protocol-Version: 2026-07-28` returns 200 when the method is
    // `initialize`, and `tools/list` succeeds with the very same credential.
    if (rejectDiscoverWith !== 0 && entry.method === 'server/discover') {
      res
        .writeHead(rejectDiscoverWith, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    if (req.url !== SELLER_PATH && req.url !== `${SELLER_PATH}/`) {
      res.writeHead(404).end('not found');
      return;
    }

    await serveMcp(req, res, parsedBody);
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

/**
 * The reporting consumer's agent config: plain API-key `auth_token`, per-request
 * trace headers, and a provider `request_signing` block.
 *
 * The headers matter beyond decoration. `connectionCacheKey` in
 * `protocols/mcp.js` strips only `traceparent`/`tracestate`/`baggage` from its
 * disambiguator, so a unique `x-request-id` mints a fresh connection cache key
 * on every call. A consumer that stamps per-request ids therefore never reuses a
 * pooled connection, which is a different code path from a static-header client.
 */
async function prodAgentConfig(url, requestId) {
  const { kid, algorithm, privateKey } = await mintEphemeralEd25519Key({ adcp_use: 'request-signing' });
  return {
    id: AGENT_ID,
    name: 'V3 Seller',
    agent_uri: url,
    protocol: 'mcp',
    auth_token: API_KEY,
    headers: {
      traceparent: '00-ccfa046a4017ae51752709fbec24368d-44712e5fc6252816-00',
      'x-request-id': requestId,
      [SOURCE_HEADER]: SOURCE_ID,
    },
    request_signing: {
      kind: 'provider',
      provider: new InMemorySigningProvider({ keyid: kid, algorithm, privateKey }),
      agent_url: 'https://buyer.example.com',
    },
  };
}

/** `new ADCPMultiAgentClient([cfg], opts).agent(id)`, as the consumer builds it. */
function prodAgent(config) {
  return new ADCPMultiAgentClient([config], {
    workingTimeout: 5000,
    adcpVersion: '3.1',
    requireV3ForMutations: false,
    allowV2: true,
    validation: { requests: 'warn', responses: 'warn' },
  }).agent(AGENT_ID);
}

/** The consumer's delivery read: full request body, three arguments. */
function readDelivery(agent) {
  return agent
    .getMediaBuyDelivery(
      {
        media_buy_ids: ['upstream-uuid-1'],
        include_package_daily_breakdown: true,
        start_date: '2026-07-29',
        end_date: '2026-07-30',
      },
      undefined,
      { timeout: 30_000 }
    )
    .catch(error => ({ error }));
}

/**
 * Requests to the agent endpoint itself. Excludes the RFC 9728 metadata walk
 * (`/.well-known/oauth-authorization-server…`), which is *correctly*
 * uncredentialed: you do not present a seller bearer to an authorization-server
 * metadata endpoint. Asserting on those would fail for the wrong reason.
 */
function agentEndpointRequests(requests) {
  return requests.filter(entry => !entry.path.startsWith('/.well-known/'));
}

function assertCredentialOnEveryRequest(requests) {
  const hops = agentEndpointRequests(requests);
  assert.ok(hops.length > 0, 'the seller should have received at least one request');

  const bare = hops.filter(entry => !entry.authorization && !entry.adcpAuth);
  assert.equal(
    bare.length,
    0,
    `${bare.length}/${hops.length} agent-endpoint requests arrived with neither Authorization nor ` +
      `x-adcp-auth: ${JSON.stringify(bare.map(entry => ({ path: entry.path, era: entry.protocolVersion ?? 'legacy' })))}`
  );

  for (const entry of hops) {
    assert.equal(entry.authorization, `Bearer ${API_KEY}`, `Authorization missing on ${entry.path}`);
    assert.equal(entry.adcpAuth, API_KEY, `x-adcp-auth missing on ${entry.path}`);
    assert.equal(entry.source, SOURCE_ID, `agent.headers dropped on ${entry.path}`);
  }
}

function withCleanup(t) {
  t.after(async () => {
    await closeMCPConnections();
    defaultCapabilityCache.clear();
  });
}

for (const era of ['modern', 'legacy']) {
  test(`v3 MCP seller (${era} era): multi-agent client delivery read is credentialed on every hop`, async t => {
    withCleanup(t);
    const seller = await startV3Seller({ era });
    t.after(() => seller.stop());

    const result = await readDelivery(prodAgent(await prodAgentConfig(seller.url, 'req-1')));

    assertCredentialOnEveryRequest(seller.requests);
    assert.equal(result.success, true, String(result.error ?? 'delivery read should succeed'));
  });
}

test('v3 MCP seller: per-request header churn does not drop the credential across calls', async t => {
  withCleanup(t);
  const seller = await startV3Seller();
  t.after(() => seller.stop());

  // Distinct x-request-id per call, so each read takes a cold connection-cache
  // path rather than reusing the first call's pooled connection.
  for (const requestId of ['req-1', 'req-2', 'req-3']) {
    const result = await readDelivery(prodAgent(await prodAgentConfig(seller.url, requestId)));
    assert.equal(result.success, true, `read ${requestId}: ${String(result.error ?? '')}`);
  }

  assertCredentialOnEveryRequest(seller.requests);
});

// The MCP client's classifier groups 401 and 403 as the two probe outcomes that
// never fall back to the legacy era, and the fix keys on both. 403 was an
// untested branch until this loop.
for (const status of [401, 403]) {
  test(`v3 MCP seller: delivery read completes when the seller ${status}s server/discover`, async t => {
    withCleanup(t);
    const seller = await startV3Seller({ era: 'legacy', rejectDiscoverWith: status });
    t.after(() => seller.stop());

    const result = await readDelivery(prodAgent(await prodAgentConfig(seller.url, `req-failover-${status}`)));

    // The seller serves this read on the legacy transport with this exact
    // credential. The client has to fall back and actually try it, rather than
    // reporting the probe's refusal as a missing auth_token.
    assert.equal(
      result.success,
      true,
      `delivery read should complete over the legacy transport: ${String(result.error?.name ?? '')} ${String(result.error?.message ?? '')}`
    );
  });
}

// The legacy fallback re-sends the credential to the same origin over a
// different transport. That must not turn a real auth failure into a retry that
// hides it: when the seller rejects the credential on every method, the caller
// still has to hear about it.
for (const status of [401, 403]) {
  test(`v3 MCP seller: a credential the seller rejects with ${status} everywhere still fails loudly`, async t => {
    withCleanup(t);
    const seller = await startV3Seller({ era: 'legacy', rejectEverythingWith: status });
    t.after(() => seller.stop());

    const result = await readDelivery(prodAgent(await prodAgentConfig(seller.url, `req-bad-${status}`)));

    assert.notEqual(result.success, true, 'a rejected credential must not read as a successful delivery');
    assert.ok(result.error !== undefined, 'a rejected credential must surface an error rather than an empty result');
  });
}

// The boundary the fix keys on. With no credential, a probe 401 IS the server's
// challenge: the caller needs it surfaced (WWW-Authenticate / RFC 9728) rather
// than swapped for a legacy retry that cannot succeed either. Only a static
// credential the server rejected on the probe alone earns the fallback.
test('v3 MCP seller: an uncredentialed client still gets the auth challenge, not a legacy retry', async t => {
  withCleanup(t);
  const seller = await startV3Seller({ era: 'legacy', rejectEverythingWith: 401 });
  t.after(() => seller.stop());

  const noCredential = new ADCPMultiAgentClient(
    [{ id: AGENT_ID, name: 'V3 Seller', agent_uri: seller.url, protocol: 'mcp' }],
    { workingTimeout: 5000, adcpVersion: '3.1', requireV3ForMutations: false, allowV2: true }
  ).agent(AGENT_ID);

  const result = await readDelivery(noCredential);

  assert.notEqual(result.success, true, 'an uncredentialed read must not succeed');
  assert.equal(
    result.error?.name,
    'AuthenticationRequiredError',
    `expected the auth challenge to reach the caller, got ${String(result.error?.name)}: ${String(result.error?.message ?? '')}`
  );
});

test('v3 MCP seller: the legacy retry after a probe refusal is attempted at most once', async t => {
  withCleanup(t);
  // Reject everything, so the retry can never succeed and any loop shows up as
  // unbounded hops. `skipProbe` is what bounds this; assert the bound, not the flag.
  const seller = await startV3Seller({ era: 'legacy', rejectEverythingWith: 401 });
  t.after(() => seller.stop());

  await readDelivery(prodAgent(await prodAgentConfig(seller.url, 'req-loop')));

  const discoverProbes = seller.requests.filter(entry => entry.method === 'server/discover');
  assert.ok(
    discoverProbes.length <= 4,
    `expected the probe/retry pair to be bounded, saw ${discoverProbes.length} server/discover attempts ` +
      `across ${seller.requests.length} hops`
  );
  assert.ok(seller.requests.length < 40, `expected a bounded number of hops, saw ${seller.requests.length}`);
});
