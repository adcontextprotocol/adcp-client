/**
 * Unit tests for connectMCP 401 error enrichment (issue #1869).
 *
 * When connectMCP receives an HTTP 401, it now throws MCPAuthRejectedError
 * with a `scheme` property identifying which auth credential the SDK sent
 * (oauth / bearer / header / none). This eliminates the opaque
 * "Error POSTing to endpoint (HTTP 401): unauthorized" message that cost
 * the reporter 30+ minutes of debugging time.
 *
 * Tests the MCPAuthRejectedError class directly (from dist) and replicates
 * the scheme-detection logic inline (same pattern as
 * mcp-connect-retry-predicate.test.js) to cover edge cases without
 * requiring a live MCP transport.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ---------- helpers replicating the scheme-detection from mcp.ts ----------

// Replicates extractAuthHeader() from mcp.ts (case-insensitive Authorization search)
function extractAuthHeader(headers) {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && value) return value;
  }
  return undefined;
}

// Replicates the scheme derivation added to connectMCP's catch block
function deriveScheme({ authProvider, authToken, customHeaders }) {
  const hasCustomAuthHeader = extractAuthHeader(customHeaders) !== undefined;
  return authProvider ? 'oauth' : authToken ? 'bearer' : hasCustomAuthHeader ? 'header' : 'none';
}

// ---------- MCPAuthRejectedError class tests (against compiled dist) ------

describe('MCPAuthRejectedError', () => {
  const { MCPAuthRejectedError, ADCPError } = require('../../dist/lib/index.js');

  test('is exported from @adcp/sdk public surface', () => {
    assert.ok(MCPAuthRejectedError, 'MCPAuthRejectedError should be exported');
  });

  test('extends ADCPError', () => {
    const err = new MCPAuthRejectedError('bearer');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ADCPError);
    assert.ok(err instanceof MCPAuthRejectedError);
  });

  test('has code MCP_AUTH_REJECTED', () => {
    const err = new MCPAuthRejectedError('bearer');
    assert.strictEqual(err.code, 'MCP_AUTH_REJECTED');
  });

  test('carries the scheme as a typed property', () => {
    for (const scheme of ['oauth', 'bearer', 'header', 'none']) {
      const err = new MCPAuthRejectedError(scheme);
      assert.strictEqual(err.scheme, scheme);
    }
  });

  test('message names the scheme for credentialed cases', () => {
    const err = new MCPAuthRejectedError('bearer');
    assert.ok(err.message.includes("scheme 'bearer'"), `message: ${err.message}`);
    assert.ok(err.message.includes('rejected the credential'), `message: ${err.message}`);
  });

  test('message explains misconfiguration for scheme=none', () => {
    const err = new MCPAuthRejectedError('none');
    assert.ok(err.message.includes('No auth credentials were configured'), `message: ${err.message}`);
    assert.ok(err.message.includes('connectMCP'), `message: ${err.message}`);
  });

  test('message does not include raw token values', () => {
    const err = new MCPAuthRejectedError('bearer', new Error('tok_secret'));
    // scheme name only; the raw cause error (which might contain token fragments)
    // is in details.cause, not in the main message
    assert.ok(!err.message.includes('tok_secret'), 'message should not leak cause content');
  });
});

// ---------- scheme derivation logic tests (inline replica) ----------------

describe('connectMCP scheme derivation', () => {
  test('oauth when authProvider is set', () => {
    assert.strictEqual(deriveScheme({ authProvider: {}, authToken: undefined, customHeaders: undefined }), 'oauth');
  });

  test('bearer when authToken is set', () => {
    assert.strictEqual(
      deriveScheme({ authProvider: undefined, authToken: 'tok_test', customHeaders: undefined }),
      'bearer'
    );
  });

  test('header when Authorization is in customHeaders (canonical case)', () => {
    assert.strictEqual(
      deriveScheme({
        authProvider: undefined,
        authToken: undefined,
        customHeaders: { Authorization: 'ApiKey secret' },
      }),
      'header'
    );
  });

  test('header when Authorization is in customHeaders (lowercase)', () => {
    assert.strictEqual(
      deriveScheme({
        authProvider: undefined,
        authToken: undefined,
        customHeaders: { authorization: 'ApiKey secret' },
      }),
      'header'
    );
  });

  test('header when Authorization is in customHeaders (UPPERCASE)', () => {
    assert.strictEqual(
      deriveScheme({ authProvider: undefined, authToken: undefined, customHeaders: { AUTHORIZATION: 'Bearer tok' } }),
      'header'
    );
  });

  test('none when no credentials configured', () => {
    assert.strictEqual(
      deriveScheme({ authProvider: undefined, authToken: undefined, customHeaders: undefined }),
      'none'
    );
  });

  test('bearer wins over customHeaders.Authorization (authToken takes precedence)', () => {
    // When both are present, the ternary chain reports the first match ('bearer').
    // This is correct: createMCPAuthHeaders(authToken) produces the Authorization header,
    // so authToken IS the bearer credential and customHeaders is supplemental context.
    assert.strictEqual(
      deriveScheme({ authProvider: undefined, authToken: 'tok', customHeaders: { Authorization: 'Bearer tok' } }),
      'bearer'
    );
  });

  test('none when customHeaders only has non-auth headers', () => {
    assert.strictEqual(
      deriveScheme({ authProvider: undefined, authToken: undefined, customHeaders: { 'x-custom': 'value' } }),
      'none'
    );
  });
});
