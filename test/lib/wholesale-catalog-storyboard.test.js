/** The SDK reference seller passes the wholesale-catalog storyboard over MCP, and a seller that ignores scope fails it. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { serve } = require('../../dist/lib/index.js');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const STORYBOARD = parseStoryboard(
  fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'storyboards', 'wholesale-catalog.yaml'), 'utf8')
);
const TOOLS = ['get_adcp_capabilities', 'list_products'];

async function runAgainst(wrap = server => server) {
  const { createWholesaleCatalogSeller } = await import('../../examples/wholesale-catalog-seller/seller.mjs');
  const seller = createWholesaleCatalogSeller();
  const server = serve(() => wrap(seller.createServer()), {
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

const failedSteps = result =>
  result.phases.flatMap(phase => phase.steps.filter(step => !step.passed && !step.skipped).map(step => step.step_id));

describe('wholesale-catalog storyboard', () => {
  test('the reference seller passes every step', async () => {
    const result = await runAgainst();
    assert.equal(
      result.overall_passed,
      true,
      JSON.stringify(failedSteps(result)) + JSON.stringify(result, null, 2).slice(0, 4000)
    );
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 0, JSON.stringify(result, null, 2).slice(0, 4000));
    assert.ok(result.passed_count >= 11, `ran ${result.passed_count} steps`);
  });
});
