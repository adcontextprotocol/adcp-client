/**
 * Unit tests for governance pure functions and types.
 *
 * Tests toolRequiresGovernance, parseCheckResponse, and isGovernanceAdapterError
 * without requiring a running governance agent.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toolRequiresGovernance, parseCheckResponse } = require('../../dist/lib/core/GovernanceTypes.js');

const { isGovernanceAdapterError, GovernanceAdapter } = require('../../dist/lib/adapters/governance-adapter.js');
const {
  setAtPath,
  GovernanceMiddleware,
  extractGovernanceContext,
} = require('../../dist/lib/core/GovernanceMiddleware.js');

describe('toolRequiresGovernance', () => {
  const baseConfig = {
    campaign: {
      agent: { id: 'gov', name: 'Gov', agent_uri: 'http://localhost', protocol: 'mcp' },
      planId: 'plan-1',
    },
  };

  it('returns false when campaign is not configured', () => {
    assert.equal(toolRequiresGovernance('create_media_buy', {}), false);
  });

  it('excludes governance tools by default', () => {
    assert.equal(toolRequiresGovernance('check_governance', baseConfig), false);
    assert.equal(toolRequiresGovernance('sync_plans', baseConfig), false);
    assert.equal(toolRequiresGovernance('report_plan_outcome', baseConfig), false);
    assert.equal(toolRequiresGovernance('get_plan_audit_logs', baseConfig), false);
  });

  it('excludes get_adcp_capabilities by default', () => {
    assert.equal(toolRequiresGovernance('get_adcp_capabilities', baseConfig), false);
  });

  it('includes other tools by default', () => {
    assert.equal(toolRequiresGovernance('create_media_buy', baseConfig), true);
    assert.equal(toolRequiresGovernance('get_products', baseConfig), true);
  });

  it('respects scope: "all" (includes all tools except governance self-tools)', () => {
    const config = { ...baseConfig, scope: 'all' };
    assert.equal(toolRequiresGovernance('create_media_buy', config), true);
    assert.equal(toolRequiresGovernance('get_adcp_capabilities', config), true);
    // Governance tools themselves are always excluded
    assert.equal(toolRequiresGovernance('check_governance', config), false);
    assert.equal(toolRequiresGovernance('sync_plans', config), false);
  });

  it('returns false for empty scope array', () => {
    const config = { ...baseConfig, scope: [] };
    assert.equal(toolRequiresGovernance('create_media_buy', config), false);
  });

  it('respects scope: string[]', () => {
    const config = { ...baseConfig, scope: ['create_media_buy'] };
    assert.equal(toolRequiresGovernance('create_media_buy', config), true);
    assert.equal(toolRequiresGovernance('get_products', config), false);
  });

  it('respects scope: function', () => {
    const config = { ...baseConfig, scope: tool => tool.startsWith('create_') };
    assert.equal(toolRequiresGovernance('create_media_buy', config), true);
    assert.equal(toolRequiresGovernance('get_products', config), false);
  });
});

describe('parseCheckResponse', () => {
  it('parses an approved response', () => {
    const response = {
      check_id: 'chk-1',
      status: 'approved',
      binding: 'proposed',
      explanation: 'All checks passed',
      expires_at: '2026-04-01T00:00:00Z',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.checkId, 'chk-1');
    assert.equal(result.status, 'approved');
    assert.equal(result.binding, 'proposed');
    assert.equal(result.explanation, 'All checks passed');
    assert.equal(result.expiresAt, '2026-04-01T00:00:00Z');
  });

  it('parses findings with snake_case to camelCase conversion', () => {
    const response = {
      check_id: 'chk-2',
      status: 'denied',
      binding: 'proposed',
      explanation: 'Budget exceeded',
      findings: [
        {
          category_id: 'budget_authority',
          policy_id: 'pol-1',
          severity: 'high',
          explanation: 'Over budget',
          confidence: 0.95,
          uncertainty_reason: 'estimated',
          details: { requested: 50000 },
        },
      ],
    };

    const result = parseCheckResponse(response);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].categoryId, 'budget_authority');
    assert.equal(result.findings[0].policyId, 'pol-1');
    assert.equal(result.findings[0].severity, 'high');
    assert.equal(result.findings[0].confidence, 0.95);
    assert.equal(result.findings[0].uncertaintyReason, 'estimated');
    assert.deepEqual(result.findings[0].details, { requested: 50000 });
  });

  it('parses conditions with required_value', () => {
    const response = {
      check_id: 'chk-3',
      status: 'conditions',
      binding: 'proposed',
      explanation: 'Budget adjustment required',
      conditions: [{ field: 'budget.total', required_value: 6000, reason: 'Per-seller max exceeded' }],
    };

    const result = parseCheckResponse(response);
    assert.equal(result.conditions.length, 1);
    assert.equal(result.conditions[0].field, 'budget.total');
    assert.equal(result.conditions[0].requiredValue, 6000);
    assert.equal(result.conditions[0].reason, 'Per-seller max exceeded');
  });

  it('parses escalation details', () => {
    const response = {
      check_id: 'chk-4',
      status: 'escalated',
      binding: 'proposed',
      explanation: 'Human approval required',
      escalation: {
        reason: 'Budget exceeds 50%',
        severity: 'high',
        requires_human: true,
        approval_tier: 'manager',
      },
    };

    const result = parseCheckResponse(response);
    assert.ok(result.escalation);
    assert.equal(result.escalation.reason, 'Budget exceeds 50%');
    assert.equal(result.escalation.severity, 'high');
    assert.equal(result.escalation.requiresHuman, true);
    assert.equal(result.escalation.approvalTier, 'manager');
  });

  it('parses mode field', () => {
    const response = {
      check_id: 'chk-5',
      status: 'approved',
      binding: 'proposed',
      explanation: 'Advisory mode',
      mode: 'advisory',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.mode, 'advisory');
  });

  it('handles missing optional fields', () => {
    const response = {
      check_id: 'chk-6',
      status: 'approved',
      binding: 'committed',
      explanation: 'OK',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.findings, undefined);
    assert.equal(result.conditions, undefined);
    assert.equal(result.escalation, undefined);
    assert.equal(result.expiresAt, undefined);
    assert.equal(result.mode, undefined);
    assert.equal(result.governanceContext, undefined);
  });

  it('captures governance_context from response', () => {
    const response = {
      check_id: 'chk-7',
      status: 'approved',
      binding: 'committed',
      explanation: 'All checks passed',
      governance_context: 'opaque-token-abc123',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.governanceContext, 'opaque-token-abc123');
  });
});

describe('isGovernanceAdapterError', () => {
  it('returns true for governance_not_supported', () => {
    assert.equal(isGovernanceAdapterError({ error: { code: 'governance_not_supported' } }), true);
  });

  it('returns true for governance_check_failed', () => {
    assert.equal(isGovernanceAdapterError({ error: { code: 'governance_check_failed' } }), true);
  });

  it('returns true for governance_agent_unreachable', () => {
    assert.equal(isGovernanceAdapterError({ error: { code: 'governance_agent_unreachable' } }), true);
  });

  it('returns false for non-governance errors', () => {
    assert.equal(isGovernanceAdapterError({ error: { code: 'invalid_request' } }), false);
  });

  it('returns falsy for null/undefined/empty', () => {
    assert.ok(!isGovernanceAdapterError(null));
    assert.ok(!isGovernanceAdapterError(undefined));
    assert.ok(!isGovernanceAdapterError({}));
  });

  it('returns falsy for non-object values', () => {
    assert.ok(!isGovernanceAdapterError('string'));
    assert.ok(!isGovernanceAdapterError(42));
    assert.ok(!isGovernanceAdapterError(true));
  });
});

describe('setAtPath', () => {
  it('sets a simple key', () => {
    const obj = {};
    setAtPath(obj, 'name', 'test');
    assert.equal(obj.name, 'test');
  });

  it('sets a nested key', () => {
    const obj = {};
    setAtPath(obj, 'budget.total', 5000);
    assert.deepEqual(obj, { budget: { total: 5000 } });
  });

  it('sets deeply nested keys', () => {
    const obj = {};
    setAtPath(obj, 'a.b.c.d', 'deep');
    assert.equal(obj.a.b.c.d, 'deep');
  });

  it('preserves existing properties', () => {
    const obj = { budget: { currency: 'USD' } };
    setAtPath(obj, 'budget.total', 5000);
    assert.deepEqual(obj, { budget: { currency: 'USD', total: 5000 } });
  });

  it('creates arrays when next key is numeric', () => {
    const obj = {};
    setAtPath(obj, 'packages.0.budget', 1000);
    assert.ok(Array.isArray(obj.packages));
    assert.equal(obj.packages[0].budget, 1000);
  });

  it('throws on __proto__ as first segment and does not pollute Object.prototype', () => {
    assert.throws(() => setAtPath({}, '__proto__.polluted', true), /Invalid path segment/);
    assert.equal({}.polluted, undefined, 'Object.prototype should not be polluted');
  });

  it('throws on __proto__ as non-first segment', () => {
    const obj = { a: {} };
    assert.throws(() => setAtPath(obj, 'a.__proto__.polluted', true), /Invalid path segment/);
    assert.equal({}.polluted, undefined, 'Object.prototype should not be polluted');
  });

  it('throws on constructor', () => {
    assert.throws(() => setAtPath({}, 'constructor.prototype.x', true), /Invalid path segment/);
  });

  it('throws on prototype', () => {
    assert.throws(() => setAtPath({}, 'a.prototype.b', true), /Invalid path segment/);
  });

  it('rejects paths with special characters', () => {
    assert.throws(() => setAtPath({}, 'a[0].b', true), /Invalid path segment/);
    assert.throws(() => setAtPath({}, 'a..b', true), /Invalid path segment/);
    assert.throws(() => setAtPath({}, '.a', true), /Invalid path segment/);
    assert.throws(() => setAtPath({}, 'a.', true), /Invalid path segment/);
  });

  it('accepts valid identifier segments', () => {
    const obj = {};
    setAtPath(obj, '_private.$field', 'ok');
    assert.equal(obj._private.$field, 'ok');
  });

  it('overwrites scalar intermediate with object', () => {
    const obj = { budget: 5000 };
    setAtPath(obj, 'budget.total', 3000);
    assert.deepEqual(obj.budget, { total: 3000 });
  });

  it('throws on empty path', () => {
    assert.throws(() => setAtPath({}, '', true), /Empty path/);
  });

  it('throws on whitespace-only path', () => {
    assert.throws(() => setAtPath({}, '   ', true), /Empty path/);
  });
});

describe('GovernanceMiddleware', () => {
  const baseGovernanceConfig = {
    campaign: {
      agent: { id: 'gov', name: 'Gov Agent', agent_uri: 'http://127.0.0.1:1', protocol: 'mcp' },
      planId: 'plan-1',
    },
  };

  describe('requiresCheck', () => {
    it('returns true for governed tools', () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(mw.requiresCheck('create_media_buy'), true);
    });

    it('returns false for excluded tools', () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(mw.requiresCheck('check_governance'), false);
      assert.equal(mw.requiresCheck('get_adcp_capabilities'), false);
    });

    it('respects custom scope', () => {
      const config = { ...baseGovernanceConfig, scope: ['create_media_buy'] };
      const mw = new GovernanceMiddleware(config);
      assert.equal(mw.requiresCheck('create_media_buy'), true);
      assert.equal(mw.requiresCheck('get_products'), false);
    });
  });

  describe('campaign getter', () => {
    it('returns campaign config when present', () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(mw.campaign.planId, 'plan-1');
    });

    it('returns undefined when not configured', () => {
      const mw = new GovernanceMiddleware({});
      assert.equal(mw.campaign, undefined);
    });
  });

  describe('checkProposed', () => {
    it('throws when campaign is not configured', async () => {
      const mw = new GovernanceMiddleware({});
      await assert.rejects(() => mw.checkProposed('create_media_buy', {}), /Campaign governance not configured/);
    });

    // Note: checkProposed with a real governance agent is tested in governance-e2e.test.js.
    // The do...while loop guarantees the initial check always fires regardless of
    // maxConditionsIterations. Unit testing that path requires a running agent.
  });
});

describe('extractGovernanceContext', () => {
  const config = {
    agent: { id: 'gov', name: 'Gov', agent_uri: 'http://localhost', protocol: 'mcp' },
    planId: 'plan-1',
    callerUrl: 'https://buyer.example.com',
  };

  it('extracts budget when total and currency are present', () => {
    const params = { budget: { total: 5000, currency: 'USD' } };
    const ctx = extractGovernanceContext(params, config);
    assert.deepEqual(ctx.total_budget, { amount: 5000, currency: 'USD' });
  });

  it('returns undefined when params have no recognizable fields', () => {
    const ctx = extractGovernanceContext({ foo: 'bar' }, { ...config, callerUrl: undefined });
    assert.equal(ctx, undefined);
  });

  it('skips budget when total is missing', () => {
    const params = { budget: { currency: 'USD' } };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.equal(ctx, undefined);
  });

  it('skips budget when currency is missing', () => {
    const params = { budget: { total: 5000 } };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.equal(ctx, undefined);
  });

  it('extracts countries array', () => {
    const params = { countries: ['US', 'CA'] };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.deepEqual(ctx.countries, ['US', 'CA']);
  });

  it('skips empty countries array', () => {
    const params = { countries: [] };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.equal(ctx, undefined);
  });

  it('extracts single channel as array', () => {
    const params = { channel: 'display' };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.deepEqual(ctx.channels, ['display']);
  });

  it('extracts channels array', () => {
    const params = { channels: ['display', 'video'] };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.deepEqual(ctx.channels, ['display', 'video']);
  });

  it('prefers channel over channels', () => {
    const params = { channel: 'social', channels: ['display'] };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.deepEqual(ctx.channels, ['social']);
  });

  it('extracts flight dates', () => {
    const params = { flight: { start: '2026-01-01', end: '2026-02-01' } };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.deepEqual(ctx.flight, { start: '2026-01-01', end: '2026-02-01' });
  });

  it('skips flight when start or end is missing', () => {
    const params = { flight: { start: '2026-01-01' } };
    const ctx = extractGovernanceContext(params, { ...config, callerUrl: undefined });
    assert.equal(ctx, undefined);
  });

  it('includes seller_url from config', () => {
    const ctx = extractGovernanceContext({}, config);
    assert.equal(ctx.seller_url, 'https://buyer.example.com');
  });

  it('extracts all fields together', () => {
    const params = {
      budget: { total: 10000, currency: 'EUR' },
      countries: ['DE', 'FR'],
      channel: 'display',
      flight: { start: '2026-03-01', end: '2026-04-01' },
    };
    const ctx = extractGovernanceContext(params, config);
    assert.deepEqual(ctx.total_budget, { amount: 10000, currency: 'EUR' });
    assert.deepEqual(ctx.countries, ['DE', 'FR']);
    assert.deepEqual(ctx.channels, ['display']);
    assert.deepEqual(ctx.flight, { start: '2026-03-01', end: '2026-04-01' });
    assert.equal(ctx.seller_url, 'https://buyer.example.com');
  });
});

describe('GovernanceAdapter', () => {
  it('isSupported returns false when not configured', () => {
    const adapter = new GovernanceAdapter();
    assert.equal(adapter.isSupported(), false);
  });

  it('isSupported returns true when configured', () => {
    const adapter = new GovernanceAdapter({
      agent: { id: 'gov', name: 'Gov', agent_uri: 'http://localhost', protocol: 'mcp' },
      callerUrl: 'https://seller.example.com',
    });
    assert.equal(adapter.isSupported(), true);
  });

  it('checkCommitted returns denial when not configured', async () => {
    const adapter = new GovernanceAdapter();
    const result = await adapter.checkCommitted({
      planId: 'plan-1',
      buyerCampaignRef: 'campaign-1',
      mediaBuyId: 'buy-1',
      plannedDelivery: { impressions: 1000, budget: 500 },
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.binding, 'committed');
    assert.match(result.explanation, /not configured/i);
    assert.equal(result.error_code, 'governance_not_supported');
  });
});
