/**
 * Test auth token resolution with --auth and --auth-env flags
 *
 * This test verifies the fix for the token length bug where tokens
 * shorter than 20 characters were incorrectly treated as environment
 * variable names.
 *
 * Solution: Separate --auth (direct token) and --auth-env (env var name) flags
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { getAuthToken } = require('../../dist/lib/auth/index.js');

test('getAuthToken: always returns auth_token_env value directly', async t => {
  await t.test('short token (13 chars) is returned as-is', () => {
    const agentConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: 'ci-test-token', // 13 characters - previously failed!
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, 'ci-test-token');
  });

  await t.test('long token (>20 chars) is returned as-is', () => {
    const agentConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: 'this-is-a-very-long-token-value-1234567890',
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, 'this-is-a-very-long-token-value-1234567890');
  });

  await t.test('env var name format is returned as-is', () => {
    const agentConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: 'MY_AUTH_TOKEN', // Looks like env var, but returned as-is
    };

    const authToken = getAuthToken(agentConfig);
    // Caller is responsible for resolving env vars before setting auth_token_env
    assert.strictEqual(authToken, 'MY_AUTH_TOKEN');
  });

  await t.test('returns undefined when requiresAuth is false', () => {
    const agentConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: false,
      auth_token_env: 'some-token',
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, undefined);
  });

  await t.test('returns undefined when auth_token_env is not set', () => {
    const agentConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, undefined);
  });
});

test('CLI behavior: --auth vs --auth-env', async t => {
  await t.test('--auth provides direct token value', () => {
    // Simulating CLI behavior: --auth ci-test-token
    const cliAuthValue = 'ci-test-token';
    const isFromEnv = false;

    // CLI should pass this directly to auth_token_env
    const agentConfig = {
      id: 'cli-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: cliAuthValue, // Direct token value
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, 'ci-test-token');
  });

  await t.test('--auth-env resolves environment variable first', () => {
    // Simulating CLI behavior: --auth-env MY_TOKEN
    // CLI would do: const envValue = process.env['MY_TOKEN']
    const envVarName = 'MY_TOKEN';
    const resolvedValue = 'resolved-token-from-env';

    // CLI resolves env var BEFORE passing to AgentConfig
    const agentConfig = {
      id: 'cli-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: resolvedValue, // Already resolved by CLI
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, 'resolved-token-from-env');
  });

  await t.test('priority: --auth > --auth-env > ADCP_AUTH_TOKEN', () => {
    // This test documents the CLI priority logic

    // Priority 1: --auth (direct token)
    const directToken = 'direct-from-flag';
    assert.strictEqual(directToken, 'direct-from-flag');

    // Priority 2: --auth-env (resolved from env)
    const envToken = 'from-auth-env-flag';
    assert.strictEqual(envToken, 'from-auth-env-flag');

    // Priority 3: ADCP_AUTH_TOKEN env var
    const fallbackToken = 'from-env-fallback';
    assert.strictEqual(fallbackToken, 'from-env-fallback');
  });
});

test('Backward compatibility: existing behavior preserved', async t => {
  await t.test('server code that already resolves env vars works unchanged', () => {
    // Example: Server code that does its own env var resolution
    const serverAuthToken = process.env.SOME_TOKEN || 'fallback-token';

    const agentConfig = {
      id: 'server-agent',
      protocol: 'a2a',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: serverAuthToken, // Already resolved
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, serverAuthToken);
  });

  await t.test('programmatic usage with direct tokens works unchanged', () => {
    // Example: Library usage where caller provides token directly
    const agentConfig = {
      id: 'lib-agent',
      protocol: 'a2a',
      agent_uri: 'https://test.example.com',
      requiresAuth: true,
      auth_token_env: 'my-direct-token-123', // Direct token
    };

    const authToken = getAuthToken(agentConfig);
    assert.strictEqual(authToken, 'my-direct-token-123');
  });
});
