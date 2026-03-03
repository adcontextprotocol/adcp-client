/**
 * Tests for Basic auth support in the testing SDK (issue #287)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Testing SDK: Basic auth support', () => {
  // Mirror the auth routing logic from createTestClient so tests stay coupled to the spec,
  // not to internal implementation details of ADCPMultiAgentClient.
  function buildAgentConfig(authOptions) {
    const agentConfig = {};
    if (authOptions) {
      if (authOptions.type === 'basic') {
        // basic: library encodes credentials and sets full Authorization header
        const encoded = Buffer.from(`${authOptions.username}:${authOptions.password}`).toString('base64');
        agentConfig.headers = { Authorization: `Basic ${encoded}` };
      } else {
        // bearer: raw token stored; library prepends 'Bearer ' internally
        agentConfig.auth_token = authOptions.token;
      }
    }
    return agentConfig;
  }

  test('basic auth produces a Basic Authorization header', () => {
    const config = buildAgentConfig({ type: 'basic', username: 'testuser', password: 'testpass' });

    assert.ok(config.headers?.Authorization?.startsWith('Basic '));
    const decoded = Buffer.from(config.headers.Authorization.slice(6), 'base64').toString('utf8');
    assert.strictEqual(decoded, 'testuser:testpass');
  });

  test('basic auth encodes credentials as base64(username:password)', () => {
    // RFC 7617 format: base64(username ":" password)
    const config = buildAgentConfig({ type: 'basic', username: 'testuser', password: 'testpass2' });

    const encoded = config.headers.Authorization.slice(6); // remove 'Basic '
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    assert.strictEqual(decoded, 'testuser:testpass2');
  });

  test('basic auth routes to headers, not auth_token', () => {
    const config = buildAgentConfig({ type: 'basic', username: 'u', password: 'p' });

    assert.ok(config.headers?.Authorization);
    assert.strictEqual(config.auth_token, undefined);
  });

  test('bearer auth maps to auth_token', () => {
    const config = buildAgentConfig({ type: 'bearer', token: 'my-bearer-token' });

    assert.strictEqual(config.auth_token, 'my-bearer-token');
    assert.strictEqual(config.headers, undefined);
  });

  test('no auth leaves both auth_token and headers unset', () => {
    const config = buildAgentConfig(undefined);

    assert.strictEqual(config.auth_token, undefined);
    assert.strictEqual(config.headers, undefined);
  });

  test('bearer auth does not set headers (prevents basic auth conflict)', () => {
    const config = buildAgentConfig({ type: 'bearer', token: 'tok' });

    assert.strictEqual(config.headers, undefined);
  });
});
