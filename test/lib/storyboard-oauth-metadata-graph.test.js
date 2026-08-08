const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  comply,
  createTestClient,
  gradeOAuthMetadataGraph,
  loadComplianceIndex,
  loadStoryboardFile,
  runStoryboard,
  runValidations,
} = require('../../dist/lib/testing/index.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const servers = new Set();
afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  servers.clear();
});

function oauthStoryboard() {
  return loadStoryboardFile(path.join(__dirname, '..', 'fixtures', 'oauth-setup', 'oauth-setup.yaml'));
}

function capabilityClient(agentUrl, fetchFn, rawCapabilities) {
  const client = createTestClient(agentUrl, 'mcp', { transport: { fetchFn } });
  client.getAdcpCapabilities = async () => ({ success: true, data: rawCapabilities });
  return client;
}

async function startGraphServer(protectedResourceOverride) {
  const requests = [];
  let actualOrigin = '';
  const logicalOrigin = 'https://localhost';
  const server = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url?.startsWith('/mcp')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = result => {
        res.setHeader('mcp-session-id', 'oauth-graph-session');
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (rpc.method === 'initialize') {
        reply({
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'OAuth graph agent', version: '1.0.0' },
        });
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (rpc.method === 'tools/list') {
        reply({ tools: [{ name: 'get_adcp_capabilities', inputSchema: { type: 'object' } }] });
        return;
      }
      if (rpc.method === 'tools/call' && rpc.params?.name === 'get_adcp_capabilities') {
        reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'completed',
                adcp_version: '3.2',
                adcp: {
                  major_versions: [3],
                  supported_versions: ['3.2'],
                  idempotency: { supported: false },
                },
                supported_protocols: ['media_buy'],
                oauth: { supported: true },
                context: rpc.params.arguments?.context ?? {},
              }),
            },
          ],
          isError: false,
        });
        return;
      }
      reply({});
      return;
    }
    const documents = {
      '/.well-known/oauth-protected-resource/mcp': protectedResourceOverride ?? {
        resource: `${logicalOrigin}/mcp`,
        authorization_servers: [`${logicalOrigin}/tenant-one`, `${logicalOrigin}/tenant-two`],
      },
      '/.well-known/oauth-authorization-server/tenant-one': {
        issuer: `${logicalOrigin}/tenant-one`,
        token_endpoint: `${logicalOrigin}/tenant-one/token`,
        grant_types_supported: ['client_credentials'],
      },
      '/.well-known/oauth-authorization-server/tenant-two': {
        issuer: `${logicalOrigin}/tenant-two`,
        authorization_endpoint: `${logicalOrigin}/tenant-two/authorize`,
        response_types_supported: ['token'],
        grant_types_supported: ['implicit'],
      },
    };
    const document = documents[req.url];
    if (document) {
      res.writeHead(200);
      res.end(JSON.stringify(document));
      return;
    }
    if (req.url === '/tenant-one/token') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    if (req.url === '/tenant-two/authorize') {
      res.writeHead(302, { location: `${logicalOrigin}/login` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  servers.add(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  actualOrigin = `http://127.0.0.1:${server.address().port}`;
  const fetchFn = (url, init) => fetch(String(url).replace(logicalOrigin, actualOrigin), init);
  return { server, origin: logicalOrigin, requests, fetchFn };
}

describe('oauth_metadata_graph storyboard integration', () => {
  it('keeps the pinned 3.1 compliance bundle free of the 3.2 OAuth storyboard', () => {
    assert.match(ADCP_VERSION, /^3\.1\./);
    assert.doesNotMatch(loadComplianceIndex({ version: ADCP_VERSION }).universal.join(','), /oauth-setup/);
  });

  it('loads and executes oauth_setup through comply() from an external 3.2 bundle', async () => {
    const { origin, fetchFn } = await startGraphServer();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-oauth-compliance-'));
    const complianceDir = path.join(tempRoot, 'compliance');
    const schemaRoot = path.join(tempRoot, 'schemas');
    try {
      fs.mkdirSync(path.join(complianceDir, 'universal'), { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, '..', 'fixtures', 'oauth-setup', 'oauth-setup.yaml'),
        path.join(complianceDir, 'universal', 'oauth-setup.yaml')
      );
      fs.writeFileSync(
        path.join(complianceDir, 'index.json'),
        JSON.stringify({
          published_version: '3.2',
          adcp_version: '3.2',
          generated_at: new Date(0).toISOString(),
          universal: ['oauth-setup'],
          protocols: [],
          specialisms: [],
        })
      );

      const bundledProtocolDir = path.join(schemaRoot, 'bundled', 'protocol');
      fs.mkdirSync(bundledProtocolDir, { recursive: true });
      for (const file of ['get-adcp-capabilities-request.json', 'get-adcp-capabilities-response.json']) {
        const source = path.join(process.cwd(), 'schemas', 'cache', ADCP_VERSION, 'bundled', 'protocol', file);
        const schema = JSON.parse(fs.readFileSync(source, 'utf8'));
        schema.$id = schema.$id.replace(`/schemas/${ADCP_VERSION}/`, '/schemas/3.2/');
        fs.writeFileSync(path.join(bundledProtocolDir, file), JSON.stringify(schema));
      }

      const result = await comply(`${origin}/mcp`, {
        allow_http: true,
        protocol: 'mcp',
        transport: { fetchFn },
        version: '3.2',
        complianceDir,
        schemaRoot,
        storyboards: ['oauth_setup'],
        timeout_ms: 30_000,
      });

      assert.deepStrictEqual(result.storyboards_executed, ['oauth_setup']);
      assert.strictEqual(result.overall_status, 'partial', JSON.stringify(result, null, 2));
      assert.strictEqual(result.tracks[0].track, 'security_transport');
      assert.strictEqual(result.tracks[0].status, 'silent');
      assert.strictEqual(result.summary.steps_failed, 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('propagates caller cancellation instead of grading the agent', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled compliance run');
    controller.abort(reason);
    await assert.rejects(gradeOAuthMetadataGraph('https://agent.example/mcp', { signal: controller.signal }), error => {
      assert.strictEqual(error, reason);
      return true;
    });
  });

  it('stays dormant unless raw oauth.supported is exactly true', async () => {
    const { origin, requests, fetchFn } = await startGraphServer();
    for (const rawCapabilities of [undefined, {}, { oauth: { supported: false } }]) {
      const result = await runStoryboard(`${origin}/mcp`, oauthStoryboard(), {
        protocol: 'mcp',
        allow_http: true,
        transport: { fetchFn },
        agentTools: ['get_adcp_capabilities'],
        _client: capabilityClient(`${origin}/mcp`, fetchFn, rawCapabilities),
        _profile: {
          name: 'Static bearer agent',
          tools: ['get_adcp_capabilities'],
          ...(rawCapabilities !== undefined && { raw_capabilities: rawCapabilities }),
        },
      });

      assert.strictEqual(result.overall_passed, true);
      assert.strictEqual(result.skipped_count, 1);
      assert.strictEqual(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    }
    assert.deepStrictEqual(requests, [], 'capability gate must run before any metadata request');
  });

  it('validates every advertised authorization server when OAuth is declared', async () => {
    const { origin, requests, fetchFn } = await startGraphServer();
    const rawCapabilities = {
      adcp: { major_versions: [3], supported_versions: ['3.2'] },
      supported_protocols: [],
      oauth: { supported: true },
      context: { correlation_id: 'oauth_setup--get_capabilities' },
    };
    const result = await runStoryboard(`${origin}/mcp`, oauthStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      transport: { fetchFn },
      agentTools: ['get_adcp_capabilities'],
      _client: capabilityClient(`${origin}/mcp`, fetchFn, rawCapabilities),
      _profile: {
        name: 'OAuth agent',
        tools: ['get_adcp_capabilities'],
        raw_capabilities: rawCapabilities,
      },
    });

    assert.strictEqual(result.overall_passed, true, JSON.stringify(result, null, 2));
    const validation = result.phases[1].steps[0].validations.find(v => v.check === 'oauth_metadata_graph');
    assert.strictEqual(validation.passed, true, validation.error);
    assert.ok(requests.includes('GET /.well-known/oauth-authorization-server/tenant-one'));
    assert.ok(requests.includes('GET /.well-known/oauth-authorization-server/tenant-two'));
    assert.ok(requests.includes('GET /tenant-one/token'));
    assert.ok(requests.includes('GET /tenant-two/authorize'));
  });

  it('does not extend local-development private-network trust to an off-origin issuer', async () => {
    const { origin, requests, fetchFn } = await startGraphServer({
      resource: 'https://localhost/mcp',
      authorization_servers: ['https://127.0.0.1/private-issuer'],
    });
    const grade = await gradeOAuthMetadataGraph(`${origin}/mcp`, {
      allowHttp: true,
      trustedFetchFn: fetchFn,
    });
    assert.strictEqual(grade.success, false);
    assert.strictEqual(grade.error_code, 'oauth_fetch_blocked');
    assert.deepStrictEqual(requests, ['GET /.well-known/oauth-protected-resource/mcp']);

    const [validation] = runValidations([{ check: 'oauth_metadata_graph', description: 'OAuth graph is conformant' }], {
      taskName: 'protected_resource_metadata',
      agentUrl: `${origin}/mcp`,
      contributions: new Set(),
      oauthMetadataGraph: grade,
    });
    assert.deepStrictEqual(validation.expected, {
      profile: 'adcp/oauth-metadata-graph/v1',
      require_authorization_servers: true,
      follow_all_authorization_servers: true,
      probe_advertised_endpoints: true,
    });
    assert.strictEqual(validation.actual.code, 'oauth_fetch_blocked');
    assert.strictEqual('error_code' in validation.actual, false);
  });

  it('redacts OAuth URL secrets from the complete storyboard result', async () => {
    const { origin, fetchFn } = await startGraphServer({
      resource: 'https://resource-user:resource-password@localhost/mcp?access_token=resource-query#resource-fragment',
      authorization_servers: [
        'https://issuer-user:issuer-password@identity.example?access_token=issuer-query#issuer-fragment',
      ],
    });
    const rawCapabilities = { oauth: { supported: true } };
    const agentUrl = `${origin}/mcp?access_token=runner-query#runner-fragment`;
    const result = await runStoryboard(agentUrl, oauthStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      transport: { fetchFn },
      agentTools: ['get_adcp_capabilities'],
      _client: capabilityClient(agentUrl, fetchFn, rawCapabilities),
      _profile: {
        name: 'OAuth agent with unsafe metadata',
        tools: ['get_adcp_capabilities'],
        raw_capabilities: rawCapabilities,
      },
    });

    const serialized = JSON.stringify(result);
    for (const secret of [
      'resource-user',
      'resource-password',
      'resource-query',
      'resource-fragment',
      'issuer-user',
      'issuer-password',
      'issuer-query',
      'issuer-fragment',
      'runner-query',
      'runner-fragment',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.match(serialized, /REDACTED/);
  });
});
