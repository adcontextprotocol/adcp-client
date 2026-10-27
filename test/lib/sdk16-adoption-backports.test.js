process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const sdk = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5');
for (const tool of ['create_media_buy', 'update_media_buy']) {
  for (const version of ['3.0', '3.1', '3.2']) {
    test(`${tool}: a ${version} MCP buyer receives the actual pending lifecycle`, async t => {
      const handler = async () => ({
        media_buy_id: 'mb-1',
        media_buy_status: 'pending_creatives',
        packages: [{ package_id: 'pkg-1' }],
      });
      const server = createAdcpServer({
        name: 'adoption-seller',
        version: '1.0.0',
        adcpVersion: '3.2.7',
        defaultAdcpVersion: '3.1',
        idempotency: 'disabled',
        capabilities: { supported_versions: ['3.0', '3.1', '3.2'] },
        validation: { requests: 'off', responses: 'off' },
        mediaBuy: { createMediaBuy: handler, updateMediaBuy: handler },
      });
      const client = new Client({ name: 'sdk17-regression', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      t.after(async () => {
        await client.close();
        await server.close();
      });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: tool,
        arguments: version === '3.0' ? { adcp_major_version: 3 } : { adcp_version: version },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const data = result.structuredContent;
      assert.equal(data.status, version === '3.0' ? 'pending_creatives' : 'completed');
      assert.equal(data.media_buy_status, version === '3.0' ? undefined : 'pending_creatives');
      for (const part of result.content.filter(p => p.type === 'text' && p.text.trimStart().startsWith('{'))) {
        const mirrored = JSON.parse(part.text);
        assert.equal(mirrored.status, data.status);
        assert.equal(mirrored.media_buy_status, data.media_buy_status);
      }
    });
  }
}

const account = { account_id: 'acc-1' };
function feedResult(metadata = {}) {
  return {
    success: true,
    status: 'completed',
    metadata,
    data: {
      status: 'completed',
      cursor: 'checkpoint',
      has_more: false,
      available_since: '2026-10-26T00:00:00Z',
      generated_at: '2026-10-26T00:00:00Z',
      changes: [
        {
          change_id: 'change-1',
          recorded_at: '2026-10-26T00:00:00Z',
          resource: { type: 'creative', resource_id: 'cr-1', account_id: account.account_id },
          action: 'created',
          origin: { kind: 'seller_operator' },
          repair: { task: 'list_creatives' },
        },
      ],
    },
  };
}
for (const mode of ['option', 'client', 'negotiated', 'echo']) {
  test(`3.2 account feed without changed_paths drains using ${mode} version evidence`, async () => {
    let committed;
    const result = feedResult(
      mode === 'negotiated' ? { negotiatedAdcpVersion: '3.2' } : mode === 'echo' ? { adcpVersion: '3.2' } : {}
    );
    const client = {
      listAccountChanges: async () => result,
      getAdcpVersion: () => (mode === 'client' ? '3.2.7' : sdk.ADCP_VERSION),
    };
    for await (const page of sdk.streamAccountChanges(client, {
      account,
      ...(mode === 'option' && { adcpVersion: '3.2.7' }),
    })) {
      assert.equal(page.changes[0].changed_paths, undefined);
      await page.acknowledge(async cursor => {
        committed = cursor.value;
      });
    }
    assert.equal(committed, 'checkpoint');
  });
}
test('targeting key lists exactly enumerate bundled schema properties', () => {
  for (const [name, file] of [
    ['TargetingOverlay', 'targeting.json'],
    ['TargetingOverlaySupport', 'targeting-overlay-support.json'],
  ]) {
    const document = JSON.parse(
      readFileSync(path.join(__dirname, '../../schemas/cache', sdk.ADCP_VERSION, 'core', file), 'utf8')
    );
    assert.deepEqual(sdk[`${name}Keys`], Object.keys(document.properties));
    assert.ok(Object.isFrozen(sdk[`${name}Keys`]));
  }
});

for (const lifecycle of ['canceled', 'completed', 'rejected']) {
  test(`legacy update handler retains ${lifecycle} lifecycle meaning for a3.2 buyer`, async t => {
    const server = createAdcpServer({
      name: 'legacy-status',
      version: '1',
      adcpVersion: '3.2.7',
      idempotency: 'disabled',
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { updateMediaBuy: async () => ({ media_buy_id: 'mb-3431', status: lifecycle }) },
    });
    t.after(() => server.close());
    const response = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'update_media_buy', arguments: { adcp_version: '3.2' } },
    });
    assert.equal(response.structuredContent.status, 'completed');
    assert.equal(response.structuredContent.media_buy_status, lifecycle);
  });
}

for (const evidence of ['wire', 'explicit']) {
  test(`${evidence} feed version takes precedence over an unverified seller echo`, async () => {
    const metadata = { adcpVersion: '3.1', ...(evidence === 'wire' && { wireAdcpVersion: sdk.ADCP_VERSION }) };
    const stream = sdk.streamAccountChanges(
      { listAccountChanges: async () => feedResult(metadata) },
      { account, ...(evidence === 'explicit' && { adcpVersion: sdk.ADCP_VERSION }) }
    );
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value.changes[0].change_id, 'change-1');
    await stream.return();
  });
}

test('executor retains trusted same-release negotiation independently of the seller echo', async t => {
  const page = { ...feedResult().data, adcp_version: '3.1' };
  t.mock.method(sdk.ProtocolClient, 'callTool', async () => ({
    content: [{ type: 'text', text: JSON.stringify(page) }],
    structuredContent: page,
  }));
  const executor = new sdk.TaskExecutor({
    adcpVersion: sdk.ADCP_VERSION,
    validation: { requests: 'off', responses: 'off' },
  });
  const result = await executor.executeTask(
    { id: 'wire-metadata-seller', name: 'Seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' },
    'list_account_changes',
    { account, starting_position: 'earliest' },
    undefined,
    { negotiatedAdcpVersion: sdk.ADCP_VERSION, wireAdcpVersion: sdk.ADCP_VERSION }
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.metadata.wireAdcpVersion, sdk.ADCP_VERSION);
  assert.equal(result.metadata.adcpVersion, '3.1');
  const stream = sdk.streamAccountChanges({ listAccountChanges: async () => result }, { account });
  assert.equal((await stream.next()).done, false);
  await stream.return();
});

test('public same-release negotiation preserves the patch pin without introducing a wire override', async t => {
  const agent = { id: 'negotiated-feed', name: 'Seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' };
  const client = new sdk.SingleAgentClient(agent, {
    adcpVersion: sdk.ADCP_VERSION,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  t.mock.method(client, 'ensureEndpointDiscovered', async () => agent);
  t.mock.method(client, 'ensureCanonicalUrlResolved', async () => agent);
  t.mock.method(client, 'getCapabilities', async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [sdk.ADCP_VERSION],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    discoveredTools: ['list_account_changes'],
    _synthetic: false,
  }));
  t.mock.method(sdk.ProtocolClient, 'callTool', async (_agent, _tool, _params, options) => {
    assert.equal(options.wireAdcpVersion, undefined, 'metadata must not introduce a wire override');
    assert.equal(options.adcpVersion, sdk.ADCP_VERSION, 'keep the exact configured patch release');
    return { content: [], structuredContent: { ...feedResult().data, adcp_version: '3.1' } };
  });
  const result = await client.listAccountChanges({ account, starting_position: 'earliest' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.metadata.wireAdcpVersion, sdk.ADCP_VERSION);
  assert.equal(result.metadata.negotiatedAdcpVersion, undefined, 'same-release calls need no compatibility conversion');
  const stream = sdk.streamAccountChanges({ listAccountChanges: async () => result }, { account });
  assert.equal((await stream.next()).done, false);
  await stream.return();
});

for (const override of ['call', 'client']) {
  test(`${override}: an explicit wire override takes precedence over retained metadata-only selection`, async t => {
    t.mock.method(sdk.ProtocolClient, 'callTool', async (_agent, _tool, _params, options) => {
      assert.equal(options.wireAdcpVersion, '3.2.7');
      return { content: [], structuredContent: { ...feedResult().data, adcp_version: '3.1' } };
    });
    const executor = new sdk.TaskExecutor({
      adcpVersion: sdk.ADCP_VERSION,
      ...(override === 'client' && { wireAdcpVersion: '3.2.7' }),
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await executor.executeTask(
      { id: 'wire-override', name: 'Seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' },
      'list_account_changes',
      { account, starting_position: 'earliest' },
      undefined,
      { selectedAdcpVersion: '3.1.24', ...(override === 'call' && { wireAdcpVersion: '3.2.7' }) }
    );
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.metadata.wireAdcpVersion, '3.2.7');
    const page = await sdk.streamAccountChanges({ listAccountChanges: async () => result }, { account }).next();
    assert.equal(page.done, false);
    assert.equal(page.value.changes[0].change_id, 'change-1');
  });
}
