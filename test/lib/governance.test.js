/**
 * Unit tests for governance pure functions and types.
 *
 * Tests toolRequiresGovernance, parseCheckResponse, and isGovernanceAdapterError
 * without requiring a running governance agent.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toolRequiresGovernance, parseCheckResponse } = require('../../dist/lib/core/GovernanceTypes.js');

const { isGovernanceAdapterError } = require('../../dist/lib/adapters/governance-adapter.js');

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

  it('respects scope: "all" (still excludes governance tools)', () => {
    const config = { ...baseConfig, scope: 'all' };
    assert.equal(toolRequiresGovernance('create_media_buy', config), true);
    assert.equal(toolRequiresGovernance('check_governance', config), false);
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
});
