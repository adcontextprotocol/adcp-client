/**
 * `testAgent` must not put credentials into its logger context.
 *
 * `TestOptions` carries bearer tokens, Basic passwords, OAuth access/refresh
 * tokens, client-credential secrets, test-kit API keys, and caller-supplied
 * headers. The default logger serializes its whole context with `JSON.stringify`
 * to `console.log`, so an unredacted context puts live credentials into stdout
 * and CI logs. Custom loggers receive the same object.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');

const { testAgent } = require('../../dist/lib/testing/agent-tester.js');
const { setAgentTesterLogger } = require('../../dist/lib/testing/client.js');

/** Collect every logger context `testAgent` emits, serialized as the real logger would. */
function captureLogs() {
  const contexts = [];
  setAgentTesterLogger({
    info: ctx => contexts.push(ctx),
    error: ctx => contexts.push(ctx),
    warn: ctx => contexts.push(ctx),
    debug: ctx => contexts.push(ctx),
  });
  return {
    contexts,
    // Serialize the way the default logger does, so the assertions inspect
    // exactly what would have reached stdout.
    serialized: () => contexts.map(c => JSON.stringify(c, null, 2)).join('\n'),
  };
}

/** Mirrors the library's default console logger, restored after each test. */
const consoleLogger = {
  info: (ctx, msg) => console.log(`[INFO] ${msg}`, JSON.stringify(ctx, null, 2)),
  error: (ctx, msg) => console.error(`[ERROR] ${msg}`, JSON.stringify(ctx, null, 2)),
  warn: (ctx, msg) => console.warn(`[WARN] ${msg}`, JSON.stringify(ctx, null, 2)),
  debug: () => {},
};

const SECRETS = [
  'super-secret-bearer-token',
  'super-secret-password',
  'super-secret-access-token',
  'super-secret-refresh-token',
  'super-secret-client-secret',
  'super-secret-api-key',
  'super-secret-header-value',
];

async function runWithOptions(options) {
  const captured = captureLogs();
  // The scenario itself will fail against an unreachable agent; the logging
  // under test happens before any network call.
  await testAgent('https://agent.invalid.example', 'discovery', options).catch(() => {});
  return captured;
}

describe('testAgent: credential redaction in logs', () => {
  afterEach(() => {
    // Restore the default logger so other suites are unaffected.
    setAgentTesterLogger(consoleLogger);
  });

  test('does not log a bearer token', async () => {
    const captured = await runWithOptions({ auth: { type: 'bearer', token: 'super-secret-bearer-token' } });
    assert.doesNotMatch(captured.serialized(), /super-secret-bearer-token/);
  });

  test('does not log Basic credentials', async () => {
    const captured = await runWithOptions({
      auth: { type: 'basic', username: 'buyer', password: 'super-secret-password' },
    });
    assert.doesNotMatch(captured.serialized(), /super-secret-password/);
  });

  test('does not log OAuth access or refresh tokens', async () => {
    const captured = await runWithOptions({
      auth: {
        type: 'oauth',
        tokens: {
          access_token: 'super-secret-access-token',
          refresh_token: 'super-secret-refresh-token',
        },
      },
    });
    const serialized = captured.serialized();
    assert.doesNotMatch(serialized, /super-secret-access-token/);
    assert.doesNotMatch(serialized, /super-secret-refresh-token/);
  });

  test('does not log client-credential secrets', async () => {
    const captured = await runWithOptions({
      auth: {
        type: 'oauth_client_credentials',
        credentials: { client_id: 'cid', client_secret: 'super-secret-client-secret', token_url: 'https://x.example' },
      },
    });
    assert.doesNotMatch(captured.serialized(), /super-secret-client-secret/);
  });

  test('does not log test-kit API keys', async () => {
    const captured = await runWithOptions({ test_kit: { auth: { api_key: 'super-secret-api-key' } } });
    assert.doesNotMatch(captured.serialized(), /super-secret-api-key/);
  });

  test('does not log caller-supplied header values', async () => {
    const captured = await runWithOptions({ headers: { 'x-adcp-tenant': 'super-secret-header-value' } });
    assert.doesNotMatch(captured.serialized(), /super-secret-header-value/);
  });

  test('redacts every credential shape at once', async () => {
    const captured = await runWithOptions({
      auth: { type: 'bearer', token: 'super-secret-bearer-token' },
      headers: { authorization: 'super-secret-header-value' },
      test_kit: { auth: { api_key: 'super-secret-api-key' } },
    });
    const serialized = captured.serialized();
    for (const secret of SECRETS) {
      assert.doesNotMatch(serialized, new RegExp(secret), `${secret} must not appear in logs`);
    }
  });

  test('keeps the non-secret shape so logs stay useful', async () => {
    // Which scheme ran and which header names were in play are the debuggable
    // parts; only the values are dropped.
    const captured = await runWithOptions({
      auth: { type: 'bearer', token: 'super-secret-bearer-token' },
      headers: { 'x-adcp-tenant': 'super-secret-header-value' },
    });
    const start = captured.contexts.find(c => c?.options);
    assert.ok(start, 'expected a logged context carrying options');
    assert.strictEqual(start.options.auth.type, 'bearer', 'auth type is preserved');
    assert.ok('x-adcp-tenant' in start.options.headers, 'header names are preserved');
    assert.strictEqual(start.options.headers['x-adcp-tenant'], '[redacted]');
  });
});
