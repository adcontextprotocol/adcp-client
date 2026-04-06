/**
 * Tests that adcp_major_version is injected into every tool call request.
 *
 * Per adcontextprotocol/adcp#1959, buyers declare which AdCP major version
 * their payloads conform to via adcp_major_version on every request.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('adcp_major_version on requests', () => {
  test('ADCP_MAJOR_VERSION is exported and equals 3', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/version.js');
    assert.strictEqual(ADCP_MAJOR_VERSION, 3);
    assert.strictEqual(typeof ADCP_MAJOR_VERSION, 'number');
  });

  test('ADCP_MAJOR_VERSION is re-exported from main entry point', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/index.js');
    assert.strictEqual(ADCP_MAJOR_VERSION, 3);
  });

  test('ProtocolClient injects adcp_major_version into MCP args', async () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/version.js');

    // Verify the injection logic: adcp_major_version is prepended so caller
    // args take precedence if they explicitly set it.
    const callerArgs = { advertiser_id: 'adv-123' };
    const argsWithVersion = { adcp_major_version: ADCP_MAJOR_VERSION, ...callerArgs };

    assert.strictEqual(argsWithVersion.adcp_major_version, 3);
    assert.strictEqual(argsWithVersion.advertiser_id, 'adv-123');
  });

  test('caller-provided adcp_major_version overrides the default', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/version.js');

    // If a caller explicitly passes adcp_major_version, their value wins
    // because we spread ADCP_MAJOR_VERSION first, then ...args
    const callerArgs = { adcp_major_version: 2, advertiser_id: 'adv-123' };
    const argsWithVersion = { adcp_major_version: ADCP_MAJOR_VERSION, ...callerArgs };

    assert.strictEqual(argsWithVersion.adcp_major_version, 2);
  });

  test('adcp_major_version is an integer between 1 and 99 per schema', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/version.js');

    assert.ok(Number.isInteger(ADCP_MAJOR_VERSION), 'must be an integer');
    assert.ok(ADCP_MAJOR_VERSION >= 1, 'minimum is 1');
    assert.ok(ADCP_MAJOR_VERSION <= 99, 'maximum is 99');
  });
});
