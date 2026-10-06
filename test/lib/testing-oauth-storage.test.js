const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTestClient, getOrCreateClientResolution } = require('../../dist/lib/testing/client.js');
const { getAgentStorage } = require('../../dist/lib/auth/oauth/storage-registry.js');

const agentUrl = 'https://oauth.example/mcp';

function storageAdapter() {
  return {
    async loadAgent() {},
    async saveAgent() {},
  };
}

function options(storage) {
  return {
    auth: {
      type: 'oauth',
      tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
      client: { client_id: 'synthetic-client' },
      ...(storage && { storage }),
    },
  };
}

describe('testing OAuth runtime storage', () => {
  it('binds the selected adapter through normalization without serializing it', () => {
    const storage = storageAdapter();
    storage.toJSON = () => {
      throw new Error('runtime storage must not be serialized');
    };
    storage.self = storage;
    const client = createTestClient(agentUrl, 'mcp', options(storage));
    const agent = client.getAgent();
    assert.equal(getAgentStorage(agent), storage);
    assert.equal(agent.id, 'test');
    const serialized = JSON.parse(JSON.stringify(agent));
    assert.equal('storage' in serialized, false);
    assert.equal('oauthStorage' in serialized, false);
    assert.equal(serialized.oauth_tokens.access_token, 'synthetic-access');
  });

  it('reuses a client only with the same adapter object and matching scope', () => {
    const storage = storageAdapter();
    const original = options(storage);
    const client = createTestClient(agentUrl, 'mcp', original);
    const result = getOrCreateClientResolution(agentUrl, { ...options(storage), _client: client });
    assert.equal(result.reusedShared, true);
    assert.equal(result.client, client);
  });

  it('does not reuse equal-credential clients with a different adapter', () => {
    const first = storageAdapter();
    const second = storageAdapter();
    const client = createTestClient(agentUrl, 'mcp', options(first));
    const result = getOrCreateClientResolution(agentUrl, { ...options(second), _client: client });
    assert.equal(result.reusedShared, false);
    assert.notEqual(result.client, client);
    assert.equal(getAgentStorage(result.client.getAgent()), second);
  });

  it('does not reuse a bound provider when the storage option is omitted', () => {
    const client = createTestClient(agentUrl, 'mcp', options(storageAdapter()));
    const result = getOrCreateClientResolution(agentUrl, { ...options(), _client: client });
    assert.equal(result.reusedShared, false);
    assert.equal(getAgentStorage(result.client.getAgent()), undefined);
  });

  it('does not reuse an unbound client when storage is added', () => {
    const storage = storageAdapter();
    const client = createTestClient(agentUrl, 'mcp', options());
    const result = getOrCreateClientResolution(agentUrl, { ...options(storage), _client: client });
    assert.equal(result.reusedShared, false);
    assert.equal(getAgentStorage(result.client.getAgent()), storage);
  });

  it('refuses a foreign injected client without scope metadata when storage is requested', () => {
    const foreign = { async executeTask() {} };
    const storage = storageAdapter();
    const result = getOrCreateClientResolution(agentUrl, { ...options(storage), _client: foreign });
    assert.equal(result.reusedShared, false);
    assert.notEqual(result.client, foreign);
    assert.equal(getAgentStorage(result.client.getAgent()), storage);
  });

  it('preserves version, credential, response-validation and transport reuse boundaries', () => {
    const storage = storageAdapter();
    const original = {
      ...options(storage),
      adcpVersion: '3.2.1',
      wireAdcpVersion: '3.2',
      versionEnvelope: 'auto',
      transport: { trustedFetchFn: async () => {}, requestTimeoutMs: 10_000 },
    };
    const client = createTestClient(agentUrl, 'mcp', original);
    const changes = [
      { adcpVersion: '3.1.0' },
      { wireAdcpVersion: '3.1' },
      { versionEnvelope: 'major-only' },
      { strictResponseSchemaValidation: false },
      { auth: { ...original.auth, tokens: { ...original.auth.tokens, access_token: 'other-access' } } },
      { auth: { ...original.auth, client: { client_id: 'other-client' } } },
      { transport: { ...original.transport, trustedFetchFn: async () => {} } },
      { transport: { ...original.transport, requestTimeoutMs: 20_000 } },
    ];
    assert.equal(getOrCreateClientResolution(agentUrl, { ...original, _client: client }).reusedShared, true);
    for (const changed of changes) {
      assert.equal(
        getOrCreateClientResolution(agentUrl, { ...original, ...changed, _client: client }).reusedShared,
        false,
        `changed scope: ${Object.keys(changed)}`
      );
    }
  });

  it('keeps the existing unbound OAuth reuse behavior', () => {
    const client = createTestClient(agentUrl, 'mcp', options());
    const result = getOrCreateClientResolution(agentUrl, { ...options(), _client: client });
    assert.equal(result.reusedShared, true);
    assert.equal(getAgentStorage(result.client.getAgent()), undefined);
  });
});
