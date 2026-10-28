const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { projectResponseForRelease, downgradeResponse } = require('@adcp/sdk/adapters/version');

for (const toolName of ['create_media_buy', 'update_media_buy']) {
  for (const servedVersion of ['3.0', '3.1', '3.2']) {
    test(`${toolName}: public projection matches the framework for ${servedVersion}`, async () => {
      const payload = {
        media_buy_id: 'mb_1',
        buyer_ref: 'buyer_1',
        status: 'completed',
        media_buy_status: 'pending_creatives',
        packages: [],
        valid_actions: ['cancel'],
        revision: 1,
        confirmed_at: '2027-01-01T00:00:00Z',
      };
      const before = structuredClone(payload);
      const projected = projectResponseForRelease(toolName, payload, servedVersion, '3.2.7');
      const server = createAdcpServer({
        name: 'Projection parity',
        version: '1.0.0',
        adcpVersion: '3.2.7',
        capabilities: { supported_versions: ['3.0', '3.1', '3.2'] },
        validation: { requests: 'off', responses: 'off' },
        mediaBuy: {
          createMediaBuy: async () => structuredClone(payload),
          updateMediaBuy: async () => structuredClone(payload),
        },
      });
      try {
        const response = await server.dispatchTestRequest({
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: { adcp_version: servedVersion, media_buy_id: 'mb_1' },
          },
        });
        assert.notEqual(response.isError, true, JSON.stringify(response));
        const body = { ...response.structuredContent };
        // The framework owns version-envelope stamping after conversion.
        delete body.adcp_version;
        assert.deepEqual(body, projected);
        assert.deepEqual(payload, before);
        assert.deepEqual(
          downgradeResponse(toolName, payload, {
            fromVersion: '3.2.7',
            toVersion: servedVersion,
          }).data,
          projected
        );
        if (servedVersion === '3.0') {
          assert.equal(projected.status, 'pending_creatives');
          assert.equal(projected.media_buy_status, undefined);
        }
      } finally {
        await server.close();
      }
    });
  }
}

test('ESM and CJS consumers can import the public converter', async () => {
  const esm = await import('@adcp/sdk/adapters/version');
  assert.equal(typeof esm.projectResponseForRelease, 'function');
  assert.equal(typeof esm.downgradeResponse, 'function');
});

for (const servedVersion of [undefined, '', 'typo', '2.6', '3.9']) {
  test(`projection refuses invalid or newer served versions: ${servedVersion}`, () => {
    assert.throws(() => projectResponseForRelease('create_media_buy', {}, servedVersion), /valid AdCP 3/);
  });
}

test('projection treats stable patches as one schema line and refuses unmatched previews', () => {
  const payload = { marker: 'same contract' };
  assert.deepEqual(projectResponseForRelease('create_media_buy', payload, '3.2.7', '3.2.1'), payload);
  for (const target of ['3.3.0', '3.3.0-beta.1']) {
    assert.throws(
      () => projectResponseForRelease('create_media_buy', payload, target, '3.3.0-beta.0'),
      /matching same-line previews/
    );
  }
  assert.throws(() => projectResponseForRelease('create_media_buy', payload, '3.0', '3.9'), /schema bundles/);
});

test('projection defaults the source to the SDK pin', () => {
  const { ADCP_VERSION } = require('../../dist/lib/version');
  const payload = { media_buy_id: 'mb_1', status: 'completed', media_buy_status: 'pending_creatives', packages: [] };
  assert.deepEqual(
    projectResponseForRelease('create_media_buy', payload, '3.0'),
    downgradeResponse('create_media_buy', payload, {
      fromVersion: ADCP_VERSION,
      toVersion: '3.0',
    }).data
  );
});
