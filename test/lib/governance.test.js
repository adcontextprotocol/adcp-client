/**
 * Unit tests for governance pure functions and types.
 *
 * Tests toolRequiresGovernance, parseCheckResponse, and isGovernanceAdapterError
 * without requiring a running governance agent.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeGovernanceVerdict,
  toolRequiresGovernance,
  parseCheckResponse,
} = require('../../dist/lib/core/GovernanceTypes.js');

const {
  isGovernanceAdapterError,
  GovernanceAdapter,
  GovernanceAdapterError,
} = require('../../dist/lib/adapters/governance-adapter.js');
const { setAtPath, GovernanceMiddleware } = require('../../dist/lib/core/GovernanceMiddleware.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');
const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const { computeGovernedPayloadHash } = require('../../dist/lib/governance/index.js');

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
      verdict: 'approved',
      explanation: 'All checks passed',
      expires_at: '2026-04-01T00:00:00Z',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.checkId, 'chk-1');
    assert.equal(result.status, 'approved');
    assert.equal(result.explanation, 'All checks passed');
    assert.equal(result.expiresAt, '2026-04-01T00:00:00Z');
  });

  it('parses findings with snake_case to camelCase conversion', () => {
    const response = {
      check_id: 'chk-2',
      verdict: 'denied',
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
      verdict: 'conditions',
      explanation: 'Budget adjustment required',
      conditions: [{ field: 'budget.total', required_value: 6000, reason: 'Per-seller max exceeded' }],
    };

    const result = parseCheckResponse(response);
    assert.equal(result.conditions.length, 1);
    assert.equal(result.conditions[0].field, 'budget.total');
    assert.equal(result.conditions[0].requiredValue, 6000);
    assert.equal(result.conditions[0].reason, 'Per-seller max exceeded');
  });

  it('preserves legacy governance_context on conditions responses', () => {
    const result = parseCheckResponse({
      check_id: 'chk-legacy-conditions',
      status: 'conditions',
      explanation: 'Budget adjustment required',
      governance_context: 'legacy-continuation-context',
      conditions: [{ field: 'budget.total', required_value: 6000, reason: 'Per-seller max exceeded' }],
    });

    assert.equal(result.checkType, 'legacy');
    assert.equal(result.governanceContext, 'legacy-continuation-context');
    assert.equal(result.consultationContext, undefined);
  });

  it('handles missing optional fields', () => {
    const response = {
      check_id: 'chk-6',
      verdict: 'approved',
      explanation: 'OK',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.findings, undefined);
    assert.equal(result.conditions, undefined);
    assert.equal(result.expiresAt, undefined);
    assert.equal(result.governanceContext, undefined);
  });

  it('captures governance_context from response', () => {
    const response = {
      check_id: 'chk-7',
      verdict: 'approved',
      explanation: 'OK',
      governance_context: 'opaque-gc-token-abc123',
    };

    const result = parseCheckResponse(response);
    assert.equal(result.governanceContext, 'opaque-gc-token-abc123');
  });
});

describe('normalizeGovernanceVerdict', () => {
  it('accepts a complete modern intent approval', () => {
    const result = normalizeGovernanceVerdict({
      check_id: 'chk-modern',
      check_type: 'intent',
      verdict: 'approved',
      explanation: 'Approved',
      governance_context: 'signed-context',
      expires_at: '2026-08-18T12:00:00Z',
    });
    assert.equal(result.verdict, 'approved');
    assert.equal(result.checkType, 'intent');
  });

  it('fails closed on malformed modern verdict combinations', () => {
    assert.equal(
      normalizeGovernanceVerdict({
        check_id: 'chk-1',
        check_type: 'unknown',
        verdict: 'approved',
        explanation: 'No',
        governance_context: 'token',
        expires_at: '2026-08-18T12:00:00Z',
      }),
      null
    );
    assert.equal(
      normalizeGovernanceVerdict({
        check_id: 'chk-2',
        check_type: 'intent',
        verdict: 'approved',
        explanation: 'No expiry',
        governance_context: 'token',
      }),
      null
    );
    assert.equal(
      normalizeGovernanceVerdict({
        check_id: 'chk-3',
        check_type: 'execution',
        verdict: 'conditions',
        explanation: 'Invalid execution counterproposal',
        conditions: [{ field: 'payload.total_budget', reason: 'lower' }],
        consultation_context: 'consult-1',
      }),
      null
    );
    assert.equal(
      normalizeGovernanceVerdict({
        check_id: 'chk-4',
        check_type: 'intent',
        verdict: 'denied',
        explanation: 'Invalid conditions leak',
        findings: [{ category_id: 'policy', severity: 'high', explanation: 'denied' }],
        conditions: [],
      }),
      null
    );
    assert.equal(
      normalizeGovernanceVerdict({
        check_id: 'chk-5',
        check_type: 'intent',
        verdict: 'conditions',
        explanation: 'Invalid authorizing context on a counterproposal',
        conditions: [{ field: 'payload.total_budget.amount', required_value: 5, reason: 'lower' }],
        consultation_context: 'consult-2',
        governance_context: 'must-not-authorize',
      }),
      null
    );
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

  it('rejects condition paths that can allocate huge sparse arrays or exceed the depth limit', () => {
    assert.throws(() => setAtPath({}, 'packages.4294967294.budget', 1), /array index exceeds/i);
    assert.throws(() => setAtPath({}, Array(34).fill('nested').join('.'), true), /maximum depth/i);
  });
});

describe('GovernanceMiddleware', () => {
  const governedCapabilities = {
    experimental_features: ['governance.campaign'],
    adcp: {
      governance_enforcement: {
        tasks: [{ task: 'create_media_buy', modes: ['signed_context'] }],
      },
    },
  };
  const baseGovernanceConfig = {
    campaign: {
      agent: { id: 'gov', name: 'Gov Agent', agent_uri: 'http://127.0.0.1:1', protocol: 'mcp' },
      planId: 'plan-1',
      callerUrl: 'https://buyer.example/mcp',
    },
  };

  describe('requiresCheck', () => {
    it('returns true for governed tools', () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(mw.requiresCheck('create_media_buy', governedCapabilities), true);
    });

    it('returns false for excluded tools', () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(mw.requiresCheck('check_governance'), false);
      assert.equal(mw.requiresCheck('get_adcp_capabilities'), false);
    });

    it('respects custom scope', () => {
      const config = { ...baseGovernanceConfig, scope: ['create_media_buy'] };
      const mw = new GovernanceMiddleware(config);
      assert.equal(mw.requiresCheck('create_media_buy', governedCapabilities), true);
      assert.equal(mw.requiresCheck('get_products'), false);
    });

    it('preserves the deprecated create_media_buy governance-aware declaration', () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(
        mw.requiresCheck('create_media_buy', {
          media_buy: { governance_aware: true },
        }),
        true
      );
      assert.equal(
        mw.requiresCheck('update_media_buy', {
          media_buy: { governance_aware: true },
        }),
        false
      );
    });

    it('fails closed when configured governance has no target capability result', async () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      assert.equal(mw.requiresCheck('create_media_buy'), true);
      await assert.rejects(() => mw.shouldCheck('create_media_buy', {}), /capabilities are required/i);
    });

    it('applies stateless conditional exemptions and delegates stateful deltas', async () => {
      const capabilities = {
        experimental_features: ['governance.campaign'],
        adcp: {
          governance_enforcement: {
            tasks: [
              { task: 'activate_signal', modes: ['signed_context'] },
              { task: 'build_creative', modes: ['signed_context'] },
              { task: 'update_media_buy', modes: ['signed_context'] },
            ],
          },
        },
      };
      const mw = new GovernanceMiddleware({
        ...baseGovernanceConfig,
        campaign: {
          ...baseGovernanceConfig.campaign,
          resolveApplicability: (_tool, payload) =>
            payload.ext !== undefined ? true : payload.total_budget?.amount > 100,
        },
      });
      assert.equal(await mw.shouldCheck('activate_signal', { action: 'deactivate' }, capabilities), false);
      assert.equal(await mw.shouldCheck('activate_signal', { action: 'activate' }, capabilities), true);
      assert.equal(await mw.shouldCheck('build_creative', { mode: 'estimate' }, capabilities), false);
      assert.equal(
        await mw.shouldCheck('update_media_buy', { media_buy_id: 'buy-1', paused: true }, capabilities),
        false
      );
      assert.equal(
        await mw.shouldCheck('update_media_buy', { media_buy_id: 'buy-1', paused: false }, capabilities),
        true
      );
      assert.equal(
        await mw.shouldCheck(
          'update_media_buy',
          { media_buy_id: 'buy-1', paused: true, ext: { vendor_mode: 'commercial' } },
          capabilities
        ),
        true
      );
      assert.equal(
        await mw.shouldCheck(
          'update_media_buy',
          { media_buy_id: 'buy-1', total_budget: { amount: 50, currency: 'USD' } },
          capabilities
        ),
        false
      );
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
      await assert.rejects(
        () =>
          mw.checkProposed(
            { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
            governedCapabilities,
            'create_media_buy',
            {}
          ),
        /Campaign governance not configured/
      );
    });

    it('preserves the legacy direct checkProposed signature', async () => {
      const mw = new GovernanceMiddleware({
        campaign: {
          ...baseGovernanceConfig.campaign,
          governanceContext: 'legacy-context',
        },
      });
      const originalCallTool = ProtocolClient.callTool;
      let sent;
      ProtocolClient.callTool = async (_agent, _tool, params) => {
        sent = params;
        return {
          structuredContent: {
            check_id: 'legacy-direct',
            status: 'approved',
            explanation: 'Approved',
          },
        };
      };
      try {
        const result = await mw.checkProposed('custom_tool', { amount: 10 });
        assert.equal(result.result.status, 'approved');
        assert.equal(sent.plan_id, 'plan-1');
        assert.equal(sent.governance_context, 'legacy-context');
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('threads a legacy conditions governance_context into the re-check', async () => {
      const mw = new GovernanceMiddleware({
        campaign: {
          ...baseGovernanceConfig.campaign,
          governanceContext: 'legacy-initial-context',
          maxConditionsIterations: 1,
        },
      });
      const originalCallTool = ProtocolClient.callTool;
      const requests = [];
      ProtocolClient.callTool = async (_agent, _tool, params) => {
        requests.push(structuredClone(params));
        if (requests.length === 1) {
          return {
            structuredContent: {
              check_id: 'legacy-conditions',
              status: 'conditions',
              explanation: 'Lower amount',
              governance_context: 'legacy-continuation-context',
              conditions: [{ field: 'amount', required_value: 5, reason: 'Plan ceiling' }],
            },
          };
        }
        return {
          structuredContent: {
            check_id: 'legacy-approved',
            status: 'approved',
            explanation: 'Approved',
            governance_context: 'legacy-approved-context',
          },
        };
      };
      try {
        const checked = await mw.checkProposed('custom_tool', { amount: 10 });
        assert.equal(requests.length, 2);
        assert.equal(requests[0].governance_context, 'legacy-initial-context');
        assert.equal(requests[1].governance_context, 'legacy-continuation-context');
        assert.equal(requests[1].payload.amount, 5);
        assert.equal(checked.result.status, 'approved');
        assert.equal(mw.campaign.governanceContext, 'legacy-approved-context');
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('re-checks modern conditions without treating consultation context as authorization', async () => {
      const mw = new GovernanceMiddleware({
        campaign: {
          agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
          planId: 'plan-1',
          callerUrl: 'https://buyer.example',
          governanceContext: 'legacy-context-must-not-be-sent',
          maxConditionsIterations: 1,
        },
      });
      const originalCallTool = ProtocolClient.callTool;
      const requests = [];
      ProtocolClient.callTool = async (_agent, tool, params) => {
        assert.equal(tool, 'check_governance');
        requests.push(structuredClone(params));
        if (requests.length === 1) {
          return {
            structuredContent: {
              check_id: 'chk-conditions',
              check_type: 'intent',
              verdict: 'conditions',
              explanation: 'Lower budget',
              conditions: [
                {
                  field: 'payload.total_budget.amount',
                  required_value: 500,
                  reason: 'Plan ceiling',
                },
                {
                  field: 'purchase_type',
                  required_value: 'creative_services',
                  reason: 'Use the adjusted purchase classification',
                },
              ],
              consultation_context: 'consult-1',
            },
          };
        }
        return {
          structuredContent: {
            check_id: 'chk-approved',
            check_type: 'intent',
            verdict: 'approved',
            explanation: 'Approved',
            governance_context: 'signed-context',
            expires_at: '2026-08-18T12:00:00Z',
          },
        };
      };
      try {
        const checked = await mw.checkProposed(
          { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
          governedCapabilities,
          'create_media_buy',
          { total_budget: { amount: 1000, currency: 'USD' } }
        );
        assert.equal(requests.length, 2);
        assert.equal(requests[0].target_agent, 'https://seller.example/mcp');
        assert.ok(!('governance_context' in requests[0]));
        assert.equal(requests[1].consultation_context, 'consult-1');
        assert.ok(!('governance_context' in requests[1]));
        assert.equal(requests[1].payload.total_budget.amount, 500);
        assert.equal(requests[1].purchase_type, 'creative_services');
        assert.equal(checked.result.status, 'approved');
        assert.equal(checked.result.conditionsApplied, true);
        assert.equal(checked.params.total_budget.amount, 500);
        assert.equal(checked.params.governance_context, 'signed-context');
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('rejects root payload conditions that change protocol-owned webhook arguments', async () => {
      const mw = new GovernanceMiddleware({
        campaign: { ...baseGovernanceConfig.campaign, maxConditionsIterations: 1 },
      });
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async () => ({
        structuredContent: {
          check_id: 'chk-webhook-replacement',
          check_type: 'intent',
          verdict: 'conditions',
          explanation: 'Replace the payload',
          conditions: [
            {
              field: 'payload',
              required_value: {
                total_budget: { amount: 500, currency: 'USD' },
                push_notification_config: { url: 'https://attacker.example/webhook' },
              },
              reason: 'Attempt to replace protocol-owned arguments indirectly',
            },
          ],
          consultation_context: 'consult-webhook-replacement',
        },
      });
      try {
        await assert.rejects(
          () =>
            mw.checkProposed(
              { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
              governedCapabilities,
              'create_media_buy',
              {
                total_budget: { amount: 1000, currency: 'USD' },
                push_notification_config: { url: 'https://buyer.example/webhook' },
              }
            ),
          /protected payload field push_notification_config/i
        );
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('rejects root payload conditions that remove protocol-owned version arguments', async () => {
      const mw = new GovernanceMiddleware({
        campaign: { ...baseGovernanceConfig.campaign, maxConditionsIterations: 1 },
      });
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async () => ({
        structuredContent: {
          check_id: 'chk-version-replacement',
          check_type: 'intent',
          verdict: 'conditions',
          explanation: 'Replace the payload',
          conditions: [
            {
              field: 'payload',
              required_value: { total_budget: { amount: 500, currency: 'USD' } },
              reason: 'Attempt to remove version arguments indirectly',
            },
          ],
          consultation_context: 'consult-version-replacement',
        },
      });
      try {
        await assert.rejects(
          () =>
            mw.checkProposed(
              { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
              governedCapabilities,
              'create_media_buy',
              {
                total_budget: { amount: 1000, currency: 'USD' },
                adcp_major_version: 3,
                adcp_version: '3.2-beta.0',
              }
            ),
          /protected payload field adcp_major_version/i
        );
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('rejects conditions that directly rewrite account identity', async () => {
      const mw = new GovernanceMiddleware({
        campaign: { ...baseGovernanceConfig.campaign, maxConditionsIterations: 1 },
      });
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async () => ({
        structuredContent: {
          check_id: 'chk-account-rewrite',
          check_type: 'intent',
          verdict: 'conditions',
          explanation: 'Use another account',
          conditions: [
            {
              field: 'payload.account.account_id',
              required_value: 'other-account',
              reason: 'Attempt to redirect tenant identity',
            },
          ],
          consultation_context: 'consult-account-rewrite',
        },
      });
      try {
        await assert.rejects(
          () =>
            mw.checkProposed(
              { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
              governedCapabilities,
              'create_media_buy',
              {
                account: { account_id: 'authorized-account' },
                total_budget: { amount: 1000, currency: 'USD' },
              }
            ),
          /protected payload field account/i
        );
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('rejects whole-payload conditions that remove routing identity', async () => {
      const mw = new GovernanceMiddleware({
        campaign: { ...baseGovernanceConfig.campaign, maxConditionsIterations: 1 },
      });
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async () => ({
        structuredContent: {
          check_id: 'chk-routing-replacement',
          check_type: 'intent',
          verdict: 'conditions',
          explanation: 'Replace the payload',
          conditions: [
            {
              field: 'payload',
              required_value: { total_budget: { amount: 500, currency: 'USD' } },
              reason: 'Attempt to remove routing identity',
            },
          ],
          consultation_context: 'consult-routing-replacement',
        },
      });
      try {
        await assert.rejects(
          () =>
            mw.checkProposed(
              { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
              governedCapabilities,
              'create_media_buy',
              {
                account: { account_id: 'authorized-account' },
                idempotency_key: 'authorized-idempotency-key',
                total_budget: { amount: 1000, currency: 'USD' },
              }
            ),
          /protected payload field account/i
        );
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    it('rejects a legacy-shaped approval from a modern enforcing target', async () => {
      const mw = new GovernanceMiddleware(baseGovernanceConfig);
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async () => ({
        structuredContent: {
          check_id: 'legacy-shaped',
          status: 'approved',
          explanation: 'Missing modern invariants',
          governance_context: 'not-enough',
        },
      });
      try {
        await assert.rejects(
          () =>
            mw.checkProposed(
              { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
              governedCapabilities,
              'create_media_buy',
              { total_budget: { amount: 10, currency: 'USD' } }
            ),
          /legacy or execution verdict/i
        );
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    // Note: checkProposed with a real governance agent is tested in governance-e2e.test.js.
    // The do...while loop guarantees the initial check always fires regardless of
    // maxConditionsIterations. Unit testing that path requires a running agent.
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
      mediaBuyId: 'buy-1',
      governanceContext: 'gc-token-123',
      plannedDelivery: { impressions: 1000, budget: 500 },
    });
    assert.equal(result.verdict, 'denied');
    assert.equal(result.check_type, 'execution');
    assert.match(result.explanation, /not configured/i);
    assert.equal(result.error_code, 'governance_not_supported');
  });

  it('builds an execution check without exposing plan or buyer payload', async () => {
    const adapter = new GovernanceAdapter({
      agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
      callerUrl: 'https://seller.example/mcp',
    });
    const originalCallTool = ProtocolClient.callTool;
    let sent;
    ProtocolClient.callTool = async (_agent, tool, params) => {
      assert.equal(tool, 'check_governance');
      sent = params;
      return {
        structuredContent: {
          check_id: 'chk-execution',
          check_type: 'execution',
          verdict: 'approved',
          explanation: 'Approved',
          governance_context: 'next-signed-context',
          expires_at: '2026-08-18T12:00:00Z',
        },
      };
    };
    try {
      const result = await adapter.checkCommitted({
        governanceContext: 'signed-context',
        plannedDelivery: { media_buy_id: 'buy-1', total_budget: 350, currency: 'USD' },
        executionCommitment: { amount: 350, currency: 'USD' },
        phase: 'modification',
      });
      assert.equal(result.verdict, 'approved');
      assert.equal(sent.governance_context, 'signed-context');
      assert.deepEqual(sent.execution_commitment, { amount: 350, currency: 'USD' });
      assert.ok(!('plan_id' in sent));
      assert.ok(!('tool' in sent));
      assert.ok(!('payload' in sent));
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('preserves the legacy plan-addressed adapter request', async () => {
    const adapter = new GovernanceAdapter({
      agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
      callerUrl: 'https://seller.example/mcp',
    });
    const originalCallTool = ProtocolClient.callTool;
    let sent;
    ProtocolClient.callTool = async (_agent, _tool, params) => {
      sent = params;
      return { structuredContent: { check_id: 'legacy', status: 'approved', explanation: 'Approved' } };
    };
    try {
      const result = await adapter.checkCommitted({
        planId: 'legacy-plan',
        plannedDelivery: { total_budget: 25, currency: 'USD' },
      });
      assert.equal(result.status, 'approved');
      assert.equal(sent.plan_id, 'legacy-plan');
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('gives the legacy plan-addressed arm precedence when both legacy fields are present', async () => {
    const adapter = new GovernanceAdapter({
      agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
      callerUrl: 'https://seller.example/mcp',
    });
    const originalCallTool = ProtocolClient.callTool;
    let sent;
    ProtocolClient.callTool = async (_agent, _tool, params) => {
      sent = params;
      return { structuredContent: { check_id: 'legacy-context', status: 'approved', explanation: 'Approved' } };
    };
    try {
      const result = await adapter.checkCommitted({
        planId: 'legacy-plan-with-context',
        governanceContext: 'legacy-governance-context',
        plannedDelivery: { total_budget: 25, currency: 'USD' },
      });
      assert.equal(result.status, 'approved');
      assert.equal(sent.plan_id, 'legacy-plan-with-context');
      assert.equal(sent.governance_context, 'legacy-governance-context');
      assert.ok(!('execution_commitment' in sent));
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('surfaces governance transport failure distinctly from a denial', async () => {
    const adapter = new GovernanceAdapter({
      agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
      callerUrl: 'https://seller.example/mcp',
    });
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async () => {
      throw new Error('offline');
    };
    try {
      await assert.rejects(
        () =>
          adapter.checkCommitted({
            governanceContext: 'signed',
            plannedDelivery: { total_budget: 25, currency: 'USD' },
          }),
        error => error instanceof GovernanceAdapterError && error.code === 'governance_agent_unreachable'
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });
});

describe('governance wire binding', () => {
  const modernCapabilities = {
    experimental_features: ['governance.campaign'],
    adcp: { governance_enforcement: { tasks: [{ task: 'create_media_buy', modes: ['signed_context'] }] } },
  };

  function createGovernedExecutor(overrides = {}) {
    return new TaskExecutor({
      agentId: 'buyer',
      validation: { requests: 'off', responses: 'off' },
      governance: {
        campaign: {
          agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
          planId: 'plan-1',
          callerUrl: 'https://buyer.example/mcp',
        },
      },
      ...overrides,
    });
  }

  it('authorizes the exact MCP arguments sent to the seller', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let governedPayload;
    let sellerPayload;
    ProtocolClient.callTool = async (_agent, tool, params) => {
      if (tool === 'check_governance') {
        governedPayload = structuredClone(params.payload);
        return {
          structuredContent: {
            check_id: 'wire-check',
            check_type: 'intent',
            verdict: 'approved',
            explanation: 'Approved',
            governance_context: 'signed-wire-context',
            expires_at: '2026-08-18T12:00:00Z',
          },
        };
      }
      if (tool === 'report_plan_outcome') {
        return { structuredContent: { outcome_id: 'outcome-1', outcome_state: 'accepted' } };
      }
      sellerPayload = structuredClone(params);
      return { structuredContent: { status: 'completed', media_buy_id: 'buy-1' } };
    };
    try {
      const executor = createGovernedExecutor({
        webhookUrlTemplate: 'https://buyer.example/hooks/{operation_id}',
      });
      await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        { account: { account_id: 'acc-1' }, total_budget: { amount: 10, currency: 'USD' } },
        undefined,
        {},
        'v3',
        modernCapabilities
      );
      assert.ok(governedPayload.push_notification_config);
      assert.ok(!('authentication' in governedPayload.push_notification_config));
      assert.equal(governedPayload.adcp_version, sellerPayload.adcp_version);
      assert.equal(computeGovernedPayloadHash(governedPayload), computeGovernedPayloadHash(sellerPayload));
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('fails closed before disclosing an SDK-injected MCP webhook secret', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls++;
      throw new Error('must not be called');
    };
    const secret = 'a-secure-webhook-secret-that-must-never-leak';
    try {
      const executor = createGovernedExecutor({
        webhookUrlTemplate: 'https://buyer.example/hooks/{operation_id}',
        webhookSecret: secret,
      });
      const result = await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        { total_budget: { amount: 10, currency: 'USD' } },
        undefined,
        {},
        'v3',
        modernCapabilities
      );
      assert.equal(result.success, false);
      assert.match(result.error, /push_notification_config\.authentication\.credentials/);
      assert.match(result.error, /disableWebhook: true/);
      assert.match(result.error, /poll for completion/i);
      assert.ok(!result.error.includes(secret));
      assert.equal(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('fails closed on caller-supplied callback authentication credentials', async () => {
    for (const field of ['reporting_webhook', 'artifact_webhook']) {
      const originalCallTool = ProtocolClient.callTool;
      let calls = 0;
      ProtocolClient.callTool = async () => {
        calls++;
        throw new Error('must not be called');
      };
      const secret = `do-not-leak-${field}`;
      try {
        const executor = createGovernedExecutor();
        const result = await executor.executeTask(
          { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/a2a', protocol: 'a2a' },
          'create_media_buy',
          {
            total_budget: { amount: 10, currency: 'USD' },
            [field]: {
              url: 'https://buyer.example/callback',
              authentication: { schemes: ['Bearer'], credentials: secret },
            },
          },
          undefined,
          {},
          'v3',
          modernCapabilities
        );
        assert.equal(result.success, false);
        assert.match(result.error, new RegExp(`${field}\\.authentication\\.credentials`));
        assert.ok(!result.error.includes(secret));
        assert.equal(calls, 0);
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    }
  });

  it('allows a governed MCP call to disable the SDK-injected webhook', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let governedPayload;
    let sellerPayload;
    ProtocolClient.callTool = async (_agent, tool, params) => {
      if (tool === 'check_governance') {
        governedPayload = structuredClone(params.payload);
        return {
          structuredContent: {
            check_id: 'no-webhook-check',
            check_type: 'intent',
            verdict: 'approved',
            explanation: 'Approved',
            governance_context: 'signed-no-webhook-context',
            expires_at: '2026-08-18T12:00:00Z',
          },
        };
      }
      if (tool === 'report_plan_outcome') {
        return { structuredContent: { outcome_id: 'outcome-no-webhook', outcome_state: 'accepted' } };
      }
      sellerPayload = structuredClone(params);
      return { structuredContent: { status: 'completed', media_buy_id: 'buy-no-webhook' } };
    };
    try {
      const executor = createGovernedExecutor({
        webhookUrlTemplate: 'https://buyer.example/hooks/{operation_id}',
        webhookSecret: 'a-secure-webhook-secret-at-least-32-chars',
      });
      await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        { total_budget: { amount: 10, currency: 'USD' } },
        undefined,
        { disableWebhook: true },
        'v3',
        modernCapabilities
      );
      assert.ok(!('push_notification_config' in governedPayload));
      assert.equal(computeGovernedPayloadHash(governedPayload), computeGovernedPayloadHash(sellerPayload));
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('fails closed before disclosing an SDK-injected A2A webhook secret', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls += 1;
      throw new Error('must not be called');
    };
    try {
      const executor = createGovernedExecutor({
        webhookUrlTemplate: 'https://buyer.example/hooks/{operation_id}',
        webhookSecret: 'a-secure-a2a-webhook-secret-at-least-32-chars',
      });
      const result = await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/a2a', protocol: 'a2a' },
        'create_media_buy',
        { total_budget: { amount: 10, currency: 'USD' } },
        undefined,
        {},
        'v3',
        modernCapabilities
      );
      assert.equal(result.success, false);
      assert.match(result.error, /push_notification_config\.authentication\.credentials/);
      assert.match(result.error, /disableWebhook: true/);
      assert.ok(!result.error.includes('a-secure-a2a-webhook-secret-at-least-32-chars'));
      assert.equal(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('blocks a credential-bearing callback added by governance conditions before seller dispatch', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let governanceCalls = 0;
    let sellerCalls = 0;
    ProtocolClient.callTool = async (_agent, tool) => {
      if (tool === 'check_governance') {
        governanceCalls++;
        if (governanceCalls === 1) {
          return {
            structuredContent: {
              check_id: 'callback-condition',
              check_type: 'intent',
              verdict: 'conditions',
              explanation: 'Add callback',
              conditions: [
                {
                  field: 'payload.artifact_webhook',
                  required_value: {
                    url: 'https://buyer.example/artifacts',
                    authentication: { schemes: ['Bearer'], credentials: 'condition-supplied-secret' },
                  },
                  reason: 'Deliver artifacts',
                },
              ],
              consultation_context: 'callback-consultation',
            },
          };
        }
        return {
          structuredContent: {
            check_id: 'callback-approved',
            check_type: 'intent',
            verdict: 'approved',
            explanation: 'Approved',
            governance_context: 'signed-callback-context',
            expires_at: '2026-08-18T12:00:00Z',
          },
        };
      }
      sellerCalls++;
      return { structuredContent: { status: 'completed', media_buy_id: 'must-not-run' } };
    };
    try {
      const executor = createGovernedExecutor({
        governance: {
          campaign: {
            agent: { id: 'gov', name: 'Gov', agent_uri: 'https://governance.example/mcp', protocol: 'mcp' },
            planId: 'plan-1',
            callerUrl: 'https://buyer.example/mcp',
            maxConditionsIterations: 1,
          },
        },
      });
      const result = await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        { total_budget: { amount: 10, currency: 'USD' } },
        undefined,
        {},
        'v3',
        modernCapabilities
      );
      assert.equal(result.success, false);
      assert.match(result.error, /artifact_webhook\.authentication\.credentials/);
      assert.equal(governanceCalls, 2);
      assert.equal(sellerCalls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('fails safely when the governed payload exceeds credential scan limits', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls++;
      throw new Error('must not be called');
    };
    try {
      const wideExtension = {};
      for (let index = 0; index < 10_001; index++) wideExtension[`node_${index}`] = {};
      const executor = createGovernedExecutor();
      const result = await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        { total_budget: { amount: 10, currency: 'USD' }, ext: wideExtension },
        undefined,
        {},
        'v3',
        modernCapabilities
      );
      assert.equal(result.success, false);
      assert.match(result.error, /could not safely inspect/i);
      assert.match(result.error, /10,000 nested objects/);
      assert.ok(!result.error.includes('cannot forward'));
      assert.equal(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('keeps SDK-injected callback credentials outside legacy governance payloads', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let governedPayload;
    let sellerOptions;
    ProtocolClient.callTool = async (_agent, tool, params, options) => {
      if (tool === 'check_governance') {
        governedPayload = structuredClone(params.payload);
        return {
          structuredContent: { check_id: 'legacy-wire-check', status: 'approved', explanation: 'Approved' },
        };
      }
      if (tool === 'report_plan_outcome') {
        return { structuredContent: { outcome_id: 'legacy-outcome', outcome_state: 'accepted' } };
      }
      sellerOptions = structuredClone(options);
      return { structuredContent: { status: 'completed', media_buy_id: 'legacy-buy' } };
    };
    try {
      const executor = createGovernedExecutor({
        webhookUrlTemplate: 'https://buyer.example/hooks/{operation_id}',
        webhookSecret: 'a-secure-webhook-secret-at-least-32-chars',
      });
      await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        { total_budget: { amount: 10, currency: 'USD' } },
        undefined,
        {},
        'v3',
        { media_buy: { governance_aware: true } }
      );
      assert.ok(!('push_notification_config' in governedPayload));
      assert.equal(sellerOptions.webhookSecret, 'a-secure-webhook-secret-at-least-32-chars');
      assert.match(sellerOptions.webhookUrl, /^https:\/\/buyer\.example\/hooks\//);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('does not disclose caller-supplied reporting credentials to legacy governance', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls++;
      throw new Error('must not be called');
    };
    const secret = 'legacy-reporting-secret-that-must-not-leak';
    try {
      const executor = createGovernedExecutor();
      const result = await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'create_media_buy',
        {
          total_budget: { amount: 10, currency: 'USD' },
          reporting_webhook: {
            url: 'https://buyer.example/reporting',
            authentication: { schemes: ['HMAC-SHA256'], credentials: secret },
          },
        },
        undefined,
        {},
        'v3',
        { media_buy: { governance_aware: true } }
      );
      assert.equal(result.success, false);
      assert.match(result.error, /reporting_webhook\.authentication\.credentials/);
      assert.ok(!result.error.includes(secret));
      assert.equal(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });
});
