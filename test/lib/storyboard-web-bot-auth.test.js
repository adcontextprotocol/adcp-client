process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createStoryboardWebBotAuthFetch } = require('@adcp/sdk/testing');
const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
const {
  createSignedSignatureDirectory,
  SignatureDirectoryResolver,
  verifyWebBotAuth,
} = require('../../dist/lib/signing/web-bot-auth');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');

function key() {
  return { privateKey: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) };
}
const publicUrl = 'https://seller.example.com/sales/mcp';
const origin = 'https://buyer.agency.com';

async function directoryFor(identities) {
  const proofs = new Map();
  for (const identity of Object.values(identities)) {
    proofs.set(identity.origin, await createSignedSignatureDirectory(identity.origin, [identity.key]));
  }
  return new SignatureDirectoryResolver({
    fetchOptions: {
      trustedFetchFn: async url => {
        const proof = proofs.get(new URL(url).origin);
        return new Response(proof.body, { headers: proof.headers });
      },
    },
  });
}

test('test delivery signs the exact public target and body while routing to loopback', async () => {
  const signingKey = key();
  const directory = await directoryFor({ buyer: { origin, key: signingKey } });
  let calls = 0;
  const signedFetch = createStoryboardWebBotAuthFetch(
    async (url, init) => {
      calls++;
      assert.equal(String(url), 'http://127.0.0.1:3001/mcp?tenant=a');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.body, '{"literal":"é"}');
      const signers = await verifyWebBotAuth(
        {
          method: init.method,
          url: `${publicUrl}?tenant=a`,
          headers: init.headers,
          body: init.body,
        },
        { directory, replayStore: new InMemoryReplayStore() }
      );
      assert.equal(signers[0].origin, origin);
      await assert.rejects(
        verifyWebBotAuth(
          {
            method: init.method,
            url: 'https://other.example.com/sales/mcp?tenant=a',
            headers: init.headers,
            body: init.body,
          },
          { directory, replayStore: new InMemoryReplayStore() }
        )
      );
      return new Response('{}');
    },
    signingKey,
    { origin, target: { publicUrl, loopbackUrl: 'http://127.0.0.1:3001/mcp' } }
  );
  await signedFetch('http://127.0.0.1:3001/mcp?tenant=a', { method: 'POST', body: '{"literal":"é"}' });
  assert.equal(calls, 1);
  for (const url of ['http://localhost:3001/mcp', 'http://127.0.0.1:3001/elsewhere', 'https://elsewhere.example/mcp']) {
    await assert.rejects(signedFetch(url), /different loopback endpoint/);
  }
  assert.equal(calls, 1);
  for (const loopbackUrl of ['http://192.168.1.2/mcp', 'http://127.0.0.1.evil.com/mcp', 'http://user@localhost/mcp']) {
    assert.throws(
      () =>
        createStoryboardWebBotAuthFetch(fetch, signingKey, {
          origin,
          target: { publicUrl, loopbackUrl },
        }),
      /loopback URL/
    );
  }
  assert.throws(
    () =>
      createStoryboardWebBotAuthFetch(fetch, signingKey, {
        origin,
        target: { publicUrl: 'http://seller.example.com/mcp', loopbackUrl: 'http://localhost/mcp' },
      }),
    /public HTTPS URL/
  );
});

test('storyboard steps use separate WBA identities through the official MCP client and strip ambient credentials', async t => {
  const identities = {
    authorized: { origin, key: key() },
    impersonator: { origin: 'https://other.agency.com', key: key() },
  };
  const directory = await directoryFor(identities);
  const replayStore = new InMemoryReplayStore();
  const seen = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      let signer;
      if (req.headers['signature-input']) {
        [signer] = await verifyWebBotAuth(
          { method: req.method, url: publicUrl, headers: req.headers, body: rawBody },
          { directory, replayStore }
        );
      }
      const mcp = new McpServer({ name: 'WBA test seller', version: '1.0.0' });
      mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
        const payload = {
          adcp: { major_versions: [3], supported_versions: ['3.2'] },
          supported_protocols: ['media_buy'],
          request_signing: {
            supported: true,
            profiles: ['web-bot-auth'],
            covers_content_digest: 'required',
            required_for: [],
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      });
      mcp.registerTool('get_products', { inputSchema: {} }, async () => {
        seen.push({
          origin: signer?.origin,
          authorization: req.headers.authorization,
          apiKey: req.headers['x-api-key'],
        });
        const denied = signer?.origin !== origin;
        const payload = denied
          ? { adcp_error: { code: 'PERMISSION_DENIED', message: 'Caller is not authorized', recovery: 'terminal' } }
          : { products: [], sandbox: true, status: 'completed' };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(denied && { isError: true }),
        };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on('close', () => mcp.close());
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  const storyboard = {
    id: 'wba-step-identities',
    title: 'WBA step identities',
    version: '1.0.0',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p',
        title: 'Identities',
        steps: ['authorized', 'impersonator', 'missing'].map(identity => ({
          id: identity,
          task: 'get_products',
          title: identity,
          auth: { type: 'web_bot_auth', identity },
          sample_request: { buying_mode: 'brief', brief: 'Test inventory' },
          ...(identity === 'impersonator' && { expect_error: true, negative_path: 'payload_well_formed' }),
          validations: identity === 'impersonator' ? [{ check: 'error_code', value: 'PERMISSION_DENIED' }] : [],
        })),
      },
    ],
  };
  const options = {
    protocol: 'mcp',
    adcpVersion: '3.2.7',
    allow_http: true,
    strictResponseSchemaValidation: false,
    auth: { type: 'bearer', token: 'ambient-secret' },
    headers: { 'x-api-key': 'ambient-api-key' },
    agentTools: ['get_products'],
    _profile: { name: 'WBA', tools: ['get_products'] },
    _client: { getAgentInfo: async () => ({ name: 'WBA', tools: [{ name: 'get_products' }] }) },
    web_bot_auth: { identities: { ...identities, unused_invalid_key: { origin, key: { privateKey: {} } } }, publicUrl },
  };
  for (const identity of ['authorized', 'impersonator']) {
    const result = await runStoryboardStep(agentUrl, storyboard, identity, options);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes(identities[identity].key.privateKey.d));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, [
    { origin, authorization: undefined, apiKey: undefined },
    { origin: identities.impersonator.origin, authorization: undefined, apiKey: undefined },
  ]);
  const missing = await runStoryboardStep(agentUrl, storyboard, 'missing', options);
  assert.equal(missing.passed, false);
  assert.match(missing.error, /identity is not configured/);
  const noPublicUrl = await runStoryboardStep(agentUrl, storyboard, 'authorized', {
    ...options,
    web_bot_auth: { identities },
  });
  assert.equal(noPublicUrl.passed, false);
  assert.match(noPublicUrl.error, /publicUrl is required/);
  const a2a = await runStoryboardStep(agentUrl, storyboard, 'authorized', { ...options, protocol: 'a2a' });
  assert.equal(a2a.passed, false);
  assert.match(a2a.error, /MCP only/);
  const sessionProbe = structuredClone(storyboard);
  sessionProbe.phases[0].steps[0].task = 'mcp_session_probe';
  const session = await runStoryboardStep(agentUrl, sessionProbe, 'authorized', options);
  assert.equal(session.passed, false);
  assert.match(session.error, /not supported by MCP session probes/);
  assert.equal(seen.length, 2);
});

test('direct HTTPS signing refuses transport-followed cross-origin redirects before re-signing', async () => {
  const { createAgentTransportFetch } = require('../../dist/lib/net/agent-transport-fetch');
  const targets = [];
  const signed = createStoryboardWebBotAuthFetch(
    async (url, init) => {
      targets.push(String(url));
      assert.ok(new Headers(init.headers).has('signature'));
      return new Response(null, { status: 307, headers: { location: 'https://victim.example.com/mcp' } });
    },
    key(),
    { origin, agentUrl: publicUrl }
  );
  // This is the same outer/inner composition used by the official transport.
  const transport = createAgentTransportFetch(publicUrl, { trustedFetchFn: signed });
  await assert.rejects(
    transport(publicUrl, { method: 'POST', body: '{"operation":"test"}' }),
    /do not follow HTTP redirects/
  );
  await assert.rejects(signed('https://victim.example.com/mcp'), /different agent origin/);
  assert.deepEqual(targets, [publicUrl]);
});
