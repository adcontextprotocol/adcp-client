const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const {
  AgentClient,
  SingleAgentClient,
  CreativeFormatCapabilityError,
  createInMemoryAgentDiscoveryCache,
  packageRefsForFormatOptions,
} = require('../../dist/lib/index.js');
const { creativeSchemaSupport } = require('../../dist/lib/core/creative-schema-support.js');

const canonical = { type: 'object', properties: { creative_id: {}, format_kind: {} } };
const legacy = { type: 'object', properties: { creative_id: {}, format_id: {} } };
const CAPABILITIES = {
  adcp: { major_versions: [3], supported_versions: ['3.1'] },
  supported_protocols: ['media_buy'],
  media_buy: { features: {} },
};
const AGENT = { id: 'schema-refs', name: 'Schema refs', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
const TASKS = ['sync_creatives', 'create_media_buy', 'update_media_buy'];

function toolSchema(mode, task = 'sync_creatives') {
  const creatives = { type: 'array', items: { $ref: '#/$defs/CreativeAsset' } };
  return {
    type: 'object',
    properties:
      task === 'sync_creatives'
        ? { creatives }
        : { packages: { type: 'array', items: { type: 'object', properties: { creatives } } } },
    $defs: {
      CreativeAsset: mode === 'canonical' ? canonical : legacy,
      Unused: mode === 'canonical' ? legacy : canonical,
    },
  };
}

async function seller(mode) {
  const captured = [];
  const server = new Server({ name: 'schema-references', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'get_adcp_capabilities', inputSchema: { type: 'object', properties: {} } },
      ...TASKS.map(name => ({ name, inputSchema: toolSchema(mode, name) })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    captured.push(request.params);
    return {
      content: [{ type: 'text', text: '{}' }],
      structuredContent:
        request.params.name === 'get_adcp_capabilities'
          ? CAPABILITIES
          : request.params.name === 'sync_creatives'
            ? { creatives: [] }
            : { media_buy_id: 'buy-1', status: 'pending_creatives', packages: [] },
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'schema-buyer', version: '1.0.0' });
  await mcp.connect(clientTransport);
  return {
    agent: AgentClient.fromMCPClient(mcp, { validation: { responses: 'off' } }),
    captured,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

describe('creative schema local references', () => {
  for (const mode of ['canonical', 'legacy']) {
    test(`${mode} referenced schemas project all three writes through the official MCP client`, async () => {
      const fixture = await seller(mode);
      try {
        for (const task of TASKS) assert.equal(await fixture.agent.resolveCreativeFormatWireMode(task), mode);
        const params = {
          account: { account_id: 'account-1' },
          idempotency_key: 'schema-reference-sync-key',
          creatives: [{ creative_id: 'creative-1', name: 'Image', format_kind: 'image', assets: {} }],
        };
        await fixture.agent.syncCreatives(params, undefined, {
          creativeFormatProjection: {
            selectorContainers: [
              { format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }] },
            ],
          },
        });
        const sync = fixture.captured.find(call => call.name === 'sync_creatives');
        assert.ok(sync, 'wire-mode discovery must allow dispatch');
        assert.equal(sync.arguments.creatives[0].format_kind, mode === 'canonical' ? 'image' : undefined);
        assert.equal(
          sync.arguments.creatives[0].format_id?.id,
          mode === 'legacy' ? 'display_300x250_image' : undefined
        );
        const selected = packageRefsForFormatOptions(
          {
            format_options: [
              {
                format_option_id: 'image-mrec',
                format_kind: 'image',
                params: {},
                v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
              },
            ],
          },
          ['image-mrec']
        );
        const pkg = { ...selected, package_id: 'package-1', creatives: params.creatives };
        await fixture.agent.createMediaBuy({
          account: params.account,
          idempotency_key: 'schema-reference-create-key',
          brand: { domain: 'brand.example' },
          start_time: 'asap',
          end_time: '2027-12-31T00:00:00Z',
          packages: [{ ...pkg, product_id: 'product-1', budget: 1000, pricing_option_id: 'pricing-1' }],
        });
        await fixture.agent.updateMediaBuy({
          account: params.account,
          idempotency_key: 'schema-reference-update-key',
          media_buy_id: 'buy-1',
          packages: [pkg],
        });
        for (const task of ['create_media_buy', 'update_media_buy']) {
          const write = fixture.captured.find(call => call.name === task);
          assert.ok(write);
          const creative = write.arguments.packages[0].creatives[0];
          assert.equal(creative.format_kind, mode === 'canonical' ? 'image' : undefined);
          assert.equal(creative.format_id?.id, mode === 'legacy' ? 'display_300x250_image' : undefined);
        }
        assert.equal(fixture.captured.filter(call => call.name === 'get_adcp_capabilities').length, 1);
      } finally {
        await fixture.close();
      }
    });
  }

  const cases = [
    ['unused canonical definition does not override legacy', toolSchema('legacy'), 'legacy'],
    ['definitions alone do not establish support', { type: 'object', $defs: { Creative: canonical } }, 'unknown'],
    [
      'annotation objects and negation do not establish support',
      { examples: [canonical], default: canonical, not: canonical },
      'unknown',
    ],
    [
      'legacy definitions keyword can be referenced',
      { properties: { creatives: { items: { $ref: '#/definitions/C' } } }, definitions: { C: legacy } },
      'legacy',
    ],
    ['chained references', { $ref: '#/$defs/A', $defs: { A: { $ref: '#/$defs/B' }, B: canonical } }, 'canonical'],
    ['root-only reference', { $ref: '#/$defs/C', $defs: { C: canonical } }, 'canonical'],
    [
      'reference siblings apply',
      { $ref: '#/$defs/C', properties: { other: canonical }, $defs: { C: legacy } },
      'canonical',
    ],
    [
      'recursive reference with reachable creative',
      { $ref: '#/$defs/C', $defs: { C: { properties: { next: { $ref: '#/$defs/C' }, asset: canonical } } } },
      'canonical',
    ],
    ['reference cycle terminates', { $ref: '#/$defs/C', $defs: { C: { $ref: '#' } } }, 'unknown'],
    ['escaped and encoded JSON Pointer', { $ref: '#/%24defs/A~1B~0%20C', $defs: { 'A/B~ C': canonical } }, 'canonical'],
    ['unresolved local reference', { $ref: '#/$defs/Missing', $defs: { Unused: canonical } }, 'unknown'],
    [
      'external reference is not fetched',
      { $ref: 'https://example.invalid/creative.json', $defs: { Unused: canonical } },
      'unknown',
    ],
    ['inherited properties are not reference targets', { $ref: '#/toString' }, 'unknown'],
    ['malformed URI fragment', { $ref: '#/%ZZ' }, 'unknown'],
    [
      'nested resource has its own local root',
      {
        properties: { embedded: { $id: 'embedded.json', $ref: '#/$defs/C', $defs: { C: legacy } } },
        $defs: { C: canonical },
      },
      'legacy',
    ],
  ];
  cases.push([
    'pointer into a nested resource retains its reference scope',
    {
      $ref: '#/$defs/Embedded/$defs/C',
      $defs: {
        L: canonical,
        Embedded: { $id: 'embedded.json', $defs: { C: { $ref: '#/$defs/L' }, L: legacy } },
      },
    },
    'legacy',
  ]);
  cases.push(
    ['forbidden canonical property is not support', { properties: { creative_id: {}, format_kind: false } }, 'unknown'],
    ['forbidden creative identity is not support', { properties: { creative_id: false, format_kind: {} } }, 'unknown'],
    ['forbidden legacy property is not support', { properties: { creative_id: {}, format_id: false } }, 'unknown'],
    [
      'fragment-only draft-07 identifier keeps the reference root',
      {
        properties: { creatives: { $id: '#Creative', $ref: '#/definitions/C' } },
        definitions: { C: canonical },
      },
      'canonical',
    ]
  );
  for (const [name, schema, expected] of cases) {
    test(name, () => assert.equal(creativeSchemaSupport(schema), expected));
  }

  test('traversal of a deep or branching schema is bounded', () => {
    let deep = canonical;
    for (let i = 0; i < 1000; i++) deep = { items: deep };
    assert.equal(creativeSchemaSupport(deep), 'unknown');
    const shared = { anyOf: [] };
    shared.anyOf.push(shared, canonical);
    assert.equal(creativeSchemaSupport(shared), 'canonical');
    assert.equal(
      creativeSchemaSupport({ anyOf: [legacy, ...Array.from({ length: 10_000 }, () => ({})), canonical] }),
      'unknown'
    );
    assert.equal(creativeSchemaSupport({ anyOf: [legacy, deep] }), 'unknown');
  });

  test('fully dereferenced bundled AdCP 3.1 create schema stays within inspection limits', async () => {
    const { default: parser } = await import('@apidevtools/json-schema-ref-parser');
    const path = require('node:path');
    const file = path.join(__dirname, '../../schemas/cache/3.1.29/bundled/media-buy/create-media-buy-request.json');
    const schema = await parser.dereference(file, { resolve: { external: false } });
    assert.equal(creativeSchemaSupport(schema), 'canonical');
  });

  function stubDiscovery(client, schema, onRead = () => {}) {
    client.getAgentInfo = async () => {
      onRead();
      return {
        tools: [
          { name: 'get_adcp_capabilities', inputSchema: { properties: {} } },
          { name: 'sync_creatives', inputSchema: schema },
        ],
      };
    };
    client.ensureEndpointDiscovered = async () => AGENT;
    client.executor.executeTask = async () => ({ success: true, data: CAPABILITIES });
  }

  test('complete documents survive serialized shared-cache reuse without altering property maps', async () => {
    const entries = new Map();
    const config = {
      discoveryCache: {
        authIdentity: 'buyer-1',
        cache: {
          get: key => (entries.has(key) ? JSON.parse(entries.get(key)) : undefined),
          set: (key, entry) => entries.set(key, JSON.stringify(entry)),
          delete: key => entries.delete(key),
        },
      },
    };
    const first = new SingleAgentClient(AGENT, config);
    stubDiscovery(first, toolSchema('canonical'));
    assert.equal(await first.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
    const stored = JSON.parse([...entries.values()][0]);
    assert.deepEqual(Object.keys(stored.toolSchemas.sync_creatives), ['creatives']);
    assert.deepEqual(stored.toolInputSchemas.sync_creatives, toolSchema('canonical'));
    const adapted = first.adaptRequest('sync_creatives', { creatives: [], unrelated: true }, 'v3');
    assert.deepEqual(adapted.params.creatives, []);
    assert.equal(adapted.params.unrelated, undefined);
    const second = new SingleAgentClient(AGENT, config);
    stubDiscovery(second, {}, () => assert.fail('shared evidence must avoid tools/list'));
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
  });

  test('scoped discovery does not overwrite unscoped full-schema evidence', async () => {
    const client = new SingleAgentClient(AGENT);
    stubDiscovery(client, toolSchema('legacy'));
    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
    stubDiscovery(client, toolSchema('canonical'));
    assert.equal(
      await client.resolveCreativeFormatWireMode('sync_creatives', {
        transport: { trustedFetchFn: async () => assert.fail('stubbed transport') },
      }),
      'canonical'
    );
    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
  });

  test('full-schema unknown does not fall back to annotations in its property map', async () => {
    const client = new SingleAgentClient(AGENT);
    stubDiscovery(client, { properties: { creatives: { examples: [canonical] } }, $defs: { Unused: canonical } });
    await client.getCapabilities();
    client.cachedToolSchemas.set('sync_creatives', { creatives: { items: canonical } });
    await assert.rejects(client.resolveCreativeFormatWireMode('sync_creatives'), CreativeFormatCapabilityError);
  });

  test('root-only referenced schemas are captured during discovery', async () => {
    const client = new SingleAgentClient(AGENT);
    stubDiscovery(client, { $ref: '#/$defs/C', $defs: { C: canonical } });
    assert.equal(await client.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
  });

  test('endpoint updates retain documents and refreshed property maps clear older documents', async () => {
    const entries = new Map();
    const config = {
      discoveryCache: {
        authIdentity: 'cache-updates',
        cache: {
          get: key => entries.get(key),
          set: (key, entry) => entries.set(key, entry),
          delete: key => entries.delete(key),
        },
      },
    };
    const client = new SingleAgentClient(AGENT, config);
    stubDiscovery(client, toolSchema('canonical'));
    await client.resolveCreativeFormatWireMode('sync_creatives');
    await client.writeSharedDiscovery(undefined, { endpoint: { agentUri: AGENT.agent_uri } });
    assert.deepEqual([...entries.values()][0].toolInputSchemas.sync_creatives, toolSchema('canonical'));
    await client.writeSharedDiscovery(undefined, {
      capabilities: client.cachedCapabilities,
      toolSchemas: { sync_creatives: { creatives: { items: legacy } } },
    });
    assert.equal([...entries.values()][0].toolInputSchemas, undefined);
    const second = new SingleAgentClient(AGENT, config);
    stubDiscovery(second, {}, () => assert.fail('refreshed shared properties must avoid discovery'));
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
  });

  test('invalidation refreshes documents for this client and other clients holding shared evidence', async () => {
    const config = { discoveryCache: { cache: createInMemoryAgentDiscoveryCache(), authIdentity: 'refresh-docs' } };
    const first = new SingleAgentClient(AGENT, config);
    const second = new SingleAgentClient(AGENT, config);
    stubDiscovery(first, toolSchema('canonical'));
    stubDiscovery(second, {}, () => assert.fail('shared evidence must avoid discovery'));
    assert.equal(await first.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
    await first.invalidateDiscoveryCache();
    stubDiscovery(first, toolSchema('legacy'));
    assert.equal(await first.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
  });

  test('a missing tool does not invalidate modern shared evidence or rediscover', async () => {
    const cache = createInMemoryAgentDiscoveryCache();
    const config = { discoveryCache: { cache, authIdentity: 'missing-tool-cache' } };
    let deletes = 0;
    const remove = cache.delete;
    cache.delete = key => {
      deletes++;
      remove(key);
    };
    const first = new SingleAgentClient(AGENT, config);
    stubDiscovery(first, {});
    first.getAgentInfo = async () => ({ tools: [{ name: 'get_adcp_capabilities', inputSchema: { properties: {} } }] });
    await first.getCapabilities();
    const second = new SingleAgentClient(AGENT, config);
    stubDiscovery(second, {}, () => assert.fail('a missing tool is not lost schema evidence'));
    await assert.rejects(second.resolveCreativeFormatWireMode('sync_creatives'), CreativeFormatCapabilityError);
    assert.equal(deletes, 0);
  });

  test('older shared property-only entries rediscover local-reference evidence once', async () => {
    const cache = createInMemoryAgentDiscoveryCache();
    const config = { discoveryCache: { cache, authIdentity: 'older-sdk-cache' } };
    const first = new SingleAgentClient(AGENT, config);
    stubDiscovery(first, toolSchema('canonical'));
    await first.resolveCreativeFormatWireMode('sync_creatives');
    const get = cache.get;
    cache.get = key => {
      const entry = get(key);
      if (entry) delete entry.toolInputSchemas;
      return entry;
    };
    const second = new SingleAgentClient(AGENT, config);
    let reads = 0;
    stubDiscovery(second, toolSchema('canonical'), () => reads++);
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'canonical');
    assert.equal(reads, 1);

    const third = new SingleAgentClient(AGENT, config);
    let missingReads = 0;
    stubDiscovery(third, { properties: {} }, () => missingReads++);
    await assert.rejects(third.resolveCreativeFormatWireMode('sync_creatives'), CreativeFormatCapabilityError);
    assert.equal(missingReads, 1, 'unresolved evidence cannot cause a retry loop');
  });

  test('malformed full-schema cache evidence triggers live rediscovery', async () => {
    const cache = createInMemoryAgentDiscoveryCache();
    const config = { discoveryCache: { cache, authIdentity: 'buyer-1' } };
    const first = new SingleAgentClient(AGENT, config);
    stubDiscovery(first, toolSchema('canonical'));
    await first.resolveCreativeFormatWireMode('sync_creatives');
    const get = cache.get;
    cache.get = key => {
      const entry = get(key);
      return entry && { ...entry, toolInputSchemas: [] };
    };
    const second = new SingleAgentClient(AGENT, config);
    let reads = 0;
    stubDiscovery(second, toolSchema('legacy'), () => reads++);
    assert.equal(await second.resolveCreativeFormatWireMode('sync_creatives'), 'legacy');
    assert.equal(reads, 1);
  });
});
