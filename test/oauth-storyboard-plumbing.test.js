const { describe, it } = require('node:test');
const assert = require('node:assert');

const { NonInteractiveFlowHandler, createNonInteractiveOAuthProvider } = require('../dist/lib/auth/oauth/index.js');

describe('NonInteractiveFlowHandler', () => {
  it('returns the configured redirect URL', () => {
    const h = new NonInteractiveFlowHandler();
    assert.strictEqual(h.getRedirectUrl().toString(), 'http://localhost:8766/callback');
  });

  it('throws with actionable message on redirectToAuthorization', async () => {
    const h = new NonInteractiveFlowHandler({ agentHint: 'test-agent' });
    await assert.rejects(
      () => h.redirectToAuthorization(new URL('https://auth.example/authorize')),
      err => err.code === 'interactive_required' && /adcp --save-auth test-agent --oauth/.test(err.message)
    );
  });

  it('throws on waitForCallback', async () => {
    const h = new NonInteractiveFlowHandler();
    await assert.rejects(
      () => h.waitForCallback(),
      err => err.code === 'interactive_required'
    );
  });

  it('cleanup is a no-op', async () => {
    const h = new NonInteractiveFlowHandler();
    await h.cleanup();
  });
});

describe('createNonInteractiveOAuthProvider', () => {
  it('builds a provider that exposes saved tokens and refuses new flow', async () => {
    const agent = {
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com/mcp',
      protocol: 'mcp',
      oauth_tokens: {
        access_token: 'at_123',
        refresh_token: 'rt_456',
        token_type: 'Bearer',
      },
      oauth_client: { client_id: 'client_abc' },
    };

    const provider = createNonInteractiveOAuthProvider(agent, { agentHint: 'test' });
    const tokens = await provider.tokens();
    assert.strictEqual(tokens?.access_token, 'at_123');
    assert.strictEqual(tokens?.refresh_token, 'rt_456');

    await assert.rejects(
      () => provider.redirectToAuthorization(new URL('https://auth.example/authorize')),
      err => err.code === 'interactive_required'
    );
  });

  it('returns undefined tokens when agent has none (forcing fresh flow error on first call)', async () => {
    const agent = { id: 'test', name: 'T', agent_uri: 'https://ex.com/mcp', protocol: 'mcp' };
    const provider = createNonInteractiveOAuthProvider(agent);
    assert.strictEqual(await provider.tokens(), undefined);
  });
});

describe('createTestClient auth.type=oauth plumbing', () => {
  const { createTestClient } = require('../dist/lib/testing/client.js');

  it('accepts oauth auth and does not throw during construction', () => {
    const client = createTestClient('https://example.com/mcp', 'mcp', {
      auth: {
        type: 'oauth',
        tokens: { access_token: 'at_1', refresh_token: 'rt_1', token_type: 'Bearer' },
        client: { client_id: 'client_abc' },
      },
    });
    assert.ok(client);
  });
});

describe('ProtocolClient routes MCP OAuth calls through the OAuth path', () => {
  // A thin smoke test: ensure agent with oauth_tokens triggers the OAuth-aware
  // call site. We don't exercise the network — we just confirm the code path
  // compiles and imports cleanly together.
  it('imports the OAuth provider factory alongside ProtocolClient', () => {
    const { ProtocolClient } = require('../dist/lib/protocols/index.js');
    const { createNonInteractiveOAuthProvider: f } = require('../dist/lib/auth/oauth/index.js');
    assert.strictEqual(typeof ProtocolClient.callTool, 'function');
    assert.strictEqual(typeof f, 'function');
  });
});
