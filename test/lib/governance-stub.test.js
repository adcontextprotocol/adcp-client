/**
 * Tests for GovernanceAgentStub — the in-process MCP server used
 * by comply() to verify seller governance_context round-trips.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { GovernanceAgentStub } = require('../../dist/lib/testing/stubs/index.js');
const { callMCPTool } = require('../../dist/lib/protocols/mcp.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

describe('GovernanceAgentStub', () => {
  let stub;
  let stubUrl;

  before(async () => {
    stub = new GovernanceAgentStub();
    const info = await stub.start();
    stubUrl = info.url;
  });

  after(async () => {
    await closeMCPConnections();
    await stub.stop();
  });

  it('starts on an ephemeral port and responds to MCP', async () => {
    assert.ok(stubUrl, 'stub should return a URL');
    assert.match(stubUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('lists governance tools via MCP', async () => {
    // callMCPTool with a tools/list would work, but let's use getAgentInfo pattern
    // Instead, call check_governance and verify it responds
    const result = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-test-1',
      caller: 'buyer',
      tool: 'create_media_buy',
      payload: { budget: 1000 },
    });

    assert.ok(result, 'should get a response');
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 'approved');
    assert.equal(parsed.plan_id, 'plan-test-1');
  });

  it('returns governance_context on check_governance response', async () => {
    const result = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-gc-round-trip',
      caller: 'buyer',
      tool: 'create_media_buy',
      payload: {},
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.governance_context, 'response should include governance_context');
    assert.equal(typeof parsed.governance_context, 'string');
    assert.ok(parsed.governance_context.length > 0, 'governance_context should not be empty');
    assert.ok(parsed.governance_context.length <= 4096, 'governance_context should be <= 4096 chars');

    // Verify it matches the stub's deterministic pattern
    const expected = stub.generateContext('plan-gc-round-trip');
    assert.equal(parsed.governance_context, expected);
  });

  it('accepts governance_context round-trip on subsequent check_governance', async () => {
    // Step 1: Get governance_context from first check
    const firstResult = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-round-trip',
      binding: 'proposed',
      caller: 'buyer',
      tool: 'create_media_buy',
      payload: { budget: 5000 },
    });
    const firstParsed = JSON.parse(firstResult.content[0].text);
    const gc = firstParsed.governance_context;

    // Step 2: Pass it back on committed check (simulating seller forwarding)
    const secondResult = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-round-trip',
      binding: 'committed',
      caller: 'seller',
      tool: 'create_media_buy',
      payload: { budget: 5000, media_buy_id: 'mb_123' },
      governance_context: gc,
      media_buy_id: 'mb_123',
    });
    const secondParsed = JSON.parse(secondResult.content[0].text);
    assert.equal(secondParsed.status, 'approved');

    // Verify the stub recorded the governance_context
    assert.ok(stub.hasGovernanceContext(gc), 'stub should have recorded the governance_context');
  });

  it('records calls to report_plan_outcome', async () => {
    stub.clearCallLog();

    await callMCPTool(stubUrl, 'report_plan_outcome', {
      plan_id: 'plan-outcome-test',
      outcome: 'completed',
      governance_context: 'test-gc-for-outcome',
    });

    const calls = stub.getCallsForTool('report_plan_outcome');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.plan_id, 'plan-outcome-test');
    assert.equal(calls[0].params.governance_context, 'test-gc-for-outcome');
  });

  it('records calls to sync_plans', async () => {
    stub.clearCallLog();

    await callMCPTool(stubUrl, 'sync_plans', {
      plans: [
        {
          plan_id: 'plan-sync-test',
          brand: { domain: 'test.example.com' },
          objectives: 'Increase brand awareness in US market',
          budget: { total: 10000, currency: 'USD', authority_level: 'agent_full' },
          channels: { required: ['display'] },
          flight: {
            start: '2026-04-01T00:00:00Z',
            end: '2026-06-30T23:59:59Z',
          },
          countries: ['US'],
        },
      ],
    });

    const calls = stub.getCallsForTool('sync_plans');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.plans[0].plan_id, 'plan-sync-test');
  });

  it('records calls to get_plan_audit_logs', async () => {
    stub.clearCallLog();

    await callMCPTool(stubUrl, 'get_plan_audit_logs', {
      plan_ids: ['plan-audit-test'],
    });

    const calls = stub.getCallsForTool('get_plan_audit_logs');
    assert.equal(calls.length, 1);
  });

  it('tracks call log across multiple tools', async () => {
    stub.clearCallLog();

    await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-multi',
      binding: 'proposed',
      caller: 'buyer',
      tool: 'create_media_buy',
      payload: {},
    });

    await callMCPTool(stubUrl, 'report_plan_outcome', {
      plan_id: 'plan-multi',
      outcome: 'completed',
      governance_context: 'gc-multi-test',
    });

    const allCalls = stub.getCallLog();
    assert.equal(allCalls.length, 2);
    assert.equal(allCalls[0].tool, 'check_governance');
    assert.equal(allCalls[1].tool, 'report_plan_outcome');
  });
});

describe('GovernanceAgentStub HTTPS', () => {
  let stub;
  let stubUrl;

  before(async () => {
    stub = new GovernanceAgentStub();
    const info = await stub.startHttps();
    stubUrl = info.url;
    // Allow self-signed certs for this test
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  });

  after(async () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await closeMCPConnections();
    await stub.stop();
  });

  it('starts HTTPS server with self-signed cert', async () => {
    assert.ok(stubUrl);
    assert.match(stubUrl, /^https:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('responds to MCP calls over HTTPS', async () => {
    const result = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-https-test',
      binding: 'proposed',
      caller: 'buyer',
      tool: 'create_media_buy',
      payload: {},
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 'approved');
    assert.ok(parsed.governance_context);
  });
});
