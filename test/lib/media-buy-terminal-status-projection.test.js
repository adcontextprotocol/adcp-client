const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { cancelMediaBuyResponse } = require('../../dist/lib/server/responses');
const { ADCP_VERSION } = require('../../dist/lib/version');

for (const release of ['3.0', '3.1', '3.2', ADCP_VERSION.replace(/^(\d+\.\d+)\.\d+/, '$1')]) {
  for (const lifecycle of ['canceled', 'completed', 'rejected']) {
    test(`${release}: legacy terminal lifecycle ${lifecycle} stays distinct from task completion`, async t => {
      const server = createAdcpServer({
        name: 'terminal-lifecycle',
        version: '1',
        adcpVersion: ADCP_VERSION,
        idempotency: 'disabled',
        validation: { requests: 'off', responses: 'off' },
        mediaBuy: { updateMediaBuy: async () => ({ media_buy_id: 'mb-terminal', status: lifecycle }) },
      });
      t.after(() => server.close());
      const response = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'update_media_buy',
          arguments: { adcp_version: release, media_buy_id: 'mb-terminal' },
        },
      });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      assert.equal(response.structuredContent.status, release === '3.0' ? lifecycle : 'completed');
      assert.equal(response.structuredContent.media_buy_status, release === '3.0' ? undefined : lifecycle);
    });
  }
  test(`${release}: cancel builder carries explicit lifecycle before status normalization`, async t => {
    const server = createAdcpServer({
      name: 'cancel-lifecycle',
      version: '1',
      adcpVersion: ADCP_VERSION,
      idempotency: 'disabled',
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: {
        updateMediaBuy: async () =>
          cancelMediaBuyResponse({ media_buy_id: 'mb-terminal', revision: 2, canceled_by: 'buyer' }),
      },
    });
    t.after(() => server.close());
    const response = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: { adcp_version: release, media_buy_id: 'mb-terminal' },
      },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.equal(response.structuredContent.status, release === '3.0' ? 'canceled' : 'completed');
    assert.equal(response.structuredContent.media_buy_status, release === '3.0' ? undefined : 'canceled');
  });
}
