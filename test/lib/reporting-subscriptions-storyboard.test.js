/**
 * The SDK reference seller passes the reporting-subscriptions storyboard over MCP, and a seller that
 * drops `prior_versions` from its readback fails it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { serve } = require('../../dist/lib/index.js');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

const STORYBOARD = parseStoryboard(
  fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'storyboards', 'reporting-subscriptions.yaml'), 'utf8')
);
const TOOLS = ['get_adcp_capabilities', 'sync_principal', 'get_principal', 'get_reporting_status'];

async function runAgainst(sellerOptions = {}) {
  const { createReportingSubscriptionsSeller } =
    await import('../../examples/reporting-subscriptions-seller/seller.mjs');
  const seller = createReportingSubscriptionsSeller({ store: new MemoryLedgerStore(), ...sellerOptions });
  const server = serve(seller.createServer, {
    port: 0,
    authenticate: () => ({ principal: 'storyboard-buyer' }),
    onListening: () => {},
  });
  if (!server.listening)
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  try {
    return await runStoryboard(`http://127.0.0.1:${server.address().port}/mcp`, STORYBOARD, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: TOOLS,
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function failedSteps(result) {
  return result.phases.flatMap(phase =>
    phase.steps.filter(step => !step.passed && !step.skipped).map(step => step.step_id)
  );
}

describe('reporting-subscriptions storyboard', () => {
  test('the reference seller passes every step', async () => {
    const result = await runAgainst();
    assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
    assert.equal(result.failed_count, 0, JSON.stringify(failedSteps(result)));
    assert.equal(result.skipped_count, 0, JSON.stringify(result, null, 2));
    assert.ok(result.passed_count >= 15, `ran ${result.passed_count} steps`);
  });

  test('fails a seller whose readback drops prior_versions', async () => {
    const dropPriorVersions = response => {
      for (const state of response?.result?.configuration?.reporting_subscriptions ?? []) delete state.prior_versions;
      return response;
    };
    const result = await runAgainst({
      wrapProtocol: protocol => ({
        ...protocol,
        syncPrincipal: async (params, ctx) => dropPriorVersions(await protocol.syncPrincipal(params, ctx)),
        getPrincipal: async (params, ctx) => dropPriorVersions(await protocol.getPrincipal(params, ctx)),
      }),
    });
    assert.equal(result.overall_passed, false);
    assert.deepEqual(failedSteps(result), ['apply_version_2', 'omit_subscription']);
    const failures = result.phases
      .flatMap(phase => phase.steps)
      .flatMap(step => (step.validations ?? []).filter(validation => !validation.passed));
    assert.ok(failures.length > 0);
    for (const failure of failures) assert.match(failure.path, /\.prior_versions\[0\]\./, JSON.stringify(failure));
  });
});
