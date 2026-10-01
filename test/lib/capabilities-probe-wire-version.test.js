/**
 * The storyboard/comply capabilities probe must put the release-precision wire
 * pin on the wire and in its diagnostics — never the internal bundle id.
 *
 * AdCP versioning: `adcp_version` is `MAJOR.MINOR[-PRERELEASE]`. Bundle ids such
 * as `3.2.1` or `3.2.0-rc.7` key schema/compliance caches only; they collapse to
 * `3.2` / `3.2-rc.7` before emit.
 *
 * Regression: against adcp (Python) 8.0.0b18, which echoes the rejected pin as
 * `details.claimed_version`, the probe reported `requested "3.2.1"` because the
 * diagnostic fell back to the bundle id when the seller didn't use the
 * canonical echo key. The wire already carried `"3.2"`.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  createTestClient,
  describeVersionUnsupported,
  discoverAgentProfile,
  testClientWireAdcpVersion,
} = require('../../dist/lib/testing/client.js');

const CASES = [
  { bundle: '3.2.1', wire: '3.2' },
  { bundle: '3.2.0-rc.7', wire: '3.2-rc.7' },
  { bundle: '3.1.24', wire: '3.1' },
];

function versionUnsupportedResult(details) {
  return {
    success: false,
    adcpError: { code: 'VERSION_UNSUPPORTED', message: 'unsupported', ...(details && { details }) },
  };
}

describe('testClientWireAdcpVersion', () => {
  for (const { bundle, wire } of CASES) {
    test(`bundle ${bundle} -> wire ${wire}`, () => {
      assert.strictEqual(testClientWireAdcpVersion({ getAdcpVersion: () => bundle }), wire);
      assert.strictEqual(testClientWireAdcpVersion({}, bundle), wire);
    });
  }

  test('real test client: 3.2.1 pin probes as 3.2', () => {
    const client = createTestClient('https://seller.example/mcp', 'mcp', { adcpVersion: '3.2.1' });
    assert.strictEqual(testClientWireAdcpVersion(client), '3.2');
  });

  test('real test client: wireAdcpVersion override wins and is collapsed', () => {
    const client = createTestClient('https://seller.example/mcp', 'mcp', {
      adcpVersion: '3.2.1',
      wireAdcpVersion: '3.2.0-rc.7',
    });
    assert.strictEqual(testClientWireAdcpVersion(client), '3.2-rc.7');
  });
});

describe('describeVersionUnsupported never reports a bundle id', () => {
  for (const { bundle, wire } of CASES) {
    test(`seller without echo, bundle ${bundle} -> requested "${wire}"`, () => {
      const message = describeVersionUnsupported(versionUnsupportedResult({ supported_versions: ['3.0'] }), bundle);
      assert.strictEqual(message, `VERSION_UNSUPPORTED: requested "${wire}"; seller supports "3.0"`);
    });
  }

  test('prefers the seller echo (claimed_version, Python seller shape)', () => {
    const message = describeVersionUnsupported(
      versionUnsupportedResult({ claimed_version: '3.2', supported_versions: ['3.0', '3.1', '3.2-rc.7', '2.5'] }),
      '3.2.1'
    );
    assert.strictEqual(
      message,
      'VERSION_UNSUPPORTED: requested "3.2"; seller supports "3.0", "3.1", "3.2-rc.7", "2.5"'
    );
  });

  test('ignores an integer claimed_version (adcp_major_version echo)', () => {
    const message = describeVersionUnsupported(
      versionUnsupportedResult({ claimed_version: 3, supported_versions: ['2.5'] }),
      '3.2.1'
    );
    assert.strictEqual(message, 'VERSION_UNSUPPORTED: requested "3.2"; seller supports "2.5"');
  });
});

describe('capabilities probe over MCP sends the wire pin', () => {
  let server;
  let baseUrl;
  /** @type {unknown[]} adcp_version values seen on get_adcp_capabilities */
  const seen = [];

  before(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const rpc = body ? JSON.parse(body) : undefined;
      const reply = result => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (!rpc || rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (rpc.method === 'initialize') {
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe-recorder', version: '1.0.0' },
        });
      }
      if (rpc.method === 'tools/list') {
        return reply({
          tools: [
            { name: 'get_adcp_capabilities', inputSchema: { type: 'object' } },
            { name: 'get_products', inputSchema: { type: 'object' } },
          ],
        });
      }
      if (rpc.method === 'tools/call') {
        const args = rpc.params?.arguments ?? {};
        seen.push(args.adcp_version);
        // adcp (Python) 8.0.0b18 shape: echo under `claimed_version` is
        // deliberately omitted here so the test exercises the fallback path.
        const payload = {
          adcp_error: {
            code: 'VERSION_UNSUPPORTED',
            message: 'unsupported',
            details: { supported_versions: ['3.0'] },
          },
        };
        return reply({
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        });
      }
      res.writeHead(400).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  const e2eCases = [
    { label: 'bundle 3.2.1', options: { adcpVersion: '3.2.1' }, wire: '3.2' },
    { label: 'rc.7 wire bundle', options: { adcpVersion: '3.2.1', wireAdcpVersion: '3.2.0-rc.7' }, wire: '3.2-rc.7' },
    { label: 'bundle 3.1.24', options: { adcpVersion: '3.1.24' }, wire: '3.1' },
  ];

  for (const { label, options, wire } of e2eCases) {
    test(`${label}: sends and reports "${wire}"`, async () => {
      seen.length = 0;
      const client = createTestClient(baseUrl, 'mcp', options);
      const { profile } = await discoverAgentProfile(client, undefined, options.adcpVersion);
      assert.ok(seen.length >= 1, 'probe should call get_adcp_capabilities');
      for (const sent of seen) assert.strictEqual(sent, wire);
      assert.strictEqual(
        profile.capabilities_probe_error,
        `VERSION_UNSUPPORTED: requested "${wire}"; seller supports "3.0"`
      );
    });
  }
});
