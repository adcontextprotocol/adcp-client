/**
 * Tests for OAuth module
 */

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

// Import from built library
const {
  MCPOAuthProvider,
  CLIFlowHandler,
  createCLIOAuthProvider,
  hasValidOAuthTokens,
  clearOAuthTokens,
  getEffectiveAuthToken,
  toMCPTokens,
  fromMCPTokens,
  toMCPClientInfo,
  fromMCPClientInfo,
  DEFAULT_CLIENT_METADATA,
  discoverOAuthMetadata,
} = require('../../dist/lib/auth/oauth');

describe('OAuth Types', () => {
  describe('toMCPTokens', () => {
    test('converts AgentOAuthTokens to MCP format', () => {
      const agentTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      };

      const mcpTokens = toMCPTokens(agentTokens);

      assert.strictEqual(mcpTokens.access_token, 'test-access-token');
      assert.strictEqual(mcpTokens.refresh_token, 'test-refresh-token');
      assert.strictEqual(mcpTokens.token_type, 'Bearer');
      assert.strictEqual(mcpTokens.expires_in, 3600);
      assert.strictEqual(mcpTokens.scope, 'read write');
    });

    test('defaults token_type to Bearer', () => {
      const agentTokens = {
        access_token: 'test-access-token',
      };

      const mcpTokens = toMCPTokens(agentTokens);
      assert.strictEqual(mcpTokens.token_type, 'Bearer');
    });
  });

  describe('fromMCPTokens', () => {
    test('converts MCP tokens to AgentOAuthTokens format', () => {
      const mcpTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      };

      const agentTokens = fromMCPTokens(mcpTokens);

      assert.strictEqual(agentTokens.access_token, 'test-access-token');
      assert.strictEqual(agentTokens.refresh_token, 'test-refresh-token');
      assert.strictEqual(agentTokens.token_type, 'Bearer');
      assert.strictEqual(agentTokens.expires_in, 3600);
      assert.strictEqual(agentTokens.scope, 'read write');
      assert.ok(agentTokens.expires_at);
    });

    test('calculates expires_at from expires_in', () => {
      const now = Date.now();
      const mcpTokens = {
        access_token: 'test',
        expires_in: 3600,
      };

      const agentTokens = fromMCPTokens(mcpTokens);
      const expiresAt = new Date(agentTokens.expires_at).getTime();

      // Should be approximately 1 hour from now
      assert.ok(expiresAt > now + 3500000);
      assert.ok(expiresAt < now + 3700000);
    });

    test('omits refresh_token if not present', () => {
      const mcpTokens = {
        access_token: 'test',
      };

      const agentTokens = fromMCPTokens(mcpTokens);
      assert.strictEqual(agentTokens.refresh_token, undefined);
    });
  });

  describe('toMCPClientInfo', () => {
    test('converts AgentOAuthClient to MCP format', () => {
      const agentClient = {
        client_id: 'test-client-id',
        client_secret: 'test-secret',
        client_secret_expires_at: 1234567890,
      };

      const mcpClient = toMCPClientInfo(agentClient);

      assert.strictEqual(mcpClient.client_id, 'test-client-id');
      assert.strictEqual(mcpClient.client_secret, 'test-secret');
      assert.strictEqual(mcpClient.client_secret_expires_at, 1234567890);
    });
  });

  describe('fromMCPClientInfo', () => {
    test('converts MCP client info to AgentOAuthClient format', () => {
      const mcpClient = {
        client_id: 'test-client-id',
        client_secret: 'test-secret',
        client_secret_expires_at: 1234567890,
      };

      const agentClient = fromMCPClientInfo(mcpClient);

      assert.strictEqual(agentClient.client_id, 'test-client-id');
      assert.strictEqual(agentClient.client_secret, 'test-secret');
      assert.strictEqual(agentClient.client_secret_expires_at, 1234567890);
    });
  });
});

describe('OAuth Helper Functions', () => {
  describe('hasValidOAuthTokens', () => {
    test('returns false for agent without oauth_tokens', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
      };

      assert.strictEqual(hasValidOAuthTokens(agent), false);
    });

    test('returns false for agent with empty oauth_tokens', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        oauth_tokens: {},
      };

      assert.strictEqual(hasValidOAuthTokens(agent), false);
    });

    test('returns true for agent with valid access_token', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        oauth_tokens: {
          access_token: 'valid-token',
        },
      };

      assert.strictEqual(hasValidOAuthTokens(agent), true);
    });

    test('returns false for expired token', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        oauth_tokens: {
          access_token: 'valid-token',
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
      };

      assert.strictEqual(hasValidOAuthTokens(agent), false);
    });

    test('returns false for token expiring within 5 minutes', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        oauth_tokens: {
          access_token: 'valid-token',
          expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        },
      };

      assert.strictEqual(hasValidOAuthTokens(agent), false);
    });

    test('returns true for token expiring after 5 minutes', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        oauth_tokens: {
          access_token: 'valid-token',
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      };

      assert.strictEqual(hasValidOAuthTokens(agent), true);
    });
  });

  describe('clearOAuthTokens', () => {
    test('removes all OAuth data from agent', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        oauth_tokens: { access_token: 'token' },
        oauth_client: { client_id: 'client' },
        oauth_code_verifier: 'verifier',
      };

      clearOAuthTokens(agent);

      assert.strictEqual(agent.oauth_tokens, undefined);
      assert.strictEqual(agent.oauth_client, undefined);
      assert.strictEqual(agent.oauth_code_verifier, undefined);
    });

    test('preserves other agent properties', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        auth_token: 'static-token',
        oauth_tokens: { access_token: 'token' },
      };

      clearOAuthTokens(agent);

      assert.strictEqual(agent.id, 'test');
      assert.strictEqual(agent.name, 'Test');
      assert.strictEqual(agent.auth_token, 'static-token');
    });
  });

  describe('getEffectiveAuthToken', () => {
    test('returns OAuth access_token when valid', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        auth_token: 'static-token',
        oauth_tokens: {
          access_token: 'oauth-token',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      };

      assert.strictEqual(getEffectiveAuthToken(agent), 'oauth-token');
    });

    test('falls back to static token when OAuth expired', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        auth_token: 'static-token',
        oauth_tokens: {
          access_token: 'oauth-token',
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
      };

      assert.strictEqual(getEffectiveAuthToken(agent), 'static-token');
    });

    test('returns static token when no OAuth tokens', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
        auth_token: 'static-token',
      };

      assert.strictEqual(getEffectiveAuthToken(agent), 'static-token');
    });

    test('returns undefined when no auth configured', () => {
      const agent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://example.com',
        protocol: 'mcp',
      };

      assert.strictEqual(getEffectiveAuthToken(agent), undefined);
    });
  });
});

describe('MCPOAuthProvider', () => {
  let agent;
  let mockFlowHandler;

  beforeEach(() => {
    agent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://example.com/mcp',
      protocol: 'mcp',
    };

    mockFlowHandler = {
      getRedirectUrl: () => 'http://localhost:8766/callback',
      redirectToAuthorization: async () => {},
      waitForCallback: async () => 'auth-code',
      cleanup: async () => {},
    };
  });

  test('creates provider with correct metadata', () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
        client_name: 'Test Client',
      },
    });

    assert.strictEqual(provider.clientMetadata.client_name, 'Test Client');
    assert.strictEqual(provider.redirectUrl, 'http://localhost:8766/callback');
  });

  test('returns undefined for clientInformation when not registered', async () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    const info = await provider.clientInformation();
    assert.strictEqual(info, undefined);
  });

  test('saves and retrieves client information', async () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await provider.saveClientInformation({
      client_id: 'test-client-id',
      client_secret: 'test-secret',
    });

    const info = await provider.clientInformation();
    assert.strictEqual(info.client_id, 'test-client-id');
    assert.strictEqual(agent.oauth_client.client_id, 'test-client-id');
  });

  test('returns undefined for tokens when not authenticated', async () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    const tokens = await provider.tokens();
    assert.strictEqual(tokens, undefined);
  });

  test('saves tokens and clears code verifier', async () => {
    agent.oauth_code_verifier = 'test-verifier';

    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await provider.saveTokens({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const tokens = await provider.tokens();
    assert.strictEqual(tokens.access_token, 'test-access-token');
    assert.strictEqual(agent.oauth_tokens.access_token, 'test-access-token');
    assert.strictEqual(agent.oauth_code_verifier, undefined); // Cleaned up
  });

  test('saves and retrieves code verifier', async () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await provider.saveCodeVerifier('test-verifier');
    const verifier = await provider.codeVerifier();

    assert.strictEqual(verifier, 'test-verifier');
    assert.strictEqual(agent.oauth_code_verifier, 'test-verifier');
  });

  test('throws when code verifier not saved', async () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await assert.rejects(() => provider.codeVerifier(), /No PKCE code verifier found/);
  });

  test('invalidates all credentials', async () => {
    agent.oauth_tokens = { access_token: 'token' };
    agent.oauth_client = { client_id: 'client' };
    agent.oauth_code_verifier = 'verifier';

    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await provider.invalidateCredentials('all');

    assert.strictEqual(agent.oauth_tokens, undefined);
    assert.strictEqual(agent.oauth_client, undefined);
    assert.strictEqual(agent.oauth_code_verifier, undefined);
  });

  test('invalidates only tokens', async () => {
    agent.oauth_tokens = { access_token: 'token' };
    agent.oauth_client = { client_id: 'client' };

    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await provider.invalidateCredentials('tokens');

    assert.strictEqual(agent.oauth_tokens, undefined);
    assert.strictEqual(agent.oauth_client.client_id, 'client');
  });

  test('checks hasValidTokens correctly', () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    assert.strictEqual(provider.hasValidTokens(), false);

    agent.oauth_tokens = {
      access_token: 'token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };

    assert.strictEqual(provider.hasValidTokens(), true);
  });

  test('checks hasRefreshToken correctly', () => {
    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    assert.strictEqual(provider.hasRefreshToken(), false);

    agent.oauth_tokens = { access_token: 'token', refresh_token: 'refresh' };
    assert.strictEqual(provider.hasRefreshToken(), true);
  });

  test('calls storage when provided', async () => {
    let savedAgent = null;
    const mockStorage = {
      loadAgent: async () => agent,
      saveAgent: async a => {
        savedAgent = a;
      },
    };

    const provider = new MCPOAuthProvider({
      agent,
      flowHandler: mockFlowHandler,
      storage: mockStorage,
      clientMetadata: {
        ...DEFAULT_CLIENT_METADATA,
        redirect_uris: ['http://localhost:8766/callback'],
      },
    });

    await provider.saveTokens({ access_token: 'token' });

    assert.strictEqual(savedAgent, agent);
  });
});

describe('CLIFlowHandler', () => {
  test('returns correct redirect URL', () => {
    const handler = new CLIFlowHandler({ callbackPort: 9999 });
    assert.strictEqual(handler.getRedirectUrl(), 'http://localhost:9999/callback');
  });

  test('uses default port 8766', () => {
    const handler = new CLIFlowHandler();
    assert.strictEqual(handler.getRedirectUrl(), 'http://localhost:8766/callback');
  });

  test('cleans up without error when no server running', async () => {
    const handler = new CLIFlowHandler();
    await handler.cleanup();
    // Should complete without throwing
    assert.ok(true);
  });
});

describe('createCLIOAuthProvider', () => {
  test('creates provider with default options', () => {
    const agent = {
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
    };

    const provider = createCLIOAuthProvider(agent);

    assert.strictEqual(provider.getAgentId(), 'test');
    assert.strictEqual(provider.redirectUrl, 'http://localhost:8766/callback');
  });

  test('creates provider with custom port', () => {
    const agent = {
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
    };

    const provider = createCLIOAuthProvider(agent, { callbackPort: 9999 });

    assert.strictEqual(provider.redirectUrl, 'http://localhost:9999/callback');
  });

  test('creates provider with custom client metadata', () => {
    const agent = {
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
    };

    const provider = createCLIOAuthProvider(agent, {
      clientMetadata: { client_name: 'Custom Client' },
    });

    assert.strictEqual(provider.clientMetadata.client_name, 'Custom Client');
  });
});

describe('discoverOAuthMetadata', () => {
  const validMetadata = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
  };

  function mockFetch(urlToResponse) {
    return async url => {
      const entry = urlToResponse[url];
      if (!entry) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => entry };
    };
  }

  test('root URL discovers at /.well-known/oauth-authorization-server', async () => {
    let fetchedUrl;
    const metadata = await discoverOAuthMetadata('https://example.com', {
      fetch: async url => {
        fetchedUrl = url;
        return { ok: true, json: async () => validMetadata };
      },
    });
    assert.strictEqual(fetchedUrl, 'https://example.com/.well-known/oauth-authorization-server');
    assert.deepStrictEqual(metadata, validMetadata);
  });

  test('path URL tries path-aware discovery first', async () => {
    const fetched = [];
    const metadata = await discoverOAuthMetadata('https://example.com/mcp', {
      fetch: async url => {
        fetched.push(url);
        if (url === 'https://example.com/.well-known/oauth-authorization-server/mcp') {
          return { ok: true, json: async () => validMetadata };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    assert.deepStrictEqual(metadata, validMetadata);
    assert.strictEqual(fetched.length, 1);
    assert.strictEqual(fetched[0], 'https://example.com/.well-known/oauth-authorization-server/mcp');
  });

  test('path URL falls back to root when path-aware returns 404', async () => {
    const metadata = await discoverOAuthMetadata('https://example.com/mcp', {
      fetch: mockFetch({
        'https://example.com/.well-known/oauth-authorization-server': validMetadata,
      }),
    });
    assert.deepStrictEqual(metadata, validMetadata);
  });

  test('trailing slash is stripped from path', async () => {
    const metadata = await discoverOAuthMetadata('https://example.com/mcp/', {
      fetch: mockFetch({
        'https://example.com/.well-known/oauth-authorization-server/mcp': validMetadata,
      }),
    });
    assert.deepStrictEqual(metadata, validMetadata);
  });

  test('returns null when no endpoint responds', async () => {
    const metadata = await discoverOAuthMetadata('https://example.com/mcp', {
      fetch: mockFetch({}),
    });
    assert.strictEqual(metadata, null);
  });

  test('returns null when metadata lacks required fields', async () => {
    const metadata = await discoverOAuthMetadata('https://example.com', {
      fetch: async () => ({
        ok: true,
        json: async () => ({ issuer: 'https://example.com' }),
      }),
    });
    assert.strictEqual(metadata, null);
  });

  test('falls back to root when path-aware URL returns malformed JSON', async () => {
    const metadata = await discoverOAuthMetadata('https://example.com/mcp', {
      fetch: async url => {
        if (url === 'https://example.com/.well-known/oauth-authorization-server/mcp') {
          return { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } };
        }
        return { ok: true, json: async () => validMetadata };
      },
    });
    assert.deepStrictEqual(metadata, validMetadata);
  });

  test('returns null for network errors', async () => {
    const metadata = await discoverOAuthMetadata('https://example.com', {
      fetch: async () => {
        throw new Error('network error');
      },
    });
    assert.strictEqual(metadata, null);
  });
});

describe('DEFAULT_CLIENT_METADATA', () => {
  test('has required fields', () => {
    assert.strictEqual(DEFAULT_CLIENT_METADATA.client_name, 'ADCP Client');
    assert.ok(DEFAULT_CLIENT_METADATA.redirect_uris.includes('http://localhost:8766/callback'));
    assert.ok(DEFAULT_CLIENT_METADATA.grant_types.includes('authorization_code'));
    assert.ok(DEFAULT_CLIENT_METADATA.grant_types.includes('refresh_token'));
    assert.ok(DEFAULT_CLIENT_METADATA.response_types.includes('code'));
    assert.strictEqual(DEFAULT_CLIENT_METADATA.token_endpoint_auth_method, 'none');
  });
});
