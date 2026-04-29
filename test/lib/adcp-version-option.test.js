// Stage 2 plumbing: `adcpVersion` constructor option on client + server
// surfaces. Verifies the option is accepted, defaults to the SDK's pinned
// ADCP_VERSION, and is reflected by `getAdcpVersion()`. Wire-shape effects
// land in Stage 3 — these tests guard the surface contract.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ADCP_VERSION,
  ADCP_MAJOR_VERSION,
  SingleAgentClient,
  AgentClient,
  ADCPMultiAgentClient,
  createAdcpServer,
  parseAdcpMajorVersion,
  resolveAdcpVersion,
} = require('../../dist/lib/index.js');

const TEST_AGENT = {
  id: 'test-agent',
  name: 'Test Agent',
  agent_uri: 'https://example.com',
  protocol: 'mcp',
};

describe('adcpVersion constructor option', () => {
  describe('SingleAgentClient', () => {
    test('defaults to ADCP_VERSION when not provided', () => {
      const client = new SingleAgentClient(TEST_AGENT);
      assert.strictEqual(client.getAdcpVersion(), ADCP_VERSION);
    });

    test('returns the configured value when provided', () => {
      const client = new SingleAgentClient(TEST_AGENT, { adcpVersion: '3.0.0' });
      assert.strictEqual(client.getAdcpVersion(), '3.0.0');
    });
  });

  describe('AgentClient', () => {
    test('defaults to ADCP_VERSION when not provided', () => {
      const client = new AgentClient(TEST_AGENT);
      assert.strictEqual(client.getAdcpVersion(), ADCP_VERSION);
    });

    test('returns the configured value when provided', () => {
      const client = new AgentClient(TEST_AGENT, { adcpVersion: '3.0.0' });
      assert.strictEqual(client.getAdcpVersion(), '3.0.0');
    });
  });

  describe('ADCPMultiAgentClient', () => {
    test('defaults to ADCP_VERSION when not provided', () => {
      const client = new ADCPMultiAgentClient([TEST_AGENT]);
      assert.strictEqual(client.getAdcpVersion(), ADCP_VERSION);
    });

    test('returns the configured value when provided', () => {
      const client = new ADCPMultiAgentClient([TEST_AGENT], { adcpVersion: '3.0.0' });
      assert.strictEqual(client.getAdcpVersion(), '3.0.0');
    });
  });

  describe('createAdcpServer', () => {
    test('defaults to ADCP_VERSION when not provided', () => {
      const server = createAdcpServer({ name: 'test-server', version: '1.0.0' });
      assert.strictEqual(server.getAdcpVersion(), ADCP_VERSION);
    });

    test('returns the configured value when provided', () => {
      const server = createAdcpServer({
        name: 'test-server',
        version: '1.0.0',
        adcpVersion: '3.0.0',
      });
      assert.strictEqual(server.getAdcpVersion(), '3.0.0');
    });

    test('config.version (app version) and adcpVersion are independent', () => {
      const server = createAdcpServer({
        name: 'test-server',
        version: '7.4.2', // publisher app version
        adcpVersion: '3.0.0', // protocol version
      });
      assert.strictEqual(server.getAdcpVersion(), '3.0.0');
    });
  });

  describe('parseAdcpMajorVersion', () => {
    test('extracts major from semver', () => {
      assert.strictEqual(parseAdcpMajorVersion('3.0.1'), 3);
      assert.strictEqual(parseAdcpMajorVersion('3.0.0'), 3);
      assert.strictEqual(parseAdcpMajorVersion('4.0.0'), 4);
    });

    test('handles legacy v-prefix aliases', () => {
      assert.strictEqual(parseAdcpMajorVersion('v3'), 3);
      assert.strictEqual(parseAdcpMajorVersion('v2.5'), 2);
    });

    test('returns NaN for unparseable input', () => {
      assert.ok(Number.isNaN(parseAdcpMajorVersion('abc')));
      assert.ok(Number.isNaN(parseAdcpMajorVersion('')));
    });
  });

  describe('resolveAdcpVersion validation', () => {
    test('returns the default when undefined', () => {
      assert.strictEqual(resolveAdcpVersion(undefined), ADCP_VERSION);
    });

    test('accepts pins that resolve to a bundled version', () => {
      // SDK ships bundle for ADCP_VERSION's minor; '3.0.0' / '3.0.1' / '3.0'
      // all collapse to that bundle and accept.
      assert.strictEqual(resolveAdcpVersion('3.0.0'), '3.0.0');
      assert.strictEqual(resolveAdcpVersion('3.0.1'), '3.0.1');
      assert.strictEqual(resolveAdcpVersion('3.0'), '3.0');
    });

    test('rejects pins for which no schema bundle ships', () => {
      // Stage 3 lifts the Stage 2 cross-major fence; the new gate is
      // "schemas exist for this pin". '4.0.0' has no bundle in this build.
      assert.throws(
        () => resolveAdcpVersion('4.0.0'),
        err =>
          err.code === 'CONFIGURATION_ERROR' &&
          /no schema bundle for that key ships/.test(err.message) &&
          /sync-schemas/.test(err.message)
      );
    });

    test('rejects unparseable strings with helpful message', () => {
      assert.throws(
        () => resolveAdcpVersion('not-a-version'),
        err => err.code === 'CONFIGURATION_ERROR' && /not a valid AdCP version/.test(err.message)
      );
    });

    test('SingleAgentClient surfaces validation error at construction', () => {
      assert.throws(
        () => new SingleAgentClient(TEST_AGENT, { adcpVersion: '4.0.0' }),
        err => err.code === 'CONFIGURATION_ERROR'
      );
    });

    test('createAdcpServer surfaces validation error at construction', () => {
      assert.throws(
        () => createAdcpServer({ name: 't', version: '1.0.0', adcpVersion: '4.0.0' }),
        err => err.code === 'CONFIGURATION_ERROR'
      );
    });
  });
});
