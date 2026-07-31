/**
 * Regression tripwire: every request the SDK sends to an MCP agent configured
 * with `auth_token` must carry `Authorization: Bearer` / `x-adcp-auth`.
 *
 * Minimal counterpart to `v3-mcp-auth-header-regression.test.js`. That file
 * stands up a real MCP server (both protocol eras) so the whole read completes
 * on the wire; this one replaces the seller with a `transport.fetchFn` that
 * answers every request the way the reported seller answers an uncredentialed
 * one — HTTP 200 carrying `{"jsonrpc":"2.0","error":{"code":-32602,"message":
 * "missing Bearer or x-adcp-auth header"}}`. No HTTP server, no MCP server, no
 * signing keys.
 *
 * The trade is coverage, and it is not a small one:
 *
 *   - The canned rejection means the client never gets past connection setup,
 *     so this only sees the endpoint-discovery requests — never the
 *     `get_adcp_capabilities` or `get_media_buy_delivery` tool calls, which is
 *     where the credential was reported missing.
 *   - Supplying `transport.fetchFn` puts the client on its scoped-fetch path,
 *     which bypasses the endpoint / era / connection caches. A bug that only
 *     appears on a cached or reused connection cannot surface here at all.
 *
 * So: keep this as the fast check that the first hop is credentialed; use the
 * server-backed file to cover the tool calls and the cached paths.
 *
 * STATUS: passes on 13.0.0-rc.4 — the outbound requests are credentialed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentClient } = require('../../dist/lib/core/AgentClient.js');

const API_KEY = 'plain-api-key-for-v3-seller-0123456789';
const TENANT_HEADER = 'x-tenant-id';
const TENANT = 'acme';
const SELLER_URL = 'https://seller.example.com/v3/mcp';

/** The reported seller's rejection: JSON-RPC error inside an HTTP 200. */
function credentialRejection() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32602, message: 'missing Bearer or x-adcp-auth header' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Records the credential-bearing headers of every outbound request. */
function recordingFetch(outbound) {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let method;
    try {
      method = body ? JSON.parse(body).method : undefined;
    } catch {
      method = undefined;
    }
    outbound.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method,
      authorization: headers.get('authorization') ?? undefined,
      adcpAuth: headers.get('x-adcp-auth') ?? undefined,
      tenant: headers.get(TENANT_HEADER) ?? undefined,
    });
    return credentialRejection();
  };
}

test('v3 MCP seller: every outbound request carries the configured auth_token', async () => {
  const outbound = [];
  const client = new AgentClient(
    {
      id: 'v3-seller',
      name: 'V3 Seller',
      agent_uri: SELLER_URL,
      protocol: 'mcp',
      auth_token: API_KEY,
      headers: { [TENANT_HEADER]: TENANT },
    },
    { transport: { fetchFn: recordingFetch(outbound) } }
  );

  // The seller rejects everything, so the read fails by design — the assertion
  // is on what went out, not on the result.
  await client.getMediaBuyDelivery({ media_buy_ids: ['mb-1'] }).catch(() => {});

  assert.ok(outbound.length > 0, 'the SDK should have attempted at least one request');

  const bare = outbound.filter(entry => !entry.authorization && !entry.adcpAuth);
  assert.equal(
    bare.length,
    0,
    `${bare.length}/${outbound.length} requests went out with neither Authorization nor x-adcp-auth: ` +
      JSON.stringify(bare.map(entry => ({ url: entry.url, method: entry.method })))
  );

  for (const entry of outbound) {
    assert.equal(entry.authorization, `Bearer ${API_KEY}`, `Authorization missing on ${entry.method ?? entry.url}`);
    assert.equal(entry.adcpAuth, API_KEY, `x-adcp-auth missing on ${entry.method ?? entry.url}`);
    assert.equal(entry.tenant, TENANT, `agent.headers dropped on ${entry.method ?? entry.url}`);
  }
});
