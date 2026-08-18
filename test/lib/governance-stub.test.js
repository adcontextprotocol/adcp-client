/**
 * Tests for GovernanceAgentStub — the in-process MCP server used
 * by comply() to verify seller governance_context round-trips.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { Agent, fetch: undiciFetch } = require('undici');

const { GovernanceAgentStub } = require('../../dist/lib/testing/stubs/index.js');
const { callMCPTool } = require('../../dist/lib/protocols/mcp.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { InMemoryGovernanceReplayStore } = require('../../dist/lib/governance/index.js');
const { createAdcpGovernanceEnforcementMiddleware } = require('../../dist/lib/server/governance.js');

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
      caller: 'https://buyer.example',
      target_agent: 'https://seller.example/mcp',
      tool: 'create_media_buy',
      payload: { total_budget: 1000, currency: 'USD' },
    });

    assert.ok(result, 'should get a response');
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.verdict, 'approved');
    assert.equal(parsed.plan_id, 'plan-test-1');
  });

  it('returns governance_context on check_governance response', async () => {
    const result = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-gc-round-trip',
      caller: 'https://buyer.example',
      target_agent: 'https://seller.example/mcp',
      tool: 'create_media_buy',
      payload: { total_budget: 1000, currency: 'USD' },
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.governance_context, 'response should include governance_context');
    assert.equal(typeof parsed.governance_context, 'string');
    assert.ok(parsed.governance_context.length > 0, 'governance_context should not be empty');
    assert.ok(parsed.governance_context.length <= 4096, 'governance_context should be <= 4096 chars');

    assert.equal(parsed.governance_context.split('.').length, 3, 'governance_context should be a compact JWS');
    assert.equal(stub.publicJwk.adcp_use, 'governance-signing');
  });

  it('accepts governance_context round-trip on subsequent check_governance', async () => {
    // Step 1: Get governance_context from first check
    const firstResult = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-round-trip',
      caller: 'https://buyer.example',
      target_agent: 'https://seller.example/mcp',
      tool: 'create_media_buy',
      payload: { total_budget: 5000, currency: 'USD' },
    });
    const firstParsed = JSON.parse(firstResult.content[0].text);
    const gc = firstParsed.governance_context;

    // Step 2: Pass it back on committed check (simulating seller forwarding)
    const secondResult = await callMCPTool(stubUrl, 'check_governance', {
      caller: 'https://seller.example/mcp',
      governance_context: gc,
      planned_delivery: { total_budget: 5000, currency: 'USD' },
      execution_commitment: { amount: 5000, currency: 'USD' },
      phase: 'purchase',
    });
    const secondParsed = JSON.parse(secondResult.content[0].text);
    assert.equal(secondParsed.verdict, 'approved');

    // Verify the stub recorded the governance_context
    assert.ok(stub.hasGovernanceContext(gc), 'stub should have recorded the governance_context');
  });

  it('verifies the issued context at the service before reporting the outcome', async () => {
    stub.clearCallLog();
    const sellerUrl = 'https://seller.example/mcp';
    const buyerUrl = 'https://buyer.example/mcp';
    const payload = {
      idempotency_key: randomUUID(),
      account: { account_id: 'acc-1' },
      total_budget: { amount: 500, currency: 'USD' },
    };
    const intentResult = await callMCPTool(stubUrl, 'check_governance', {
      plan_id: 'plan-service-verification',
      caller: buyerUrl,
      target_agent: sellerUrl,
      tool: 'create_media_buy',
      payload,
    });
    const approved = JSON.parse(intentResult.content[0].text);

    const enforce = createAdcpGovernanceEnforcementMiddleware({
      expectedIssuer: stub.issuerUrl,
      expectedAudience: sellerUrl,
      jwks: new StaticJwksResolver([stub.publicJwk]),
      replayStore: new InMemoryGovernanceReplayStore(),
    });
    let commits = 0;
    const committed = await enforce(
      {
        token: approved.governance_context,
        authenticatedCaller: buyerUrl,
        task: 'create_media_buy',
        payload: { ...payload, governance_context: approved.governance_context },
        actualCommitment: { amount: 500, currency: 'USD' },
      },
      () => {
        commits++;
        return { media_buy_id: 'buy-verified' };
      }
    );
    assert.deepEqual(committed, { media_buy_id: 'buy-verified' });
    assert.equal(commits, 1);

    await callMCPTool(stubUrl, 'report_plan_outcome', {
      idempotency_key: randomUUID(),
      plan_id: 'plan-service-verification',
      check_id: approved.check_id,
      outcome: 'completed',
      governance_context: approved.governance_context,
      seller_response: committed,
    });
    assert.equal(stub.getCallsForTool('report_plan_outcome').length, 1);
  });

  it('records calls to report_plan_outcome', async () => {
    stub.clearCallLog();

    await callMCPTool(stubUrl, 'report_plan_outcome', {
      idempotency_key: randomUUID(),
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
      idempotency_key: randomUUID(),
      plans: [
        {
          plan_id: 'plan-sync-test',
          brand: { domain: 'test.example' },
          objectives: 'Increase brand awareness in US market',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
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
      caller: 'https://buyer.example',
      target_agent: 'https://seller.example/mcp',
      tool: 'create_media_buy',
      payload: { total_budget: 1000, currency: 'USD' },
    });

    await callMCPTool(stubUrl, 'report_plan_outcome', {
      idempotency_key: randomUUID(),
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
  let dispatcher;
  let trustedFetchFn;

  before(async () => {
    stub = new GovernanceAgentStub();
    const info = await stub.startHttps();
    stubUrl = info.url;
    // This fixture intentionally uses a short-lived self-signed certificate.
    // Keep that trust local to the injected test transport rather than
    // disabling TLS verification process-wide for concurrently running tests.
    dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    trustedFetchFn = (input, init) => undiciFetch(input, { ...init, dispatcher });
  });

  after(async () => {
    await closeMCPConnections();
    await dispatcher.close();
    await stub.stop();
  });

  it('starts HTTPS server with self-signed cert', async () => {
    assert.ok(stubUrl);
    assert.match(stubUrl, /^https:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('responds to MCP calls over HTTPS', async () => {
    const result = await callMCPTool(
      stubUrl,
      'check_governance',
      {
        plan_id: 'plan-https-test',
        caller: 'https://buyer.example',
        target_agent: 'https://seller.example/mcp',
        tool: 'create_media_buy',
        payload: { total_budget: 1000, currency: 'USD' },
      },
      undefined,
      [],
      undefined,
      undefined,
      trustedFetchFn,
      { allowPrivateIp: true }
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.verdict, 'approved');
    assert.ok(parsed.governance_context);
  });
});
