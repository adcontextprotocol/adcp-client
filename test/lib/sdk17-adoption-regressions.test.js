process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const sdk = require('../../dist/lib/index.js');
const { ACCOUNT_NOTIFICATION_TYPES, CALLER_NOTIFICATION_TYPES } = require('../../dist/lib/server');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5');
const { NotificationTypeValues } = require('../../dist/lib/types');
const { withDualEmissionLegacyRefs } = require('../../dist/lib/v2/projection/v1-to-v2');
const { legacyFormatRefsForDeclaration } = require('../../dist/lib/v2/projection/legacy-metadata');
const schemas = require('../../dist/lib/schemas');

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
        adcpVersion: '3.3.0-beta.0',
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

test('caller and account notification constants cover the current notification enum', () => {
  assert.deepEqual(
    [...new Set([...CALLER_NOTIFICATION_TYPES, ...ACCOUNT_NOTIFICATION_TYPES])].sort(),
    NotificationTypeValues.filter(type => type.includes('.')).sort()
  );
  for (const type of [
    'collection_card.updated',
    'collection_card.removed',
    'collection_catalog.bulk_change',
    'proposal.created',
  ]) {
    assert.ok(ACCOUNT_NOTIFICATION_TYPES.includes(type));
  }
});

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
test('3.3 account feed still requires seller-originated changed_paths', async () => {
  const stream = sdk.streamAccountChanges({ listAccountChanges: async () => feedResult() }, { account });
  await assert.rejects(stream.next(), error => error.code === 'account_change_page_invalid');
});

test('incompatible html5/_html sibling preserves a valid image legacy route', () => {
  const image = { format_kind: 'image', format_option_id: 'image-300', params: { width: 300, height: 250 } };
  const html = { format_kind: 'html5', format_option_id: 'old-html', params: { width: 300, height: 250 } };
  const refs = ['display_300x250_image', 'display_300x250_html'].map(id => ({
    agent_url: 'https://creative.adcontextprotocol.org',
    id,
  }));
  const paired = withDualEmissionLegacyRefs([image, html], refs);
  assert.deepEqual(legacyFormatRefsForDeclaration(paired[0]), [refs[0]]);
  assert.deepEqual(legacyFormatRefsForDeclaration(paired[1]), []);
  assert.equal(paired[1], html);
  assert.deepEqual(legacyFormatRefsForDeclaration(image), [], 'inputs are not mutated');
  assert.deepEqual(
    legacyFormatRefsForDeclaration(withDualEmissionLegacyRefs([image], refs)[0]),
    [],
    'length mismatch cannot establish index pairing'
  );
});

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

test('stable 3.3 pin gives a concise exact-beta suggestion', () => {
  assert.throws(
    () => sdk.resolveAdcpVersion('3.3.0'),
    error => {
      assert.ok(error.message.length < 600, error.message);
      assert.match(error.message, /3\.3\.0-beta\.0/);
      assert.match(error.message, /stable version does not select a prerelease/);
      return true;
    }
  );
});

test('video brief asset retains nonempty segment validation', () => {
  const asset = { asset_type: 'video_brief', segments: [{ order: 1, duration_ms: 1000, prompt: 'Product close-up' }] };
  assert.deepEqual(schemas.AssetVariantSchema.parse(asset), asset);
  assert.equal(schemas.AssetVariantSchema.safeParse({ ...asset, segments: [] }).success, false);
});

test('daypart target permits exactly one complete clock form', () => {
  const base = { days: ['monday'] };
  assert.equal(schemas.DaypartTargetSchema.safeParse({ ...base, start_hour: 6, end_hour: 10 }).success, true);
  assert.equal(
    schemas.DaypartTargetSchema.safeParse({ ...base, start_time: '19:30', end_time: '23:00' }).success,
    true
  );
  for (const times of [
    {},
    { start_hour: 6 },
    { start_time: '19:30' },
    { start_hour: 6, end_time: '23:00' },
    { start_hour: 6, end_hour: 10, start_time: '19:30', end_time: '23:00' },
  ]) {
    assert.equal(schemas.DaypartTargetSchema.safeParse({ ...base, ...times }).success, false, JSON.stringify(times));
  }
});

test('public asset schema output compiles against all entry points and the per-tool slice', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      'test/fixtures/types/sdk17-asset-variant.ts',
    ],
    { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(result.status, 0, result.stdout || result.stderr || String(result.error));
});

test('a server pinned to 3.0 preserves its native lifecycle status', async t => {
  const server = createAdcpServer({
    name: 'native30',
    version: '1',
    adcpVersion: '3.0.25',
    idempotency: 'disabled',
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: { createMediaBuy: async () => ({ media_buy_id: 'mb-native', status: 'active', packages: [] }) },
  });
  t.after(() => server.close());
  const response = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'create_media_buy', arguments: { adcp_major_version: 3 } },
  });
  assert.equal(response.structuredContent.status, 'active');
  assert.equal(response.structuredContent.media_buy_status, undefined);
});

test('explicit legacy-route contradictions veto inferred sibling index pairing', () => {
  const refs = [
    { agent_url: 'https://seller.example/formats', id: 'A' },
    { agent_url: 'https://seller.example/formats', id: 'B' },
  ];
  const options = [
    { format_kind: 'image', format_option_id: 'explicit', v1_format_ref: [refs[1]] },
    { format_kind: 'image', format_option_id: 'inferred' },
  ];
  const paired = withDualEmissionLegacyRefs(options, refs);
  assert.equal(paired, options);
  assert.deepEqual(legacyFormatRefsForDeclaration(paired[1]), []);
});

test('negotiated release takes precedence over a custom-reader fallback', async () => {
  const stream = sdk.streamAccountChanges(
    { listAccountChanges: async () => feedResult({ negotiatedAdcpVersion: '3.2' }) },
    { account, adcpVersion: sdk.ADCP_VERSION }
  );
  const result = await stream.next();
  assert.equal(result.done, false);
  await result.value.acknowledge(async () => {});
  assert.equal((await stream.next()).done, true);
});

test('custom feed readers without metadata can select a fallback release', async () => {
  const result = feedResult();
  delete result.metadata;
  const stream = sdk.streamAccountChanges(
    { listAccountChanges: async () => result },
    { account, adcpVersion: '3.2.7' }
  );
  const next = await stream.next();
  await next.value.acknowledge(async () => {});
  assert.equal((await stream.next()).done, true);
});

for (const adcpVersion of ['3.4', 'garbage', '3.0']) {
  test(`invalid feed version metadata ${adcpVersion} raises a drain error with the original result`, async () => {
    const result = feedResult({ adcpVersion });
    const stream = sdk.streamAccountChanges({ listAccountChanges: async () => result }, { account });
    await assert.rejects(
      stream.next(),
      error =>
        error instanceof sdk.AccountChangeDrainError &&
        error.code === 'account_change_page_invalid' &&
        error.result === result
    );
  });
}

test('3.0 lifecycle conversion keeps mirrored JSON text consistent', async t => {
  const data = { status: 'completed', media_buy_id: 'mb-json', media_buy_status: 'pending_creatives', packages: [] };
  const server = createAdcpServer({
    name: 'json-seller',
    version: '1',
    adcpVersion: sdk.ADCP_VERSION,
    defaultAdcpVersion: '3.1',
    capabilities: { supported_versions: ['3.0', '3.1', '3.2'] },
    idempotency: 'disabled',
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: {
      createMediaBuy: async () => ({
        structuredContent: data,
        content: [{ type: 'text', text: JSON.stringify(data) }],
      }),
    },
  });
  t.after(() => server.close());
  const response = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'create_media_buy', arguments: { adcp_major_version: 3 } },
  });
  assert.equal(response.structuredContent.status, 'pending_creatives');
  const mirrored = JSON.parse(response.content.find(part => part.type === 'text').text);
  assert.equal(mirrored.status, 'pending_creatives');
  assert.equal(mirrored.media_buy_status, undefined);
});

test('3.0 lifecycle adapters leave asynchronous and failed task statuses intact', () => {
  const { getVersionAdapter } = require('../../dist/lib/adapters/version');
  for (const tool of ['create_media_buy', 'update_media_buy']) {
    for (const status of ['working', 'submitted', 'failed', 'input-required']) {
      const data = { status, media_buy_status: 'pending_creatives', media_buy_id: 'mb-async' };
      assert.equal(getVersionAdapter('3.0', tool).downgradeResponse(data).data, data);
    }
  }
});

for (const tool of ['create_media_buy', 'update_media_buy']) {
  test(`${tool}: a 3.0 response without a seller lifecycle does not invent a completed buy`, async t => {
    const handler = async () => ({ media_buy_id: 'mb-no-lifecycle', packages: [] });
    const server = createAdcpServer({
      name: 'partial-seller',
      version: '1',
      adcpVersion: sdk.ADCP_VERSION,
      capabilities: { supported_versions: ['3.0', '3.1', '3.2'] },
      idempotency: 'disabled',
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { createMediaBuy: handler, updateMediaBuy: handler },
    });
    t.after(() => server.close());
    const response = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: tool, arguments: { adcp_major_version: 3 } },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    assert.equal(response.structuredContent.status, undefined);
    assert.equal(response.structuredContent.media_buy_status, undefined);
  });
}

test('an explicit completed buy lifecycle survives the 3.0 downgrade', () => {
  const { getVersionAdapter } = require('../../dist/lib/adapters/version');
  const data = { status: 'completed', media_buy_status: 'completed', media_buy_id: 'mb-finished' };
  const result = getVersionAdapter('3.0', 'create_media_buy').downgradeResponse(data).data;
  assert.equal(result.status, 'completed');
  assert.equal(result.media_buy_status, undefined);
});

test('asset schemas reject empty macro declarations while preserving optional omission', () => {
  const asset = {
    asset_type: 'display_tag',
    delivery_type: 'inline_markup',
    markup_type: 'standard',
    markup: '<div>Ad</div>',
  };
  assert.equal(schemas.AssetVariantSchema.safeParse(asset).success, true);
  assert.equal(schemas.AssetVariantSchema.safeParse({ ...asset, macro_declarations: [] }).success, false);
});

test('trusted wire metadata prevents a seller echo from relaxing account-feed validation', async () => {
  const stream = sdk.streamAccountChanges(
    { listAccountChanges: async () => feedResult({ wireAdcpVersion: sdk.ADCP_VERSION, adcpVersion: '3.2' }) },
    { account }
  );
  await assert.rejects(stream.next(), error => error.code === 'account_change_page_invalid');
});

test('custom-reader validation pin takes precedence over an unverified seller echo', async () => {
  const stream = sdk.streamAccountChanges(
    { listAccountChanges: async () => feedResult({ adcpVersion: '3.2' }) },
    { account, adcpVersion: sdk.ADCP_VERSION }
  );
  await assert.rejects(stream.next(), error => error.code === 'account_change_page_invalid');
});

test('executor metadata retains trusted same-release negotiation independently of the seller echo', async t => {
  const page = { ...feedResult().data, adcp_version: '3.2' };
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
  assert.equal(result.metadata.adcpVersion, '3.2');
  const stream = sdk.streamAccountChanges({ listAccountChanges: async () => result }, { account });
  await assert.rejects(stream.next(), error => error.code === 'account_change_page_invalid');
});
