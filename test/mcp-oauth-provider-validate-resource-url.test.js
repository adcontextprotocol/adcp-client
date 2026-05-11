const { describe, it } = require('node:test');
const assert = require('node:assert');

const { MCPOAuthProvider } = require('../dist/lib/auth/oauth/index.js');

function makeProvider(allowHttp = false) {
  // Minimal stub for OAuthFlowHandler
  const flowHandler = {
    getRedirectUrl: () => 'http://localhost:8766/callback',
    redirectToAuthorization: async () => {},
    waitForCallback: async () => 'code',
    cleanup: async () => {},
  };
  return new MCPOAuthProvider({
    agent: { id: 'test', name: 'Test', agent_uri: 'https://example.com/mcp', protocol: 'mcp' },
    flowHandler,
    clientMetadata: {
      client_name: 'Test',
      redirect_uris: ['http://localhost:8766/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    allowHttp,
  });
}

describe('MCPOAuthProvider.validateResourceURL', () => {
  it('returns undefined when resource is absent', async () => {
    const provider = makeProvider();
    assert.strictEqual(await provider.validateResourceURL('https://agent.example.com/mcp'), undefined);
    assert.strictEqual(await provider.validateResourceURL('https://agent.example.com/mcp', undefined), undefined);
  });

  it('accepts HTTPS resource URLs', async () => {
    const provider = makeProvider();
    const url = await provider.validateResourceURL('https://agent.example.com/mcp', 'https://agent.example.com');
    assert.strictEqual(url?.href, 'https://agent.example.com/');
  });

  it('accepts http://localhost resource URLs without allowHttp (loopback carve-out)', async () => {
    const provider = makeProvider(false);
    const url = await provider.validateResourceURL('http://localhost:3000/figma/mcp', 'http://localhost:3000/figma');
    assert.strictEqual(url?.hostname, 'localhost');
  });

  it('accepts http://127.0.0.1 resource URLs without allowHttp (loopback carve-out)', async () => {
    const provider = makeProvider(false);
    const url = await provider.validateResourceURL('http://127.0.0.1:3000/mcp', 'http://127.0.0.1:3000');
    assert.strictEqual(url?.hostname, '127.0.0.1');
  });

  it('accepts http://[::1] resource URLs without allowHttp (loopback carve-out)', async () => {
    const provider = makeProvider(false);
    const url = await provider.validateResourceURL('http://[::1]:3000/mcp', 'http://[::1]:3000');
    assert.strictEqual(url?.hostname, '[::1]');
  });

  it('rejects non-loopback HTTP resource URLs when allowHttp is false', async () => {
    const provider = makeProvider(false);
    await assert.rejects(
      () => provider.validateResourceURL('http://internal.example.com/mcp', 'http://internal.example.com'),
      err => err.message.includes('non-HTTPS resource URL')
    );
  });

  it('error message for non-loopback HTTP mentions --allow-http flag', async () => {
    const provider = makeProvider(false);
    await assert.rejects(
      () => provider.validateResourceURL('http://dev.internal/mcp', 'http://dev.internal'),
      err => err.message.includes('--allow-http')
    );
  });

  it('accepts non-loopback HTTP resource URLs when allowHttp is true', async () => {
    const provider = makeProvider(true);
    const url = await provider.validateResourceURL('http://dev.internal/mcp', 'http://dev.internal/figma');
    assert.strictEqual(url?.hostname, 'dev.internal');
  });

  it('does not treat localhost.attacker.com as loopback', async () => {
    const provider = makeProvider(false);
    await assert.rejects(
      () => provider.validateResourceURL('http://localhost.attacker.com/mcp', 'http://localhost.attacker.com'),
      err => err.message.includes('non-HTTPS resource URL')
    );
  });
});
