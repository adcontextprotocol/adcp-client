/**
 * Regression tests for single-field VERSION_UNSUPPORTED enforcement in
 * createAdcpServer per spec PR adcontextprotocol/adcp#3493.
 *
 * The server's major_versions advertised in get_adcp_capabilities is a
 * binding declaration. A request carrying only adcp_major_version or only
 * adcp_version whose major is outside that set MUST be rejected even when
 * requestValidationMode is 'off' (the production default).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { extractVersionUnsupportedDetails } = require('../../dist/lib/index.js');

function makeServer(capabilitiesOverrides = {}) {
  return createAdcpServer({
    name: 'TestVersionServer',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    capabilities: capabilitiesOverrides,
    mediaBuy: {
      createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [] }),
    },
  });
}

async function dispatch(server, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'create_media_buy', arguments: args },
  });
}

describe('createAdcpServer single-field VERSION_UNSUPPORTED', () => {
  it('rejects adcp_major_version: 99 alone on default 3.0-pinned server', async () => {
    const server = makeServer();
    const result = await dispatch(server, { adcp_major_version: 99 });
    assert.ok(result.isError, 'response should be an error');
    const err = result.structuredContent?.adcp_error;
    assert.equal(err?.code, 'VERSION_UNSUPPORTED');
    const details = extractVersionUnsupportedDetails(err);
    assert.ok(Array.isArray(details?.supported_versions), 'should populate supported_versions');
    assert.deepEqual(details.supported_versions, ['3.0']);
  });

  it('rejects adcp_version: "99.0" alone on default 3.0-pinned server', async () => {
    const server = makeServer();
    const result = await dispatch(server, { adcp_version: '99.0' });
    assert.ok(result.isError, 'response should be an error');
    const err = result.structuredContent?.adcp_error;
    assert.equal(err?.code, 'VERSION_UNSUPPORTED');
    const details = extractVersionUnsupportedDetails(err);
    assert.ok(Array.isArray(details?.supported_versions), 'should populate supported_versions');
    assert.deepEqual(details.supported_versions, ['3.0']);
    assert.equal(details.requested_version, '99.0');
  });

  it('allows adcp_major_version: 3 on default 3.0-pinned server', async () => {
    const server = makeServer();
    const result = await dispatch(server, { adcp_major_version: 3 });
    const err = result.structuredContent?.adcp_error;
    assert.notEqual(err?.code, 'VERSION_UNSUPPORTED', 'supported major should not trigger VERSION_UNSUPPORTED');
  });

  it('existing dual-field disagreement still returns VERSION_UNSUPPORTED', async () => {
    const server = makeServer();
    // adcp_version major (3) disagrees with adcp_major_version (99)
    const result = await dispatch(server, { adcp_version: '3.1', adcp_major_version: 99 });
    assert.ok(result.isError, 'dual-field disagreement should be an error');
    const err = result.structuredContent?.adcp_error;
    assert.equal(err?.code, 'VERSION_UNSUPPORTED');
  });
});
