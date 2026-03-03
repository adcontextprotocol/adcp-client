/**
 * Unit tests for MCP SSE fallback auth header handling (issue #288)
 *
 * SSEClientTransport supports requestInit.headers via the eventsource npm package,
 * so the fix passes authHeaders directly to the transport rather than using the
 * ?auth= URL workaround (which only covered the initial GET, not subsequent POSTs).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('MCP SSE fallback: auth headers passed via requestInit', () => {
  /**
   * Replicates the authHeaders construction from callMCPTool in mcp.ts.
   * This is the object passed to both StreamableHTTP and SSE transports.
   */
  function buildAuthHeaders(authToken, customHeaders) {
    // Merge: custom < auth (auth always wins)
    return {
      ...customHeaders,
      ...(authToken
        ? {
            Authorization: `Bearer ${authToken}`,
            'x-adcp-auth': authToken,
            Accept: 'application/json, text/event-stream',
          }
        : {}),
    };
  }

  // Compute Basic auth header dynamically — no hardcoded base64 credential literals
  const testBasicHeader = `Basic ${Buffer.from('testuser:testpass').toString('base64')}`;

  test('bearer auth_token produces Authorization: Bearer header', () => {
    const headers = buildAuthHeaders('my-token', undefined);

    assert.strictEqual(headers['Authorization'], 'Bearer my-token');
    assert.strictEqual(headers['x-adcp-auth'], 'my-token');
  });

  test('basic auth via customHeaders.Authorization is preserved when no auth_token', () => {
    const headers = buildAuthHeaders(undefined, { Authorization: testBasicHeader });

    assert.strictEqual(headers['Authorization'], testBasicHeader);
  });

  test('auth_token overwrites customHeaders.Authorization (auth always wins)', () => {
    const headers = buildAuthHeaders('bearer-token', { Authorization: testBasicHeader });

    assert.strictEqual(headers['Authorization'], 'Bearer bearer-token');
  });

  test('no Authorization header when neither auth_token nor customHeaders set', () => {
    const headers = buildAuthHeaders(undefined, undefined);

    assert.strictEqual(headers['Authorization'], undefined);
  });

  test('custom non-auth headers are preserved alongside auth', () => {
    const headers = buildAuthHeaders('tok', { 'x-org-id': 'org-123' });

    assert.strictEqual(headers['Authorization'], 'Bearer tok');
    assert.strictEqual(headers['x-org-id'], 'org-123');
  });

  test('all custom headers forwarded when no auth_token (SSE gets same headers as StreamableHTTP)', () => {
    // Verify custom headers survive the merge, regardless of transport
    const customHeaders = { Authorization: testBasicHeader, 'x-org-id': 'org-123' };
    const headers = buildAuthHeaders(undefined, customHeaders);

    assert.strictEqual(headers['Authorization'], testBasicHeader);
    assert.strictEqual(headers['x-org-id'], 'org-123');
  });

  test('basic auth round-trips: username:password survives encode/decode', () => {
    const encoded = Buffer.from('testuser:testpass').toString('base64');
    const headers = buildAuthHeaders(undefined, { Authorization: `Basic ${encoded}` });

    const recovered = headers['Authorization'].replace('Basic ', '');
    const decoded = Buffer.from(recovered, 'base64').toString('utf8');
    assert.strictEqual(decoded, 'testuser:testpass');
  });
});
