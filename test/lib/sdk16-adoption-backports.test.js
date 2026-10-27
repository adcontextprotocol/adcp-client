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
    assert.ok(sdk[`${name}Keys`].includes('collection_lists'));
    assert.ok(sdk[`${name}Keys`].includes('collection_lists_exclude'));
  }
});
