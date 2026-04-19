/**
 * E2E governance tests against the local training agent.
 *
 * Tests the full SDK governance stack:
 * - SingleAgentClient with GovernanceConfig
 * - GovernanceMiddleware intercepts tool calls
 * - syncPlans / getPlanAuditLogs client methods
 * - Conditions auto-apply and re-check
 * - Denial flow
 * - Delivery monitoring
 * - Outcome reporting
 *
 * Requires: training agent running at http://localhost:4100/mcp
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const AGENT_URL = process.env.TEST_AGENT_URL || 'http://localhost:4100/mcp';

// Synchronous connectivity check so skipReason is available at describe registration time.
// Uses a child process to make an HTTP request and exit 0 (reachable) or 1 (unreachable).
let agentAvailable = false;
try {
  execFileSync(
    process.execPath,
    [
      '-e',
      `fetch('${AGENT_URL}',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:'{"jsonrpc":"2.0","method":"ping","id":0}',signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok||r.status===400?0:1)).catch(()=>process.exit(1))`,
    ],
    { timeout: 5000, stdio: 'ignore' }
  );
  agentAvailable = true;
} catch {
  agentAvailable = false;
}

// Dynamic import so we use the built output (ESM from CJS)
let SingleAgentClient, GovernanceMiddleware;

before(async () => {
  const lib = await import('../../dist/lib/index.js');
  SingleAgentClient = lib.SingleAgentClient;
  GovernanceMiddleware = lib.GovernanceMiddleware;
});

/** Helper: create agent config for the training agent */
function trainingAgent() {
  return { id: 'training-agent', name: 'Training Agent', agent_uri: AGENT_URL, protocol: 'mcp' };
}

/** Helper: create governance-enabled client */
function createGovernedClient(planId, opts = {}) {
  const governanceAgent = trainingAgent();
  const salesAgent = trainingAgent(); // same agent for testing

  return new SingleAgentClient(salesAgent, {
    governance: {
      campaign: {
        agent: governanceAgent,
        planId,
        buyerCampaignRef: opts.campaignRef || `test-campaign-${Date.now()}`,
        callerUrl: opts.callerUrl || 'https://test-orchestrator.example.com',
        maxConditionsIterations: opts.maxConditionsIterations || 3,
      },
      scope: opts.scope,
    },
  });
}

// Now evaluated synchronously — agentAvailable is set before describes are registered
const skipReason = !agentAvailable && 'Training agent not reachable at ' + AGENT_URL;

describe('Governance E2E: SDK integration with training agent', { skip: skipReason }, () => {
  const planId = `e2e-plan-${Date.now()}`;
  const campaignRef = `e2e-campaign-${Date.now()}`;
  let client;
  let governanceAgent;
  let testProduct; // { product_id, pricing_option_id }

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    // Discover a valid product for create_media_buy tests (using a plain client without governance)
    const plainClient = new SingleAgentClient(governanceAgent, {
      validation: { strictSchemaValidation: false },
    });
    const productsResult = await plainClient.executeTask('get_products', {
      buying_mode: 'brief',
      brief: 'display advertising',
      is_fixed_price: true,
    });
    if (productsResult.success && productsResult.data?.products?.length > 0) {
      // Pick a (product, pricing_option) pair with fixed_price set. Auction options
      // require bid_price on the package and would fail the approve case.
      for (const product of productsResult.data.products) {
        const fixed = product.pricing_options?.find(po => po.fixed_price != null);
        if (fixed) {
          testProduct = { product_id: product.product_id, pricing_option_id: fixed.pricing_option_id };
          break;
        }
      }
      if (!testProduct) {
        const summary = productsResult.data.products.map(p => ({
          product_id: p.product_id,
          pricing_option_ids: p.pricing_options?.map(o => o.pricing_option_id),
        }));
        console.error('No fixed-price option found despite is_fixed_price=true request:', JSON.stringify(summary));
      }
    }

    // Sync a plan first
    const syncResult = await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'E2E SDK governance integration test',
          budget: {
            total: 10000,
            currency: 'USD',
            reallocation_unlimited: true,
            per_seller_max_pct: 60,
          },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: {
            allowed: ['display', 'video'],
          },
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });

    assert.ok(syncResult.success, `syncPlans failed: ${syncResult.error}`);
    const plans = syncResult.data?.plans || [];
    assert.equal(plans[0]?.status, 'active', 'Plan should be active');
  });

  it('should approve a compliant create_media_buy', async () => {
    assert.ok(testProduct, 'Need a valid product from get_products');
    const result = await client.executeTask('create_media_buy', {
      buyer_ref: `e2e-buy-${Date.now()}`,
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      total_budget: { amount: 1000, currency: 'USD' },
      packages: [
        {
          product_id: testProduct.product_id,
          pricing_option_id: testProduct.pricing_option_id,
          budget: 1000,
        },
      ],
      // Governance-relevant fields that the middleware extracts
      channel: 'display',
      countries: ['US'],
    });

    // The tool should execute (governance approved)
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error || result.data?.errors)}`);
    assert.equal(result.status, 'completed');

    // Governance check should be attached
    assert.ok(result.governance, 'Expected governance check result');
    assert.equal(result.governance.status, 'approved');
    assert.equal(result.governance.binding, 'proposed');
    assert.ok(result.governance.checkId, 'Expected check_id');

    // Governance outcome should be reported
    assert.ok(result.governanceOutcome, 'Expected governance outcome');
    assert.equal(result.governanceOutcome.status, 'accepted');
  });

  it('should deny an over-budget create_media_buy', async () => {
    assert.ok(testProduct, 'Need a valid product from get_products');
    const result = await client.executeTask('create_media_buy', {
      buyer_ref: `e2e-overbudget-${Date.now()}`,
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      total_budget: { amount: 50000, currency: 'USD' },
      packages: [
        {
          product_id: testProduct.product_id,
          pricing_option_id: testProduct.pricing_option_id,
          budget: 50000,
        },
      ],
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'governance-denied');
    assert.ok(result.governance, 'Expected governance check result');
    assert.equal(result.governance.status, 'denied');
    assert.ok(result.governance.findings?.length > 0, 'Expected findings');

    const budgetFinding = result.governance.findings.find(f => f.categoryId === 'budget_authority');
    assert.ok(budgetFinding, 'Expected budget_authority finding');
  });

  it('should deny unauthorized market', async () => {
    assert.ok(testProduct, 'Need a valid product from get_products');
    const result = await client.executeTask('create_media_buy', {
      buyer_ref: `e2e-badgeo-${Date.now()}`,
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      total_budget: { amount: 500, currency: 'USD' },
      packages: [
        {
          product_id: testProduct.product_id,
          pricing_option_id: testProduct.pricing_option_id,
          budget: 500,
        },
      ],
      channel: 'display',
      countries: ['CN', 'RU'],
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'governance-denied');

    const geoFinding = result.governance?.findings?.find(f => f.categoryId === 'geo_compliance');
    assert.ok(geoFinding, 'Expected geo_compliance finding');
  });

  it('should auto-apply conditions for seller concentration', async () => {
    // Budget exceeds 60% per_seller_max_pct ($6000 of $10000 plan)
    assert.ok(testProduct, 'Need a valid product from get_products');
    const result = await client.executeTask('create_media_buy', {
      buyer_ref: `e2e-conditions-${Date.now()}`,
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      total_budget: { amount: 8000, currency: 'USD' },
      packages: [
        {
          product_id: testProduct.product_id,
          pricing_option_id: testProduct.pricing_option_id,
          budget: 8000,
        },
      ],
      channel: 'display',
      countries: ['US'],
    });

    // The middleware should have auto-applied conditions and re-checked.
    // The conditions reduce the budget to the per_seller_max_pct limit.
    // The result may succeed (approved at reduced budget) or still fail.
    assert.ok(result.governance, 'Expected governance check result');

    // If conditions were applied, we should see conditionsApplied=true
    if (result.governance.conditionsApplied) {
      // Middleware auto-applied the conditions
      assert.ok(result.governance.modifiedParams, 'Expected modified params');
    }
  });

  it('should get audit logs with budget tracking', async () => {
    const auditResult = await client.getPlanAuditLogs({
      plan_ids: [planId],
      include_entries: true,
    });

    assert.ok(auditResult.success, `getPlanAuditLogs failed: ${auditResult.error}`);

    const plans = auditResult.data?.plans || [];
    assert.equal(plans.length, 1);
    assert.equal(plans[0].plan_id, planId);
    assert.ok(plans[0].budget, 'Expected budget state');
    assert.equal(plans[0].budget.authorized, 10000);
    assert.ok(plans[0].budget.committed >= 0, 'Expected non-negative committed');
    assert.ok(plans[0].summary, 'Expected summary');
    assert.ok(plans[0].summary.checks_performed > 0, 'Expected checks performed');
    assert.ok(plans[0].entries?.length > 0, 'Expected audit entries');
  });

  it('should skip governance for excluded tools', async () => {
    // Governance tools themselves should not go through governance middleware.
    // Use get_plan_audit_logs as an excluded tool that the training agent supports.
    const result = await client.executeTask('get_plan_audit_logs', {
      plan_ids: [planId],
    });

    // Should succeed without governance check
    assert.ok(result.success || result.data, 'Expected tool to execute');
    assert.equal(result.governance, undefined, 'Should not have governance check');
  });
});

describe('Governance E2E: Delivery monitoring', { skip: skipReason }, () => {
  const planId = `e2e-delivery-${Date.now()}`;
  const campaignRef = `e2e-delivery-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    // Sync plan
    const syncResult = await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Delivery monitoring test',
          budget: {
            total: 10000,
            currency: 'USD',
            reallocation_unlimited: true,
          },
          flight: {
            start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            end: new Date(Date.now() + 23 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
        },
      ],
    });

    assert.ok(syncResult.success, `syncPlans failed: ${syncResult.error}`);
  });

  it('should approve normal delivery metrics', async () => {
    // Direct check_governance call for delivery phase
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'committed',
      caller: 'https://test-seller.example.com',
      media_buy_id: `test-mb-${Date.now()}`,
      phase: 'delivery',
      planned_delivery: {
        total_budget: 3000,
        currency: 'USD',
        channels: ['display'],
        geo: { countries: ['US'] },
      },
      delivery_metrics: {
        reporting_period: {
          start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          end: new Date().toISOString(),
        },
        spend: 450,
        cumulative_spend: 2800,
        impressions: 15000,
        cumulative_impressions: 85000,
        pacing: 'on_track',
      },
    });

    // check_governance is excluded from governance middleware,
    // so this executes directly as a tool call
    assert.ok(result.success, `check_governance failed: ${result.error}`);
    const data = result.data;
    assert.ok(data.check_id, 'Expected check_id');
    assert.equal(data.status, 'approved');
  });

  it('should flag overspend drift', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'committed',
      caller: 'https://test-seller.example.com',
      media_buy_id: `test-mb-${Date.now()}`,
      phase: 'delivery',
      planned_delivery: {
        total_budget: 3000,
        currency: 'USD',
        channels: ['display'],
        geo: { countries: ['US'] },
      },
      delivery_metrics: {
        reporting_period: {
          start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          end: new Date().toISOString(),
        },
        spend: 2000,
        cumulative_spend: 9500,
        impressions: 5000,
        cumulative_impressions: 90000,
        pacing: 'ahead',
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    const data = result.data;
    // At 95% of budget, should have findings
    assert.ok(data.findings?.length > 0, 'Expected drift findings');
    const pacingFinding = data.findings.find(f => f.category_id === 'delivery_pacing');
    assert.ok(pacingFinding, 'Expected delivery_pacing finding');
  });
});

describe('Governance E2E: Capabilities discovery', { skip: skipReason }, () => {
  it('should return capabilities via get_adcp_capabilities', async () => {
    const agent = trainingAgent();
    const client = new SingleAgentClient(agent, {
      validation: { strictSchemaValidation: false },
    });
    const result = await client.executeTask('get_adcp_capabilities', {});

    assert.ok(result.success, `get_adcp_capabilities failed: ${result.error}`);
    const data = result.data;
    assert.ok(data.protocol_version, 'Expected protocol_version');
    assert.ok(Array.isArray(data.tasks), 'Expected tasks array');
    assert.ok(data.tasks.includes('get_products'), 'Expected get_products in tasks');
    assert.ok(data.tasks.includes('check_governance'), 'Expected check_governance in tasks');
    assert.ok(data.tasks.includes('sync_plans'), 'Expected sync_plans in tasks');
    assert.ok(data.tasks.includes('create_media_buy'), 'Expected create_media_buy in tasks');
    assert.ok(
      data.supported_protocols?.includes('governance') || data.features?.governance === true,
      'Expected governance support declared'
    );
  });

  it('should not apply governance to get_adcp_capabilities', async () => {
    const planId = `e2e-caps-${Date.now()}`;
    const client = createGovernedClient(planId);
    const agent = trainingAgent();

    // Sync a plan so governance is active
    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Capabilities test',
          budget: { total: 1000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      ],
    });

    const result = await client.executeTask('get_adcp_capabilities', {});
    assert.ok(result.success || result.data, 'Expected tool to execute');
    assert.equal(result.governance, undefined, 'get_adcp_capabilities should be excluded from governance');
  });
});

describe('Governance E2E: reallocation threshold enforcement', { skip: skipReason }, () => {
  const planId = `e2e-reallocation-threshold-${Date.now()}`;
  const campaignRef = `e2e-reallocation-threshold-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    // Sync plan with a 50% reallocation threshold
    const syncResult = await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Reallocation threshold enforcement test',
          budget: {
            total: 10000,
            currency: 'USD',
            reallocation_threshold: 5000,
          },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: { allowed: ['display', 'video'] },
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });
    assert.ok(syncResult.success, `syncPlans failed: ${syncResult.error}`);
  });

  // AdCP v3 has three terminal statuses (approved|denied|conditions). Human review is
  // signalled via a critical-severity finding on a denied decision; the buyer resolves
  // review off-protocol and calls check_governance again with the human's approval.
  it('should deny with critical-severity finding when budget exceeds the reallocation threshold', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 6000, currency: 'USD' },
        channel: 'display',
        countries: ['US'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    const data = result.data;
    assert.equal(data.status, 'denied', 'Expected denied status');
    assert.ok(Array.isArray(data.findings) && data.findings.length > 0, 'Expected findings');
    assert.ok(
      data.findings.some(f => f.severity === 'critical'),
      'Expected at least one critical-severity finding'
    );
  });

  it('should approve a budget under the reallocation threshold', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 2000, currency: 'USD' },
        channel: 'display',
        countries: ['US'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'approved', 'Expected approved for small budget');
  });
});

describe('Governance E2E: Advisory and audit modes', { skip: skipReason }, () => {
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
  });

  it('should approve with findings in advisory mode', async () => {
    const planId = `e2e-advisory-${Date.now()}`;
    const campaignRef = `e2e-advisory-campaign-${Date.now()}`;
    const client = createGovernedClient(planId, { campaignRef });

    // Sync plan in advisory mode with restricted geo
    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Advisory mode test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: { allowed: ['display'] },
          mode: 'advisory',
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });

    // Send a check with unauthorized market — should be approved (advisory) but with findings
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'display',
        countries: ['CN'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    const data = result.data;
    assert.equal(data.status, 'approved', 'Advisory mode should approve even with violations');
    assert.equal(data.mode, 'advisory', 'Expected advisory mode');
    assert.ok(data.findings?.length > 0, 'Expected findings even in advisory mode');
    const geoFinding = data.findings.find(f => f.category_id === 'geo_compliance');
    assert.ok(geoFinding, 'Expected geo_compliance finding in advisory mode');
  });

  it('should approve everything in audit mode', async () => {
    const planId = `e2e-audit-${Date.now()}`;
    const campaignRef = `e2e-audit-campaign-${Date.now()}`;
    const client = createGovernedClient(planId, { campaignRef });

    // Sync plan in audit mode
    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Audit mode test',
          budget: { total: 5000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          mode: 'audit',
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });

    // Send massively over-budget check — should still be approved in audit mode
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 50000, currency: 'USD' },
        channel: 'display',
        countries: ['CN', 'RU'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'approved', 'Audit mode should approve everything');
    assert.equal(result.data.mode, 'audit', 'Expected audit mode');
  });
});

describe('Governance E2E: Channel compliance', { skip: skipReason }, () => {
  const planId = `e2e-channel-${Date.now()}`;
  const campaignRef = `e2e-channel-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Channel compliance test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: {
            allowed: ['display', 'video'],
          },
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });
  });

  it('should deny unauthorized channel', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'audio',
        countries: ['US'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied', 'Expected denied for unauthorized channel');
    const channelFinding = result.data.findings?.find(f => f.category_id === 'channel_compliance');
    assert.ok(channelFinding, 'Expected channel_compliance finding');
    assert.ok(channelFinding.explanation.includes('audio'), 'Expected finding to mention the unauthorized channel');
  });

  it('should approve authorized channel', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'video',
        countries: ['US'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'approved', 'Expected approved for authorized channel');
  });
});

describe('Governance E2E: Flight compliance', { skip: skipReason }, () => {
  const planId = `e2e-flight-${Date.now()}`;
  const campaignRef = `e2e-flight-campaign-${Date.now()}`;
  let client;
  let governanceAgent;
  const planStart = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000); // tomorrow
  const planEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Flight compliance test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: planStart.toISOString(),
            end: planEnd.toISOString(),
          },
          countries: ['US'],
          channels: { allowed: ['display'] },
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });
  });

  it('should deny start date before plan flight', async () => {
    const earlyStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'display',
        countries: ['US'],
        start_time: earlyStart.toISOString(),
        end_time: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied', 'Expected denied for early start date');
    const flightFinding = result.data.findings?.find(f => f.category_id === 'flight_compliance');
    assert.ok(flightFinding, 'Expected flight_compliance finding');
  });

  it('should deny end date after plan flight', async () => {
    const lateEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days from now
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'display',
        countries: ['US'],
        start_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: lateEnd.toISOString(),
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied', 'Expected denied for late end date');
    const flightFinding = result.data.findings?.find(f => f.category_id === 'flight_compliance');
    assert.ok(flightFinding, 'Expected flight_compliance finding');
  });
});

describe('Governance E2E: Delegation authority', { skip: skipReason }, () => {
  const planId = `e2e-delegation-${Date.now()}`;
  const campaignRef = `e2e-delegation-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    // Use a caller URL that is NOT in the delegations list
    client = createGovernedClient(planId, {
      campaignRef,
      callerUrl: 'https://unauthorized-orchestrator.example.com',
    });

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Delegation authority test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: { allowed: ['display'] },
          delegations: [
            {
              agent_url: 'https://authorized-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });
  });

  it('should deny caller not in delegations list', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://unauthorized-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'display',
        countries: ['US'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied', 'Expected denied for unauthorized caller');
    const delegationFinding = result.data.findings?.find(f => f.category_id === 'delegation_authority');
    assert.ok(delegationFinding, 'Expected delegation_authority finding');
    assert.ok(
      delegationFinding.explanation.includes('unauthorized-orchestrator'),
      'Expected finding to reference the caller'
    );
  });

  it('should deny expired delegation', async () => {
    const expiredPlanId = `e2e-expired-deleg-${Date.now()}`;
    const expiredClient = createGovernedClient(expiredPlanId, { campaignRef });

    await expiredClient.syncPlans({
      plans: [
        {
          plan_id: expiredPlanId,
          brand: { domain: 'test.example' },
          objectives: 'Expired delegation test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: { allowed: ['display'] },
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
              expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // expired yesterday
            },
          ],
        },
      ],
    });

    const result = await expiredClient.executeTask('check_governance', {
      plan_id: expiredPlanId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 1000, currency: 'USD' },
        channel: 'display',
        countries: ['US'],
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied', 'Expected denied for expired delegation');
    const delegationFinding = result.data.findings?.find(f => f.category_id === 'delegation_authority');
    assert.ok(delegationFinding, 'Expected delegation_authority finding for expired delegation');
    assert.ok(delegationFinding.explanation.includes('expired'), 'Expected finding to mention expiration');
  });
});

describe('Governance E2E: Plan not found', { skip: skipReason }, () => {
  it('should deny check against non-existent plan', async () => {
    const agent = trainingAgent();
    const client = new SingleAgentClient(agent, {
      validation: { strictSchemaValidation: false },
    });

    const result = await client.executeTask('check_governance', {
      plan_id: `non-existent-plan-${Date.now()}`,
      buyer_campaign_ref: 'test',
      binding: 'proposed',
      caller: 'https://test.example',
      tool: 'create_media_buy',
      payload: { budget: { total: 100 } },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied', 'Expected denied for non-existent plan');
    assert.ok(result.data.explanation?.includes('not found'), 'Expected explanation to mention plan not found');
  });
});

describe('Governance E2E: Plan sync and update', { skip: skipReason }, () => {
  it('should increment version on plan re-sync', async () => {
    const planId = `e2e-resync-${Date.now()}`;
    const agent = trainingAgent();
    const client = createGovernedClient(planId);

    // First sync
    const sync1 = await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Version test',
          budget: { total: 5000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      ],
    });
    assert.ok(sync1.success);
    assert.equal(sync1.data.plans[0].version, 1);

    // Second sync
    const sync2 = await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Updated version test',
          budget: { total: 8000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      ],
    });
    assert.ok(sync2.success);
    assert.equal(sync2.data.plans[0].version, 2, 'Expected version 2 on re-sync');
  });

  it('should return governance categories on sync', async () => {
    const planId = `e2e-categories-${Date.now()}`;
    const agent = trainingAgent();
    const client = createGovernedClient(planId);

    const syncResult = await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Categories test',
          budget: { total: 5000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      ],
    });

    assert.ok(syncResult.success);
    const categories = syncResult.data.plans[0].categories;
    assert.ok(Array.isArray(categories), 'Expected categories array');
    assert.ok(categories.length > 0, 'Expected at least one category');
    const categoryIds = categories.map(c => c.category_id);
    assert.ok(categoryIds.includes('budget_authority'), 'Expected budget_authority category');
    assert.ok(categoryIds.includes('geo_compliance'), 'Expected geo_compliance category');
    assert.ok(categoryIds.includes('delivery_pacing'), 'Expected delivery_pacing category');
  });
});

describe('Governance E2E: Outcome reporting', { skip: skipReason }, () => {
  const planId = `e2e-outcome-${Date.now()}`;
  const campaignRef = `e2e-outcome-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Outcome reporting test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });
  });

  it('should track committed budget from completed outcome', async () => {
    // First, get a check_id by doing a governance check
    const checkResult = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: { budget: { total: 3000, currency: 'USD' }, channel: 'display', countries: ['US'] },
    });
    assert.ok(checkResult.success);
    const checkId = checkResult.data.check_id;

    // Report completed outcome
    const outcomeResult = await client.executeTask('report_plan_outcome', {
      plan_id: planId,
      check_id: checkId,
      buyer_campaign_ref: campaignRef,
      outcome: 'completed',
      seller_response: {
        committed_budget: 3000,
        media_buy_id: `mb-${Date.now()}`,
      },
    });

    assert.ok(outcomeResult.success, `report_plan_outcome failed: ${outcomeResult.error}`);
    const data = outcomeResult.data;
    assert.ok(data.outcome_id, 'Expected outcome_id');
    assert.equal(data.status, 'accepted');
    assert.equal(data.committed_budget, 3000);
    assert.ok(data.plan_summary, 'Expected plan_summary');
    assert.equal(data.plan_summary.total_committed, 3000);
    assert.equal(data.plan_summary.budget_remaining, 7000);
  });

  it('should not commit budget for failed outcome', async () => {
    // Get a fresh check_id for this test
    const failCheckResult = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: { budget: { total: 2000, currency: 'USD' }, channel: 'display', countries: ['US'] },
    });
    assert.ok(failCheckResult.success);
    const failCheckId = failCheckResult.data.check_id;

    const outcomeResult = await client.executeTask('report_plan_outcome', {
      plan_id: planId,
      check_id: failCheckId,
      buyer_campaign_ref: campaignRef,
      outcome: 'failed',
      error: { code: 'seller_error', message: 'Seller rejected the buy' },
    });

    assert.ok(outcomeResult.success, `report_plan_outcome failed: ${outcomeResult.error}`);
    assert.equal(outcomeResult.data.status, 'accepted');
    // Budget should remain at 3000 from previous test
    assert.equal(outcomeResult.data.plan_summary.total_committed, 3000);
  });

  it('should flag when committed exceeds authorized', async () => {
    // Get a fresh check_id for the over-commit test
    const overCommitCheck = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: { budget: { total: 9000, currency: 'USD' }, channel: 'display', countries: ['US'] },
    });
    assert.ok(overCommitCheck.success);

    // Report a massive completed outcome that pushes past budget
    const outcomeResult = await client.executeTask('report_plan_outcome', {
      plan_id: planId,
      check_id: overCommitCheck.data.check_id,
      buyer_campaign_ref: campaignRef,
      outcome: 'completed',
      seller_response: { committed_budget: 9000 },
    });

    assert.ok(outcomeResult.success);
    // Prior committed + 9000 should exceed 10000 authorized
    assert.equal(outcomeResult.data.status, 'findings', 'Expected findings status for over-commit');
    assert.ok(outcomeResult.data.findings?.length > 0, 'Expected budget findings');
  });
});

describe('Governance E2E: Audit log detail', { skip: skipReason }, () => {
  const planId = `e2e-audit-detail-${Date.now()}`;
  const campaignRef = `e2e-audit-detail-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Audit detail test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });

    // Perform a check and report an outcome to populate audit logs
    const checkResult = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: { budget: { total: 2000, currency: 'USD' }, channel: 'display', countries: ['US'] },
    });

    if (checkResult.data?.check_id) {
      await client.executeTask('report_plan_outcome', {
        plan_id: planId,
        check_id: checkResult.data.check_id,
        buyer_campaign_ref: campaignRef,
        outcome: 'completed',
        seller_response: { committed_budget: 2000 },
      });
    }
  });

  it('should return drift metrics in audit logs', async () => {
    const auditResult = await client.getPlanAuditLogs({
      plan_ids: [planId],
      include_entries: true,
    });

    assert.ok(auditResult.success);
    const plan = auditResult.data.plans[0];
    assert.ok(plan.summary.drift_metrics, 'Expected drift_metrics');
    assert.ok(typeof plan.summary.drift_metrics.auto_approval_rate === 'number', 'Expected auto_approval_rate');
    assert.ok(typeof plan.summary.drift_metrics.escalation_rate === 'number', 'Expected escalation_rate');
  });

  it('should include both check and outcome entries', async () => {
    const auditResult = await client.getPlanAuditLogs({
      plan_ids: [planId],
      include_entries: true,
    });

    assert.ok(auditResult.success);
    const entries = auditResult.data.plans[0].entries;
    assert.ok(entries?.length >= 2, 'Expected at least 2 entries (check + outcome)');

    const checkEntries = entries.filter(e => e.type === 'check');
    const outcomeEntries = entries.filter(e => e.type === 'outcome');
    assert.ok(checkEntries.length > 0, 'Expected check entries');
    assert.ok(outcomeEntries.length > 0, 'Expected outcome entries');

    // Entries should be sorted by timestamp
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i].timestamp >= entries[i - 1].timestamp, 'Expected entries sorted by timestamp');
    }
  });

});

describe('Governance E2E: Multiple findings in single check', { skip: skipReason }, () => {
  const planId = `e2e-multi-findings-${Date.now()}`;
  const campaignRef = `e2e-multi-findings-campaign-${Date.now()}`;
  let client;
  let governanceAgent;

  before(async () => {
    governanceAgent = trainingAgent();
    client = createGovernedClient(planId, { campaignRef });

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Multiple findings test',
          budget: { total: 5000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          channels: { allowed: ['display'] },
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });
  });

  it('should return multiple findings for multiple violations', async () => {
    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: campaignRef,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: {
        budget: { total: 50000, currency: 'USD' },
        channel: 'audio', // unauthorized channel
        countries: ['CN', 'RU'], // unauthorized markets
        start_time: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // before plan start
        end_time: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // after plan end
      },
    });

    assert.ok(result.success, `check_governance failed: ${result.error}`);
    assert.equal(result.data.status, 'denied');
    assert.ok(result.data.findings?.length >= 3, `Expected at least 3 findings, got ${result.data.findings?.length}`);

    const categoryIds = result.data.findings.map(f => f.category_id);
    assert.ok(categoryIds.includes('budget_authority'), 'Expected budget_authority finding');
    assert.ok(categoryIds.includes('geo_compliance'), 'Expected geo_compliance finding');
    assert.ok(categoryIds.includes('channel_compliance'), 'Expected channel_compliance finding');
  });
});

describe('Governance E2E: Approval expiration', { skip: skipReason }, () => {
  it('should include expires_at on approved checks', async () => {
    const planId = `e2e-expiry-${Date.now()}`;
    const agent = trainingAgent();
    const client = createGovernedClient(planId);

    await client.syncPlans({
      plans: [
        {
          plan_id: planId,
          brand: { domain: 'test.example' },
          objectives: 'Expiry test',
          budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
          flight: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          countries: ['US'],
          delegations: [
            {
              agent_url: 'https://test-orchestrator.example.com',
              authority: 'full',
            },
          ],
        },
      ],
    });

    const result = await client.executeTask('check_governance', {
      plan_id: planId,
      buyer_campaign_ref: `exp-campaign-${Date.now()}`,
      binding: 'proposed',
      caller: 'https://test-orchestrator.example.com',
      tool: 'create_media_buy',
      payload: { budget: { total: 1000, currency: 'USD' }, countries: ['US'] },
    });

    assert.ok(result.success);
    assert.equal(result.data.status, 'approved');
    assert.ok(result.data.expires_at, 'Expected expires_at on approved check');
    // Verify it's in the future
    assert.ok(new Date(result.data.expires_at) > new Date(), 'Expected expires_at to be in the future');
  });
});

describe('Governance E2E: CLI test scenarios', { skip: skipReason }, () => {
  it('campaign_governance scenario passes', async () => {
    const { testCampaignGovernance } = await import('../../dist/lib/testing/scenarios/governance.js');
    const result = await testCampaignGovernance(AGENT_URL, { protocol: 'mcp' });
    const failed = result.steps.filter(s => !s.passed);
    assert.equal(failed.length, 0, `Failed steps: ${failed.map(s => `${s.step}: ${s.error}`).join(', ')}`);
  });

  it('campaign_governance_denied scenario passes', async () => {
    const { testCampaignGovernanceDenied } = await import('../../dist/lib/testing/scenarios/governance.js');
    const result = await testCampaignGovernanceDenied(AGENT_URL, { protocol: 'mcp' });
    const failed = result.steps.filter(s => !s.passed);
    assert.equal(failed.length, 0, `Failed steps: ${failed.map(s => `${s.step}: ${s.error}`).join(', ')}`);
  });

  it('campaign_governance_conditions scenario passes', async () => {
    const { testCampaignGovernanceConditions } = await import('../../dist/lib/testing/scenarios/governance.js');
    const result = await testCampaignGovernanceConditions(AGENT_URL, { protocol: 'mcp' });
    const failed = result.steps.filter(s => !s.passed);
    assert.equal(failed.length, 0, `Failed steps: ${failed.map(s => `${s.step}: ${s.error}`).join(', ')}`);
  });

  it('campaign_governance_delivery scenario passes', async () => {
    const { testCampaignGovernanceDelivery } = await import('../../dist/lib/testing/scenarios/governance.js');
    const result = await testCampaignGovernanceDelivery(AGENT_URL, { protocol: 'mcp' });
    const failed = result.steps.filter(s => !s.passed);
    assert.equal(failed.length, 0, `Failed steps: ${failed.map(s => `${s.step}: ${s.error}`).join(', ')}`);
  });
});
