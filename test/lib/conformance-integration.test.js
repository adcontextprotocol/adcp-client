// End-to-end test: runConformance against a live MCP agent served in-process.
// Exercises the full fuzz → oracle → report path.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { runConformance } = require('../../dist/lib/conformance/index.js');
const { serve, adcpError } = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');

const SIGNALS = [
  {
    signal_agent_segment_id: 'seg_auto_intenders',
    name: 'Auto Intenders',
    description: 'Users researching vehicle purchases',
    signal_type: 'marketplace',
    data_provider: 'DataCo',
    coverage_percentage: 12,
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_auto', model: 'cpm', cpm: 3.5, currency: 'USD' }],
    signal_id: { source: 'catalog', data_provider_domain: 'dataco.com', id: 'auto_intenders_30d' },
    value_type: 'binary',
  },
];

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

function makeSignalsServer() {
  return serve(
    () =>
      createAdcpServer({
        name: 'Conformance Test Signals Agent',
        version: '1.0.0',
        signals: {
          getSignals: async params => {
            // Honor the spec: if signal_ids is passed and none match, return
            // empty + a recoverable error. Otherwise return all signals.
            if (params.signal_ids && params.signal_ids.length > 0) {
              const matches = SIGNALS.filter(s =>
                params.signal_ids.some(id => id.source === 'catalog' && id.id === s.signal_id.id)
              );
              if (matches.length === 0) {
                return adcpError('REFERENCE_NOT_FOUND', 'No signals matched the requested IDs');
              }
              return { signals: matches };
            }
            return { signals: SIGNALS };
          },
        },
      }),
    { port: 0, onListening: () => {} }
  );
}

describe('conformance: integration', () => {
  let httpServer;
  let port;

  test('setup: start in-process MCP signals agent', async () => {
    httpServer = makeSignalsServer();
    await waitForListening(httpServer);
    port = httpServer.address().port;
  });

  after(() => {
    if (httpServer) httpServer.close();
  });

  test('runConformance against get_signals returns zero failures', async () => {
    const report = await runConformance(`http://localhost:${port}/mcp`, {
      seed: 42,
      tools: ['get_signals'],
      turnBudget: 10,
      protocol: 'mcp',
    });

    assert.equal(report.totalFailures, 0, `unexpected failures: ${JSON.stringify(report.failures, null, 2)}`);
    assert.ok(report.perTool.get_signals, 'get_signals stats should be recorded');
    assert.equal(report.perTool.get_signals.skipped, false);
    assert.ok(report.perTool.get_signals.runs > 0, 'should have executed runs');
    assert.equal(
      report.perTool.get_signals.accepted + report.perTool.get_signals.rejected,
      report.perTool.get_signals.runs,
      'every fresh run should be accepted or rejected'
    );
    assert.equal(typeof report.schemaVersion, 'string', 'schemaVersion should be populated');
    assert.ok(report.schemaVersion.length > 0);
  });

  test('same seed → identical report (determinism)', async () => {
    const url = `http://localhost:${port}/mcp`;
    const a = await runConformance(url, { seed: 99, tools: ['get_signals'], turnBudget: 5, protocol: 'mcp' });
    const b = await runConformance(url, { seed: 99, tools: ['get_signals'], turnBudget: 5, protocol: 'mcp' });
    assert.equal(a.perTool.get_signals.runs, b.perTool.get_signals.runs);
    assert.equal(a.perTool.get_signals.accepted, b.perTool.get_signals.accepted);
    assert.equal(a.perTool.get_signals.rejected, b.perTool.get_signals.rejected);
  });

  test('oracle catches a broken agent: returns lowercase reason code', async () => {
    const brokenServer = serve(
      () =>
        createAdcpServer({
          name: 'Broken Agent',
          version: '1.0.0',
          signals: {
            getSignals: async () => adcpError('not_found', 'lowercase code violates spec'),
          },
        }),
      { port: 0, onListening: () => {} }
    );
    await waitForListening(brokenServer);
    const brokenPort = brokenServer.address().port;
    try {
      const report = await runConformance(`http://localhost:${brokenPort}/mcp`, {
        seed: 1,
        tools: ['get_signals'],
        turnBudget: 3,
        protocol: 'mcp',
      });
      assert.ok(report.totalFailures >= 1, 'broken agent should produce at least one failure');
      const failure = report.failures[0];
      assert.equal(failure.tool, 'get_signals');
      assert.equal(failure.verdict, 'invalid');
      assert.ok(
        failure.invariantFailures.some(m => m.includes('uppercase-snake')),
        `expected uppercase-snake failure, got: ${failure.invariantFailures.join('; ')}`
      );
      assert.equal(typeof failure.seed, 'number', 'failure should include reproducible seed');
    } finally {
      brokenServer.close();
    }
  });

  test('fixtures: fixture-supplied creative_ids drive list_creatives to the happy path', async () => {
    // Agent that ONLY accepts its one known creative_id — otherwise empty.
    // With a matching fixture, runConformance should produce all-accepted runs
    // (vs. all-rejected if fixtures weren't plumbed).
    let sawFixtureId = 0;
    const creativeServer = serve(
      () =>
        createAdcpServer({
          name: 'Creative Fixture Agent',
          version: '1.0.0',
          creative: {
            listCreatives: async params => {
              const ids = params?.filters?.creative_ids ?? [];
              if (ids.includes('cre_fixture_only')) sawFixtureId++;
              return { creatives: [] };
            },
          },
        }),
      { port: 0, onListening: () => {} }
    );
    await waitForListening(creativeServer);
    const creativePort = creativeServer.address().port;
    try {
      const report = await runConformance(`http://localhost:${creativePort}/mcp`, {
        seed: 31,
        tools: ['list_creatives'],
        turnBudget: 5,
        protocol: 'mcp',
        fixtures: { creative_ids: ['cre_fixture_only'] },
      });
      assert.equal(report.totalFailures, 0);
      assert.ok(sawFixtureId > 0, 'the fixture creative_id should have reached the agent at least once');
    } finally {
      creativeServer.close();
    }
  });

  test('unspecified tool list defaults to stateless tier', async () => {
    const report = await runConformance(`http://localhost:${port}/mcp`, {
      seed: 7,
      turnBudget: 2,
      protocol: 'mcp',
    });
    // Every stateless-tier tool should have an entry; most will be skipped
    // because the test agent only implements get_signals, but get_signals
    // itself must have runs.
    assert.ok(report.perTool.get_signals.runs > 0);
    // The other tools either run (agent returns UNSUPPORTED error, rejected)
    // or don't — either way the slot is recorded.
    for (const tool of Object.keys(report.perTool)) {
      assert.ok(report.perTool[tool], `missing entry for ${tool}`);
    }
  });
});
