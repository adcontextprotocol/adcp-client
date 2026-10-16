const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

async function startAgent(t) {
  const requests = [];
  const calls = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const mcp = new McpServer({ name: 'test-kit-mcp', version: '1' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: z.object({}).passthrough() }, async () => {
      const data = {
        adcp: {
          major_versions: [3],
          supported_versions: ['3.2'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        media_buy: { buying_modes: ['brief', 'wholesale'] },
        specialisms: [],
      };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    });
    mcp.registerTool('get_products', { inputSchema: z.object({}).passthrough() }, async params => {
      calls.push(params);
      const data = { products: [], cache_scope: 'public', context: params.context };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    });
    // Use SSE responses from the official server to exercise the official client.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests, calls };
}

function storyboard() {
  return {
    id: 'canonical_formats_test_kit_transport',
    version: '1',
    title: 'Test-kit transport regression #3270',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'discover',
        title: 'Discover',
        steps: [
          {
            id: 'get_seeded_divergent_product',
            title: 'Read a seeded product using the test kit credential',
            task: 'get_products',
            auth: { type: 'api_key', from_test_kit: true },
            sample_request: { buying_mode: 'wholesale', context: { correlation_id: 'kit-product' } },
            validations: [
              {
                check: 'field_value',
                path: 'context.correlation_id',
                value: 'kit-product',
                description: 'Context is echoed',
              },
            ],
          },
        ],
      },
    ],
  };
}

const OPTIONS = {
  protocol: 'mcp',
  allow_http: true,
  auth: { type: 'bearer', token: 'suite-key-must-not-leak' },
  headers: { 'x-adcp-tenant': 'acme', 'X-API-Key': 'stale-key-must-not-leak' },
  test_kit: { auth: { api_key: 'kit-step-key', probe_task: 'list_creatives' } },
  agentTools: ['get_products'],
  _profile: { name: 'test-kit-mcp', tools: ['get_products'] },
  _client: {},
};

test('test-kit functional steps retain MCP, HTTP policy, routing headers, and trusted fetch (#3270)', async t => {
  const { url, requests, calls } = await startAgent(t);
  let fetches = 0;
  const result = await runStoryboard(url, storyboard(), {
    ...OPTIONS,
    transport: {
      trustedFetchFn: (...args) => {
        fetches++;
        return fetch(...args);
      },
    },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.equal(calls.length, 1);
  assert.ok(fetches >= requests.length, 'every request must use the trusted fetch');
  assert.ok(requests.length >= 3, 'MCP initialization and tools/call must reach the server');
  for (const request of requests) {
    assert.equal(request.url, '/mcp', 'MCP must not perform A2A agent-card discovery');
    assert.equal(request.headers.authorization, 'Bearer kit-step-key');
    assert.equal(request.headers['x-adcp-tenant'], 'acme');
    assert.equal(request.headers['x-api-key'], undefined);
    for (const value of Object.values(request.headers)) {
      assert.equal(String(value).includes('suite-key-must-not-leak'), false);
      assert.equal(String(value).includes('stale-key-must-not-leak'), false);
    }
  }
  assert.equal(OPTIONS.auth.token, 'suite-key-must-not-leak', 'step auth must not mutate suite options');
});

for (const allowPrivateIp of [undefined, false]) {
  test(`allow_http preserves ${allowPrivateIp === false ? 'explicit' : 'default'} private-network restrictions on test-kit steps`, async t => {
    for (const name of ['ADCP_ALLOW_INTERNAL_PROBES', 'ADCP_ALLOW_PRIVATE_AGENT_URL']) {
      const previous = process.env[name];
      delete process.env[name];
      t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
    }
    const { url } = await startAgent(t);
    const hosts = new Set();
    const result = await runStoryboard(url, storyboard(), {
      ...OPTIONS,
      transport: {
        ...(allowPrivateIp !== undefined && { allowPrivateIp }),
        trustedFetchFn: async input => {
          const target = new URL(input instanceof Request ? input.url : String(input));
          hosts.add(target.hostname);
          if (target.hostname !== '127.0.0.1') throw new Error('Private redirect escaped the transport policy');
          return new Response(null, { status: 307, headers: { location: 'http://127.0.0.2:3001/mcp' } });
        },
      },
    });
    assert.equal(result.overall_passed, false);
    assert.deepEqual(
      [...hosts],
      ['127.0.0.1'],
      'the trusted fetch must never see the cross-origin private destination'
    );
  });
}

// The name denylist anchors every credential word to a `-`/`_` boundary, so
// the separator-less spellings below evade it. Value matching cannot rescue
// them either: `runCredentialValues` only learns a custom header's value
// *through* that same name test, so a distinct secret under `XApiKey` is
// never learned. Compact-name matching is what actually closes this.
test('camel-case credential headers with values the run cannot learn are still excluded', async t => {
  const { url, requests } = await startAgent(t);
  const OLD_NAME_RE =
    /(^|[-_])(auth(?:entication|orization)?|credentials?|secrets?|tokens?|keys?|api[-_]?keys?|access[-_]?keys?|private[-_]?keys?|password|passwd|signatures?|cert(?:ificate)?s?)([-_]|$)/i;
  // Each value is distinct from the bearer and from the kit key, so nothing
  // here is reachable by value comparison.
  const stowaways = {
    XApiKey: 'distinct-camel-apikey',
    'X-AuthToken': 'distinct-camel-authtoken',
    'X-AccessToken': 'distinct-camel-accesstoken',
    'X-SessionToken': 'distinct-camel-sessiontoken',
    XSecret: 'distinct-camel-secret',
  };
  for (const name of Object.keys(stowaways)) {
    assert.equal(
      OLD_NAME_RE.test(name.toLowerCase()),
      false,
      `${name} must evade the boundary-anchored denylist, or this test proves nothing`
    );
  }

  const result = await runStoryboard(url, storyboard(), {
    ...OPTIONS,
    headers: { ...OPTIONS.headers, ...stowaways },
    transport: { trustedFetchFn: (...args) => fetch(...args) },
  });

  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.ok(requests.length >= 3);
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Bearer kit-step-key');
    assert.equal(request.headers['x-adcp-tenant'], 'acme', 'routing headers still survive');
    for (const [name, value] of Object.entries(request.headers)) {
      assert.equal(String(value).startsWith('distinct-camel-'), false, `suite credential leaked through ${name}`);
    }
  }
});

// A credential the run holds is excluded wherever it is parked, including
// under a name carrying no credential word at all.
test('known credential values are excluded from opaque header names', async t => {
  const { url, requests } = await startAgent(t);
  const result = await runStoryboard(url, storyboard(), {
    ...OPTIONS,
    auth: undefined,
    headers: {
      'x-adcp-tenant': 'acme',
      // Learned because the name is a known credential header; the scheme
      // payload is recorded as well as the whole value.
      Authorization: 'Bearer unique-suite-bearer',
      // Opaque name, no credential word — only reachable by value.
      'X-Gateway-Route': 'unique-suite-bearer',
      // Base64 of a Basic pair the run holds structurally.
      'X-Legacy-Envelope': `Basic ${Buffer.from('suite-user:unique-suite-password').toString('base64')}`,
    },
    test_kit: {
      auth: {
        api_key: 'kit-step-key',
        probe_task: 'list_creatives',
        basic: { username: 'suite-user', password: 'unique-suite-password' },
      },
    },
    transport: { trustedFetchFn: (...args) => fetch(...args) },
  });

  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.ok(requests.length >= 3);
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Bearer kit-step-key');
    assert.equal(request.headers['x-adcp-tenant'], 'acme');
    assert.equal(request.headers['x-gateway-route'], undefined, 'value-matched opaque header dropped');
    assert.equal(request.headers['x-legacy-envelope'], undefined, 'Base64 Basic pair dropped');
    for (const value of Object.values(request.headers)) {
      assert.equal(String(value).includes('unique-suite-bearer'), false);
      assert.equal(String(value).includes('unique-suite-password'), false);
    }
  }
});

// A routing header whose value collides with a run credential cannot be
// resolved safely: forwarding leaks the suite principal, dropping reroutes
// the step to another tenant. Refuse the run instead of guessing.
test('a credential value parked in a routing header fails closed', async t => {
  const { url, requests } = await startAgent(t);
  const result = await runStoryboard(url, storyboard(), {
    ...OPTIONS,
    headers: { 'x-adcp-tenant': 'tenant-suite-key-must-not-leak' },
    transport: { trustedFetchFn: (...args) => fetch(...args) },
  });

  assert.equal(result.overall_passed, false, 'the run must not grade a step it cannot route safely');
  const step = result.phases[0].steps[0];
  assert.match(step.error ?? '', /x-adcp-tenant is a routing header/);
  assert.equal(
    (step.error ?? '').includes('suite-key-must-not-leak'),
    false,
    'the error must name the header without echoing the credential'
  );
  // Fail closed means the colliding value never went out on the wire.
  for (const request of requests) {
    assert.equal(request.headers['x-adcp-tenant'], undefined);
  }
});

// The schema documents a named-principal path form that this arm never
// walked; any truthy value resolved to the primary key, grading a
// multi-principal step against the wrong identity.
test('a named test-kit API-key path is refused rather than resolved to the primary key', async t => {
  const { url } = await startAgent(t);
  const sb = storyboard();
  sb.phases[0].steps[0].auth = { type: 'api_key', from_test_kit: 'auth.principals.secondary.api_key' };
  const result = await runStoryboard(url, sb, {
    ...OPTIONS,
    transport: { trustedFetchFn: (...args) => fetch(...args) },
  });
  assert.equal(result.overall_passed, false);
  const step = result.phases[0].steps[0];
  assert.match(step.error ?? '', /Named test-kit API-key paths are not supported/);
  assert.equal((step.error ?? '').includes('kit-step-key'), false, 'the refusal must not echo a credential');
});
