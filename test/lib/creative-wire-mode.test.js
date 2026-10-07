const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentClient,
  SingleAgentClient,
  CreativeFormatCapabilityError,
  CreativeFormatProjectionError,
  parseCapabilitiesResponse,
} = require('../../dist/lib/index.js');
const { projectSyncCreativesForDelivery } = require('../../dist/lib/v2/projection/index.js');

const AGENT = { id: 'wire-mode', name: 'Wire mode', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
const canonicalSchema = { creatives: { items: { properties: { creative_id: {}, format_kind: {} } } } };
const legacySchema = { creatives: { items: { properties: { creative_id: {}, format_id: {} } } } };

function prime(client, response, toolSchemas = {}) {
  assert.equal(
    client.primeCapabilities({
      scope: client.getCapabilityEvidenceScope(),
      capabilities: parseCapabilitiesResponse({ adcp: { major_versions: [3] }, ...response }),
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      toolSchemas,
    }),
    true
  );
}

describe('public creative wire mode resolution', () => {
  for (const Client of [SingleAgentClient, AgentClient]) {
    test(`${Client.name} resolves each tool from primed evidence without dispatching`, async () => {
      const client = new Client(AGENT, { wireAdcpVersion: '3.1' });
      prime(
        client,
        { adcp: { major_versions: [3], supported_versions: ['3.0', '3.1'] } },
        {
          sync_creatives: canonicalSchema,
          create_media_buy: legacySchema,
        }
      );
      const single = client instanceof SingleAgentClient ? client : client.client;
      single.getAgentInfo = async () => assert.fail('primed evidence must avoid discovery');
      single.executor.executeTask = async () => assert.fail('preflight must not dispatch a tool');

      assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
      assert.equal(await client.resolveCreativeFormatWireMode('create_media_buy'), 'legacy');
      assert.equal(await client.resolveCreativeFormatWireMode('update_media_buy'), 'unknown');
    });
  }

  const cases = [
    ['explicit canonical support', '3.1', { media_buy: { features: { canonical_creatives: true } } }, {}, 'canonical'],
    ['explicit legacy support', '3.1', { media_buy: { features: { canonical_creatives: false } } }, {}, 'legacy'],
    ['3.0 buyer pin', '3.0', {}, {}, 'legacy'],
    ['3.2 seller contract', '3.2', { adcp: { major_versions: [3], supported_versions: ['3.2'] } }, {}, 'canonical'],
    [
      '3.2 buyer downshifts to 3.1 schema',
      '3.2',
      { adcp: { major_versions: [3], supported_versions: ['3.1'] } },
      legacySchema,
      'legacy',
    ],
    ['3.1 peer with no evidence', '3.1', {}, {}, 'unknown'],
    ['3.2 buyer with no evidence', '3.2', {}, {}, CreativeFormatCapabilityError],
    [
      'capabilities disagree with schema',
      '3.1',
      { media_buy: { features: { canonical_creatives: true } } },
      legacySchema,
      CreativeFormatCapabilityError,
    ],
    [
      '3.2 seller denies canonical support',
      '3.2',
      {
        adcp: { major_versions: [3], supported_versions: ['3.2'] },
        media_buy: { features: { canonical_creatives: false } },
      },
      {},
      CreativeFormatCapabilityError,
    ],
    [
      'incompatible seller versions',
      '3.2',
      { adcp: { major_versions: [3], supported_versions: ['4.0'] } },
      canonicalSchema,
      CreativeFormatCapabilityError,
    ],
  ];
  for (const [name, wireAdcpVersion, response, schema, expected] of cases) {
    test(name, async () => {
      const client = new SingleAgentClient(AGENT, { wireAdcpVersion });
      prime(client, response, { sync_creatives: schema });
      if (typeof expected === 'string') {
        assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), expected);
      } else {
        await assert.rejects(client.resolveCreativeFormatWireMode('sync_creatives'), expected);
      }
    });
  }

  test('cold discovery reads capabilities and tool schemas once and honors cancellation', async () => {
    const client = new SingleAgentClient(AGENT, { wireAdcpVersion: '3.1' });
    const signal = new AbortController().signal;
    const discoveryCalls = [];
    const toolCalls = [];
    client.ensureEndpointDiscovered = async () => AGENT;
    client.getAgentInfo = async options => {
      discoveryCalls.push(options);
      return {
        tools: [
          { name: 'get_adcp_capabilities', inputSchema: { properties: {} } },
          { name: 'sync_creatives', inputSchema: { properties: canonicalSchema } },
        ],
      };
    };
    client.executor.executeTask = async (_agent, tool, _params, _handler, options) => {
      toolCalls.push({ tool, options });
      return { success: true, data: { adcp: { major_versions: [3], supported_versions: ['3.1'] } } };
    };

    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives', { signal }), 'canonical');
    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
    assert.equal(discoveryCalls.length, 1);
    assert.equal(discoveryCalls[0].signal, signal);
    assert.deepEqual(
      toolCalls.map(call => call.tool),
      ['get_adcp_capabilities']
    );
    assert.equal(toolCalls[0].options.signal, signal);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.resolveCreativeFormatWireMode('sync_creatives', { signal: controller.signal }), {
      name: 'AbortError',
    });
    assert.equal(discoveryCalls.length, 1);
  });

  test('scoped transport uses its discovered schema and leaves shared evidence intact', async () => {
    const client = new SingleAgentClient(AGENT, { wireAdcpVersion: '3.1' });
    prime(client, {}, { sync_creatives: legacySchema });
    const transport = { trustedFetchFn: async () => assert.fail('stubbed discovery must not fetch') };
    client.ensureEndpointDiscovered = async () => AGENT;
    client.getAgentInfo = async options => {
      assert.equal(options.transport, transport);
      return {
        tools: [
          { name: 'get_adcp_capabilities', inputSchema: { properties: {} } },
          { name: 'sync_creatives', inputSchema: { properties: canonicalSchema } },
        ],
      };
    };
    client.executor.executeTask = async (_agent, tool) => {
      assert.equal(tool, 'get_adcp_capabilities');
      return { success: true, data: { adcp: { major_versions: [3], supported_versions: ['3.1'] } } };
    };

    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives', { transport }), 'canonical');
    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
  });

  for (const [schema, expected] of [
    [canonicalSchema, 'canonical'],
    [legacySchema, 'legacy'],
  ]) {
    test(`${expected} preflight matches syncCreatives projection or failure`, async () => {
      const client = new SingleAgentClient(AGENT, { wireAdcpVersion: '3.1' });
      prime(client, { adcp: { major_versions: [3], supported_versions: ['3.1'] } }, { sync_creatives: schema });
      const params = {
        account: { account_id: 'account-1' },
        idempotency_key: 'wire-mode-parity',
        creatives: [{ creative_id: 'creative-1', name: 'Image', format_kind: 'image', assets: {} }],
        assignments: [{ creative_id: 'creative-1', package_id: 'package-1' }],
      };
      const selectors = [{ package_id: 'package-1' }];
      const mode = await client.resolveCreativeFormatWireMode('sync_creatives');
      let captured;
      client.executeAndHandle = async (_task, _handler, wireParams) => {
        captured = wireParams;
        return { success: true, status: 'completed', data: {} };
      };

      if (expected === 'legacy') {
        assert.throws(() => projectSyncCreativesForDelivery(params, selectors, mode), CreativeFormatProjectionError);
        await assert.rejects(client.syncCreatives(params), CreativeFormatProjectionError);
        assert.equal(captured, undefined);
        selectors[0].format_ids = [
          { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' },
        ];
      }
      const projected = projectSyncCreativesForDelivery(params, selectors, mode);
      await client.syncCreatives(params, undefined, { creativeFormatProjection: { selectorContainers: selectors } });
      assert.deepEqual(captured, projected);
    });
  }
});
