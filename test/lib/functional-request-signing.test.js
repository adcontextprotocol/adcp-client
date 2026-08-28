const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const {
  createTestClient,
  getOrCreateClientResolution,
  getOrDiscoverProfile,
  seedTestClientSigningCapability,
} = require('../../dist/lib/testing/client.js');
const {
  applyFunctionalRequestSigning,
} = require('../../dist/lib/testing/storyboard/request-signing/functional-dispatch.js');
const { buildAgentSigningContext } = require('../../dist/lib/signing/client.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { defaultCapabilityCache } = require('../../dist/lib/signing/client.js');
const {
  verifyRequestSignature,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../../dist/lib/signing/server.js');

const generatedKeyPair = generateKeyPairSync('ed25519');
const generatedPublicJwk = generatedKeyPair.publicKey.export({ format: 'jwk' });
const generatedPrivateJwk = generatedKeyPair.privateKey.export({ format: 'jwk' });

const tempDirs = new Set();

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function writeComplianceBundle({
  functionalDispatch = true,
  endpointScope = 'sandbox',
  bootstrapOperations = '[get_adcp_capabilities]',
  signSupportedFor = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-functional-signing-'));
  tempDirs.add(dir);
  fs.mkdirSync(path.join(dir, 'test-kits'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test-vectors', 'request-signing'), { recursive: true });
  const dispatch = functionalDispatch
    ? `
functional_dispatch:
  signing_keyid: test-ed25519-2026
  signer_agent_url: https://compliance-runner.example
  operation_selection:
    capability_path: request_signing
    sign_required_for: true
    sign_supported_for: ${signSupportedFor}
  content_digest_policy_source: request_signing.covers_content_digest
  preserve_transport_auth: true
  fresh_signature_per_dispatch: true
  bootstrap_operations_unsigned: ${bootstrapOperations}
  unavailable_behavior: not_applicable
`
    : '';
  fs.writeFileSync(
    path.join(dir, 'test-kits', 'signed-requests-runner.yaml'),
    `id: signed_requests_runner
endpoint_scope: ${endpointScope}
harness_mode: black_box
runner_signing_keys:
  - keyid: test-ed25519-2026
    alg: ed25519
${dispatch}
stateful_vector_contract:
  replay_window:
    vector_id: replay
    black_box_behavior: repeat_request
    max_interval_seconds: 5
    min_replay_ttl_seconds: 10
  revocation:
    vector_id: revoked
    pre_revoked_keyid: test-revoked-2026
  rate_abuse:
    vector_id: abuse
    grading_target_per_keyid_cap_requests: 100
    production_min_per_keyid_cap_requests: 1000000
    window_seconds: 60
`
  );
  fs.writeFileSync(
    path.join(dir, 'test-vectors', 'request-signing', 'keys.json'),
    JSON.stringify({
      keys: [
        {
          kid: 'test-ed25519-2026',
          kty: 'OKP',
          crv: 'Ed25519',
          alg: 'EdDSA',
          use: 'sig',
          key_ops: ['verify'],
          adcp_use: 'request-signing',
          x: generatedPublicJwk.x,
          _private_d_for_test_only: generatedPrivateJwk.d,
        },
      ],
    })
  );
  return dir;
}

function mcpResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

async function startSigningCaptureSeller() {
  const toolRequests = [];
  const server = http.createServer(async (req, res) => {
    const requestBodyChunks = [];
    for await (const chunk of req) requestBodyChunks.push(chunk);
    const requestBody = Buffer.concat(requestBodyChunks).toString('utf8');
    const parsedBody = requestBody ? JSON.parse(requestBody) : undefined;
    const requestHeaders = { ...req.headers };
    const capturedRequest = tool => ({
      tool,
      method: req.method,
      url: `http://${req.headers.host}${req.url}`,
      headers: requestHeaders,
      body: requestBody,
    });
    const mcp = new McpServer({ name: 'functional-signing-capture', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
      toolRequests.push(capturedRequest('get_adcp_capabilities'));
      return mcpResult({
        adcp: {
          major_versions: [3],
          supported_versions: ['3.2.0-beta.9'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: ['sales-non-guaranteed'],
        request_signing: {
          supported: true,
          required_for: [],
          supported_for: ['get_products'],
          covers_content_digest: 'required',
        },
      });
    });
    mcp.registerTool('get_products', { inputSchema: {} }, async () => {
      toolRequests.push(capturedRequest('get_products'));
      return mcpResult({ products: [] });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await mcp.close();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    toolRequests,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

describe('functional request signing', () => {
  test('loads the public compliance signer only for sandbox functional dispatch', () => {
    const complianceDir = writeComplianceBundle();
    const options = applyFunctionalRequestSigning(
      { sandbox: true, auth: { type: 'bearer', token: 'preserved-token' } },
      { complianceDir }
    );

    assert.deepStrictEqual(options.auth, { type: 'bearer', token: 'preserved-token' });
    assert.strictEqual(options.functional_request_signing.kind, 'inline');
    assert.strictEqual(options.functional_request_signing.kid, 'test-ed25519-2026');
    assert.strictEqual(options.functional_request_signing.alg, 'ed25519');
    assert.strictEqual(options.functional_request_signing.agent_url, 'https://compliance-runner.example');
    assert.strictEqual(options.functional_request_signing.sign_supported, true);
    assert.strictEqual(options.functional_request_signing.private_key.d, generatedPrivateJwk.d);

    const client = createTestClient('https://seller.example/mcp', 'mcp', options);
    assert.strictEqual(client.getAgent().request_signing, options.functional_request_signing);
  });

  test('signs ordinary MCP dispatches with fresh signatures while preserving transport auth', async t => {
    const complianceDir = writeComplianceBundle();
    const seller = await startSigningCaptureSeller();
    t.after(async () => {
      await closeMCPConnections();
      defaultCapabilityCache.clear();
      await seller.close();
    });
    const options = applyFunctionalRequestSigning(
      {
        sandbox: true,
        auth: { type: 'bearer', token: 'preserved-transport-token' },
        headers: { 'x-adcp-tenant': 'tenant-a' },
      },
      { complianceDir }
    );
    const client = createTestClient(seller.url, 'mcp', options);
    const agent = client.getAgent();

    await ProtocolClient.callTool(agent, 'get_products', { brief: 'first', buying_mode: 'brief' });
    await ProtocolClient.callTool(agent, 'get_products', { brief: 'second', buying_mode: 'brief' });

    const bootstrap = seller.toolRequests.filter(entry => entry.tool === 'get_adcp_capabilities');
    const functional = seller.toolRequests.filter(entry => entry.tool === 'get_products');
    assert.ok(bootstrap.length >= 1, 'capability bootstrap should be observed');
    assert.ok(bootstrap.every(entry => entry.headers['signature-input'] === undefined));
    assert.strictEqual(functional.length, 2);
    for (const entry of functional) {
      assert.ok(entry.headers['signature-input'], 'functional request must include Signature-Input');
      assert.ok(entry.headers.signature, 'functional request must include Signature');
      assert.strictEqual(entry.headers.authorization, 'Bearer preserved-transport-token');
      assert.strictEqual(entry.headers['x-adcp-auth'], 'preserved-transport-token');
      assert.strictEqual(entry.headers['x-adcp-tenant'], 'tenant-a');
    }
    const nonces = functional.map(entry => entry.headers['signature-input'].match(/;nonce="([^"]+)"/)?.[1]);
    assert.ok(nonces.every(Boolean), 'each signature must carry a nonce');
    assert.notStrictEqual(nonces[0], nonces[1], 'each dispatch must mint a fresh signature nonce');

    const replayStore = new InMemoryReplayStore();
    const jwks = new StaticJwksResolver([
      {
        kid: options.functional_request_signing.kid,
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        use: 'sig',
        key_ops: ['verify'],
        adcp_use: 'request-signing',
        x: generatedPublicJwk.x,
      },
    ]);
    for (const entry of functional) {
      const verified = await verifyRequestSignature(entry, {
        capability: {
          supported: true,
          required_for: [],
          supported_for: ['get_products'],
          covers_content_digest: 'required',
        },
        jwks,
        replayStore,
        revocationStore: new InMemoryRevocationStore(),
        operation: 'get_products',
        adcpVersion: '3.2.0-beta.9',
      });
      assert.strictEqual(verified.status, 'verified');
      assert.strictEqual(verified.keyid, options.functional_request_signing.kid);
    }
  });

  test('never auto-loads the public test key outside the sandbox boundary', () => {
    const complianceDir = writeComplianceBundle();
    const production = { sandbox: false };
    const disabled = { sandbox: true, disable_sandbox: true };

    assert.strictEqual(applyFunctionalRequestSigning(production, { complianceDir }), production);
    assert.strictEqual(applyFunctionalRequestSigning(disabled, { complianceDir }), disabled);
  });

  test('preserves an operator-supplied signer without reading the compliance key', () => {
    const supplied = {
      kind: 'provider',
      provider: {
        keyid: 'operator-key',
        algorithm: 'ed25519',
        fingerprint: 'operator-controlled',
        sign: async () => new Uint8Array(),
      },
    };
    const options = { sandbox: false, functional_request_signing: supplied };
    assert.strictEqual(applyFunctionalRequestSigning(options), options);
    assert.strictEqual(options.functional_request_signing, supplied);
  });

  test('applies functional supported-operation policy to an operator-supplied sandbox signer', () => {
    const complianceDir = writeComplianceBundle();
    const supplied = {
      kind: 'provider',
      provider: {
        keyid: 'operator-key',
        algorithm: 'ed25519',
        fingerprint: 'operator-controlled',
        sign: async () => new Uint8Array(),
      },
      agent_url: 'https://operator.example',
    };
    const options = applyFunctionalRequestSigning(
      { sandbox: true, functional_request_signing: supplied },
      { complianceDir }
    );

    assert.strictEqual(options.functional_request_signing.provider, supplied.provider);
    assert.strictEqual(options.functional_request_signing.sign_supported, true);
  });

  test('rejects an operator signer that would sign unsigned bootstrap discovery', () => {
    const complianceDir = writeComplianceBundle();
    assert.throws(
      () =>
        applyFunctionalRequestSigning(
          {
            sandbox: true,
            functional_request_signing: {
              kind: 'provider',
              provider: {
                keyid: 'operator-key',
                algorithm: 'ed25519',
                fingerprint: 'operator-controlled',
                sign: async () => new Uint8Array(),
              },
              agent_url: 'https://operator.example',
              always_sign: ['get_adcp_capabilities'],
            },
          },
          { complianceDir }
        ),
      /requires unsigned bootstrap discovery/
    );
  });

  test('keeps the beta.9 not-applicable compatibility path for an older bundle', () => {
    const complianceDir = writeComplianceBundle({ functionalDispatch: false });
    const options = { sandbox: true };
    assert.strictEqual(applyFunctionalRequestSigning(options, { complianceDir }), options);
  });

  test('fails closed when a functional signer contract is not sandbox-scoped', () => {
    const complianceDir = writeComplianceBundle({ endpointScope: 'production' });
    assert.throws(
      () => applyFunctionalRequestSigning({ sandbox: true }, { complianceDir }),
      /endpoint_scope must be "sandbox"/
    );
  });

  test('fails closed when the contract asks the runner to leave functional operations unsigned', () => {
    const complianceDir = writeComplianceBundle({
      bootstrapOperations: '[get_adcp_capabilities, create_media_buy]',
    });
    assert.throws(
      () => applyFunctionalRequestSigning({ sandbox: true }, { complianceDir }),
      /supports only unsigned bootstrap discovery/
    );
  });

  test('fails closed when the contract disables signing supported operations', () => {
    const complianceDir = writeComplianceBundle({ signSupportedFor: false });
    assert.throws(
      () => applyFunctionalRequestSigning({ sandbox: true }, { complianceDir }),
      /must enable sign_supported_for/
    );
  });

  test('does not reuse a shared client configured with a different signer', () => {
    const complianceDir = writeComplianceBundle();
    const signedOptions = applyFunctionalRequestSigning({ sandbox: true }, { complianceDir });
    const shared = createTestClient('https://seller.example/mcp', 'mcp', signedOptions);

    assert.strictEqual(
      getOrCreateClientResolution('https://seller.example/mcp', { ...signedOptions, _client: shared }).reusedShared,
      true
    );
    assert.strictEqual(
      getOrCreateClientResolution('https://seller.example/mcp', {
        ...signedOptions,
        functional_request_signing: {
          ...signedOptions.functional_request_signing,
          private_key: { ...signedOptions.functional_request_signing.private_key, d: 'different-private-scalar' },
        },
        _client: shared,
      }).reusedShared,
      false
    );
    assert.strictEqual(
      getOrCreateClientResolution('https://seller.example/mcp', {
        ...signedOptions,
        functional_request_signing: {
          ...signedOptions.functional_request_signing,
          sign_supported: false,
        },
        _client: shared,
      }).reusedShared,
      false,
      'operation-selection overrides participate in shared-client identity'
    );
  });

  test('does not reuse a metadata-less client when functional signing is required', () => {
    const complianceDir = writeComplianceBundle();
    const signedOptions = applyFunctionalRequestSigning({ sandbox: true }, { complianceDir });
    const metadataLessClient = { executeTask: async () => ({ success: true }) };

    assert.strictEqual(
      getOrCreateClientResolution('https://seller.example/mcp', {
        ...signedOptions,
        _client: metadataLessClient,
      }).reusedShared,
      false
    );
  });

  test('cached profiles remain usable with lightweight metadata-less client stubs', async () => {
    const profile = {
      name: 'Stubbed seller',
      tools: ['get_products'],
      raw_capabilities: { request_signing: { supported: true, required_for: ['get_products'] } },
    };
    const clientStub = { executeTask: async () => ({ success: true }) };

    const discovered = await getOrDiscoverProfile(clientStub, { _profile: profile });

    assert.strictEqual(discovered.profile, profile);
    assert.strictEqual(discovered.step.passed, true);
  });

  test('isolates shared clients by endpoint, protocol, credentials, and routing headers', () => {
    const complianceDir = writeComplianceBundle();
    const signedOptions = applyFunctionalRequestSigning(
      {
        sandbox: true,
        auth: { type: 'bearer', token: 'tenant-a-token' },
        headers: { 'x-adcp-tenant': 'tenant-a' },
      },
      { complianceDir }
    );
    const shared = createTestClient('https://seller-a.example/mcp', 'mcp', signedOptions);
    const reuse = overrides =>
      getOrCreateClientResolution(overrides.agentUrl ?? 'https://seller-a.example/mcp', {
        ...signedOptions,
        ...overrides.options,
        _client: shared,
      }).reusedShared;

    assert.strictEqual(reuse({}), true);
    assert.strictEqual(reuse({ agentUrl: 'https://seller-b.example/mcp' }), false);
    assert.strictEqual(reuse({ options: { protocol: 'a2a' } }), false);
    assert.strictEqual(reuse({ options: { auth: { type: 'bearer', token: 'tenant-b-token' } } }), false);
    assert.strictEqual(reuse({ options: { headers: { 'x-adcp-tenant': 'tenant-b' } } }), false);
  });

  test('isolates signing capability cache entries by effective principal and routing headers', () => {
    const complianceDir = writeComplianceBundle();
    const signing = applyFunctionalRequestSigning({ sandbox: true }, { complianceDir }).functional_request_signing;
    const contextFor = agent =>
      buildAgentSigningContext({
        id: 'test',
        name: 'Test',
        agent_uri: 'https://seller.example/mcp',
        protocol: 'mcp',
        request_signing: signing,
        ...agent,
      });

    const anonymous = contextFor({});
    const bearerA = contextFor({ auth_token: 'bearer-a' });
    const bearerB = contextFor({ auth_token: 'bearer-b' });
    const basicA = contextFor({
      headers: { Authorization: `Basic ${Buffer.from('tenant-a:pass').toString('base64')}` },
    });
    const basicB = contextFor({
      headers: { Authorization: `Basic ${Buffer.from('tenant-b:pass').toString('base64')}` },
    });
    const oauthA = contextFor({ oauth_tokens: { access_token: 'oauth-a', token_type: 'Bearer' } });
    const oauthB = contextFor({ oauth_tokens: { access_token: 'oauth-b', token_type: 'Bearer' } });
    const oauthClientA = contextFor({
      oauth_client: { client_id: 'oauth-client-a', client_secret: 'oauth-client-secret-a' },
    });
    const oauthClientB = contextFor({
      oauth_client: { client_id: 'oauth-client-b', client_secret: 'oauth-client-secret-b' },
    });
    const oauthClientSecretRotation = contextFor({
      oauth_client: { client_id: 'oauth-client-a', client_secret: 'oauth-client-secret-rotated' },
    });
    const oauthResourceA = contextFor({
      oauth_client: { client_id: 'oauth-client-a' },
      oauth_resource: 'https://seller.example/tenant-a',
    });
    const oauthResourceB = contextFor({
      oauth_client: { client_id: 'oauth-client-a' },
      oauth_resource: 'https://seller.example/tenant-b',
    });
    const clientCredentialsFor = overrides =>
      contextFor({
        oauth_client_credentials: {
          token_endpoint: 'https://auth.example/token',
          client_id: 'machine-client-a',
          client_secret: 'machine-client-secret-a',
          scope: 'adcp',
          resource: 'https://seller.example/mcp',
          audience: 'seller-a',
          ...overrides,
        },
      });
    const clientCredentialsA = clientCredentialsFor({});
    const clientCredentialsB = clientCredentialsFor({ client_id: 'machine-client-b' });
    const clientCredentialsEndpointB = clientCredentialsFor({ token_endpoint: 'https://auth-b.example/token' });
    const clientCredentialsScopeB = clientCredentialsFor({ scope: 'adcp:write' });
    const clientCredentialsResourceB = clientCredentialsFor({ resource: 'https://seller.example/tenant-b' });
    const clientCredentialsAudienceB = clientCredentialsFor({ audience: 'seller-b' });
    const clientCredentialsSecretRotation = clientCredentialsFor({
      client_secret: 'machine-client-secret-rotated',
    });
    const clientCredentialsAuthMethod = clientCredentialsFor({ auth_method: 'body' });
    const routedA = contextFor({ headers: { 'x-adcp-tenant': 'tenant-a' } });
    const routedB = contextFor({ headers: { 'x-adcp-tenant': 'tenant-b' } });

    assert.notStrictEqual(anonymous.capabilityCacheKey, bearerA.capabilityCacheKey);
    assert.notStrictEqual(bearerA.capabilityCacheKey, bearerB.capabilityCacheKey);
    assert.notStrictEqual(anonymous.capabilityCacheKey, basicA.capabilityCacheKey);
    assert.notStrictEqual(basicA.capabilityCacheKey, basicB.capabilityCacheKey);
    assert.notStrictEqual(oauthA.capabilityCacheKey, oauthB.capabilityCacheKey);
    assert.notStrictEqual(oauthClientA.capabilityCacheKey, oauthClientB.capabilityCacheKey);
    assert.strictEqual(oauthClientA.capabilityCacheKey, oauthClientSecretRotation.capabilityCacheKey);
    assert.notStrictEqual(oauthResourceA.capabilityCacheKey, oauthResourceB.capabilityCacheKey);
    assert.notStrictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsB.capabilityCacheKey);
    assert.notStrictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsEndpointB.capabilityCacheKey);
    assert.notStrictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsScopeB.capabilityCacheKey);
    assert.notStrictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsResourceB.capabilityCacheKey);
    assert.notStrictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsAudienceB.capabilityCacheKey);
    assert.strictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsSecretRotation.capabilityCacheKey);
    assert.strictEqual(clientCredentialsA.capabilityCacheKey, clientCredentialsAuthMethod.capabilityCacheKey);
    assert.doesNotMatch(clientCredentialsA.capabilityCacheKey, /machine-client-secret-a/);
    assert.notStrictEqual(routedA.capabilityCacheKey, routedB.capabilityCacheKey);
  });

  test('seeds discovered signing capabilities under the effective wire version', async () => {
    const complianceDir = writeComplianceBundle();
    const options = applyFunctionalRequestSigning(
      {
        sandbox: true,
        adcpVersion: '3.2.0-beta.9',
        wireAdcpVersion: '3.1.0',
        _profile: {
          name: 'Versioned seller',
          tools: ['get_adcp_capabilities', 'get_products'],
          raw_capabilities: {
            request_signing: {
              supported: true,
              required_for: ['get_products'],
              supported_for: [],
            },
          },
        },
      },
      { complianceDir }
    );
    const client = createTestClient('https://seller.example/mcp', 'mcp', options);

    await getOrDiscoverProfile(client, options);

    const wireContext = buildAgentSigningContext(client.getAgent(), { adcpVersion: '3.1.0' });
    const schemaContext = buildAgentSigningContext(client.getAgent(), { adcpVersion: '3.2.0-beta.9' });
    assert.deepStrictEqual(wireContext.cache.get(wireContext.capabilityCacheKey)?.requestSigning, {
      supported: true,
      required_for: ['get_products'],
      supported_for: [],
    });
    assert.strictEqual(schemaContext.cache.get(schemaContext.capabilityCacheKey), undefined);
  });

  test('selected client version wins over a discovery-schema fallback when seeding', () => {
    const complianceDir = writeComplianceBundle();
    const options = applyFunctionalRequestSigning({ sandbox: true, adcpVersion: '3.1.0' }, { complianceDir });
    const client = createTestClient('https://pinned-seller.example/mcp', 'mcp', options);
    const profile = {
      name: 'Pinned seller',
      tools: ['get_adcp_capabilities', 'get_products'],
      raw_capabilities: {
        request_signing: { supported: true, required_for: ['get_products'], supported_for: [] },
      },
    };

    seedTestClientSigningCapability(client, profile, '3.2.0-beta.9');

    const pinnedContext = buildAgentSigningContext(client.getAgent(), { adcpVersion: '3.1.0' });
    const fallbackContext = buildAgentSigningContext(client.getAgent(), { adcpVersion: '3.2.0-beta.9' });
    assert.deepStrictEqual(pinnedContext.cache.get(pinnedContext.capabilityCacheKey)?.requestSigning, {
      supported: true,
      required_for: ['get_products'],
      supported_for: [],
    });
    assert.strictEqual(fallbackContext.cache.get(fallbackContext.capabilityCacheKey), undefined);
  });
});
