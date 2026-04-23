const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  handleTestControllerRequest,
  TestControllerError,
  CONTROLLER_SCENARIOS,
  SESSION_ENTRY_CAP,
  enforceMapCap,
  toMcpResponse,
  TOOL_INPUT_SHAPE,
} = require('../dist/lib/server/test-controller');
const { expectControllerError, expectControllerSuccess } = require('../dist/lib/testing/controller-assertions');
const { z } = require('zod');

describe('handleTestControllerRequest', () => {
  // ── list_scenarios ──────────────────────────────────────

  describe('list_scenarios', () => {
    it('auto-detects scenarios from store methods', async () => {
      const store = {
        async forceCreativeStatus() {},
        async forceAccountStatus() {},
      };
      const result = await handleTestControllerRequest(store, { scenario: 'list_scenarios' });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.scenarios, ['force_creative_status', 'force_account_status']);
    });

    it('returns all scenarios when store is fully implemented', async () => {
      const store = {
        async forceCreativeStatus() {},
        async forceAccountStatus() {},
        async forceMediaBuyStatus() {},
        async forceSessionStatus() {},
        async simulateDelivery() {},
        async simulateBudgetSpend() {},
      };
      const result = await handleTestControllerRequest(store, { scenario: 'list_scenarios' });
      assert.strictEqual(result.scenarios.length, 6);
    });

    it('returns empty scenarios for empty store', async () => {
      const result = await handleTestControllerRequest({}, { scenario: 'list_scenarios' });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.scenarios, []);
    });
  });

  // ── force_creative_status ───────────────────────────────

  describe('force_creative_status', () => {
    it('calls store and returns transition result', async () => {
      const store = {
        async forceCreativeStatus(id, status, reason) {
          return { success: true, previous_state: 'processing', current_state: status };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_creative_status',
        params: { creative_id: 'cr-1', status: 'approved' },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.previous_state, 'processing');
      assert.strictEqual(result.current_state, 'approved');
    });

    it('passes rejection_reason to store', async () => {
      let capturedReason;
      const store = {
        async forceCreativeStatus(id, status, reason) {
          capturedReason = reason;
          return { success: true, previous_state: 'pending_review', current_state: 'rejected' };
        },
      };
      await handleTestControllerRequest(store, {
        scenario: 'force_creative_status',
        params: { creative_id: 'cr-1', status: 'rejected', rejection_reason: 'Brand safety' },
      });
      assert.strictEqual(capturedReason, 'Brand safety');
    });

    it('returns UNKNOWN_SCENARIO when store lacks method', async () => {
      const result = await handleTestControllerRequest(
        {},
        {
          scenario: 'force_creative_status',
          params: { creative_id: 'cr-1', status: 'approved' },
        }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'UNKNOWN_SCENARIO');
    });

    it('returns INVALID_PARAMS when params are missing', async () => {
      const store = { async forceCreativeStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_creative_status',
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });
  });

  // ── force_account_status ────────────────────────────────

  describe('force_account_status', () => {
    it('calls store and returns transition result', async () => {
      const store = {
        async forceAccountStatus(id, status) {
          return { success: true, previous_state: 'active', current_state: status };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.current_state, 'suspended');
    });

    it('returns INVALID_PARAMS without account_id', async () => {
      const store = { async forceAccountStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_account_status',
        params: { status: 'suspended' },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });
  });

  // ── force_media_buy_status ──────────────────────────────

  describe('force_media_buy_status', () => {
    it('calls store and returns transition result', async () => {
      const store = {
        async forceMediaBuyStatus(id, status) {
          return { success: true, previous_state: 'active', current_state: status };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: 'mb-1', status: 'completed' },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.current_state, 'completed');
    });
  });

  // ── force_session_status ────────────────────────────────

  describe('force_session_status', () => {
    it('calls store with termination reason', async () => {
      let capturedReason;
      const store = {
        async forceSessionStatus(id, status, reason) {
          capturedReason = reason;
          return { success: true, previous_state: 'active', current_state: status };
        },
      };
      await handleTestControllerRequest(store, {
        scenario: 'force_session_status',
        params: { session_id: 'sess-1', status: 'terminated', termination_reason: 'session_timeout' },
      });
      assert.strictEqual(capturedReason, 'session_timeout');
    });
  });

  // ── simulate_delivery ───────────────────────────────────

  describe('simulate_delivery', () => {
    it('calls store with delivery params', async () => {
      const store = {
        async simulateDelivery(mediaBuyId, params) {
          return {
            success: true,
            simulated: { impressions: params.impressions, clicks: params.clicks },
          };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'simulate_delivery',
        params: { media_buy_id: 'mb-1', impressions: 10000, clicks: 150 },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.simulated.impressions, 10000);
    });

    it('returns INVALID_PARAMS without media_buy_id', async () => {
      const store = { async simulateDelivery() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'simulate_delivery',
        params: { impressions: 100 },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });
  });

  // ── simulate_budget_spend ───────────────────────────────

  describe('simulate_budget_spend', () => {
    it('calls store with media_buy_id variant', async () => {
      const store = {
        async simulateBudgetSpend(params) {
          return {
            success: true,
            simulated: { spend_percentage: params.spend_percentage },
          };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: 'mb-1', spend_percentage: 95 },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.simulated.spend_percentage, 95);
    });

    it('returns INVALID_PARAMS without spend_percentage', async () => {
      const store = { async simulateBudgetSpend() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: 'mb-1' },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });

    it('returns INVALID_PARAMS without account_id or media_buy_id', async () => {
      const store = { async simulateBudgetSpend() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'simulate_budget_spend',
        params: { spend_percentage: 50 },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });
  });

  // ── TestControllerError handling ────────────────────────

  describe('TestControllerError', () => {
    it('converts thrown error to ControllerError response', async () => {
      const store = {
        async forceAccountStatus() {
          throw new TestControllerError('NOT_FOUND', 'Account not found');
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-999', status: 'suspended' },
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'NOT_FOUND');
      assert.strictEqual(result.error_detail, 'Account not found');
    });

    it('includes current_state when provided', async () => {
      const store = {
        async forceMediaBuyStatus() {
          throw new TestControllerError('INVALID_TRANSITION', 'Cannot pause completed buy', 'completed');
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: 'mb-1', status: 'paused' },
      });
      assert.strictEqual(result.current_state, 'completed');
    });

    it('catches non-TestControllerError as INTERNAL_ERROR', async () => {
      const store = {
        async forceAccountStatus() {
          throw new Error('db connection failed');
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'INTERNAL_ERROR');
      assert.ok(!result.error_detail.includes('db connection'));
    });
  });

  // ── Edge cases ──────────────────────────────────────────

  describe('edge cases', () => {
    it('returns INVALID_PARAMS when scenario is missing', async () => {
      const result = await handleTestControllerRequest({}, {});
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });

    it('returns UNKNOWN_SCENARIO for unrecognized scenario', async () => {
      const result = await handleTestControllerRequest(
        {},
        {
          scenario: 'force_something_else',
          params: {},
        }
      );
      assert.strictEqual(result.error, 'UNKNOWN_SCENARIO');
      assert.strictEqual(result.error_detail, 'Unrecognized scenario name');
    });

    it('accepts spend_percentage of 0', async () => {
      const store = {
        async simulateBudgetSpend(params) {
          return { success: true, simulated: { spend_percentage: params.spend_percentage } };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: 'mb-1', spend_percentage: 0 },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.simulated.spend_percentage, 0);
    });

    it('returns INVALID_PARAMS for force_creative_status missing creative_id', async () => {
      const store = { async forceCreativeStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_creative_status',
        params: { status: 'approved' },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });

    it('rejects invalid status enum values', async () => {
      const store = {
        async forceAccountStatus() {
          return { success: true, previous_state: 'active', current_state: 'banana' };
        },
      };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'banana' },
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'INVALID_PARAMS');
      assert.ok(result.error_detail.includes('Invalid account status'));
    });

    it('rejects invalid creative status', async () => {
      const store = { async forceCreativeStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_creative_status',
        params: { creative_id: 'cr-1', status: 'invalid' },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });

    it('rejects invalid media buy status', async () => {
      const store = { async forceMediaBuyStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: 'mb-1', status: 'invalid' },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });

    it('rejects invalid session status', async () => {
      const store = { async forceSessionStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'force_session_status',
        params: { session_id: 'sess-1', status: 'invalid' },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS');
    });

    it('list_scenarios ignores extraneous params', async () => {
      const store = { async forceAccountStatus() {} };
      const result = await handleTestControllerRequest(store, {
        scenario: 'list_scenarios',
        params: { extra: 'ignored' },
      });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.scenarios, ['force_account_status']);
    });
  });

  // ── factory overload ────────────────────────────────────

  describe('factory { scenarios, createStore }', () => {
    it('invokes createStore once per request with input', async () => {
      let factoryCalls = 0;
      let capturedInput;
      const factory = {
        scenarios: ['force_account_status'],
        async createStore(input) {
          factoryCalls++;
          capturedInput = input;
          return {
            async forceAccountStatus(id, status) {
              return { success: true, previous_state: 'active', current_state: status };
            },
          };
        },
      };

      const result = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });

      assert.strictEqual(factoryCalls, 1);
      assert.strictEqual(capturedInput.params.account_id, 'acct-1');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.current_state, 'suspended');
    });

    it('answers list_scenarios from the declared set WITHOUT invoking createStore', async () => {
      let createStoreCalls = 0;
      const factory = {
        scenarios: ['force_account_status', 'simulate_delivery'],
        async createStore() {
          createStoreCalls++;
          throw new Error('createStore must not run on list_scenarios probes');
        },
      };
      const result = await handleTestControllerRequest(factory, { scenario: 'list_scenarios' });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.scenarios, ['force_account_status', 'simulate_delivery']);
      assert.strictEqual(createStoreCalls, 0);
    });

    it('supports synchronous createStore', async () => {
      const factory = {
        scenarios: ['force_account_status'],
        createStore() {
          return {
            async forceAccountStatus(id, status) {
              return { success: true, previous_state: 'active', current_state: status };
            },
          };
        },
      };
      const result = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, true);
    });

    it('converts TestControllerError thrown during resolution to typed response', async () => {
      const factory = {
        scenarios: ['force_account_status'],
        createStore() {
          throw new TestControllerError('FORBIDDEN', 'Sandbox is disabled for this tenant');
        },
      };
      const result = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'FORBIDDEN');
    });

    it('converts sync-thrown factory errors to INTERNAL_ERROR without leaking detail', async () => {
      const factory = {
        scenarios: ['force_account_status'],
        createStore() {
          throw new Error('db connection lost');
        },
      };
      const result = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'INTERNAL_ERROR');
      assert.ok(!result.error_detail.includes('db connection'));
    });

    it('converts async-rejected factory errors to INTERNAL_ERROR without leaking detail', async () => {
      const factory = {
        scenarios: ['force_account_status'],
        async createStore() {
          return Promise.reject(new Error('Postgres timeout'));
        },
      };
      const result = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'INTERNAL_ERROR');
      assert.ok(!result.error_detail.includes('Postgres'));
    });

    it('includes the scenario name in createStore failure detail so sellers can debug', async () => {
      const factory = {
        scenarios: ['force_account_status'],
        createStore() {
          throw new Error('bug');
        },
      };
      const result = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error_detail, /force_account_status/);
      assert.ok(!result.error_detail.includes('bug'));
    });

    it('re-invokes createStore for each request so closures see fresh state', async () => {
      // Simulate a session that gets rehydrated between requests — the canonical
      // WeakMap-keyed-by-session-ref pitfall. createStore binds to the current
      // session object so reads see the writes from the prior request.
      const persistedState = { status: 'active' };
      function loadSession() {
        return { status: persistedState.status };
      }
      const factory = {
        scenarios: ['force_account_status'],
        createStore() {
          const session = loadSession();
          return {
            async forceAccountStatus(id, status) {
              const prev = session.status;
              session.status = status;
              persistedState.status = status;
              return { success: true, previous_state: prev, current_state: status };
            },
          };
        },
      };

      const first = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
      });
      const second = await handleTestControllerRequest(factory, {
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'active' },
      });

      assert.strictEqual(first.previous_state, 'active');
      assert.strictEqual(second.previous_state, 'suspended');
    });
  });
});

// ── Scenario name constants ────────────────────────────────

describe('CONTROLLER_SCENARIOS', () => {
  it('maps const keys to wire-format scenario names', () => {
    assert.strictEqual(CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS, 'force_account_status');
    assert.strictEqual(CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND, 'simulate_budget_spend');
  });

  it('dispatches via const-name', async () => {
    const store = {
      async forceAccountStatus(id, status) {
        return { success: true, previous_state: 'active', current_state: status };
      },
    };
    const result = await handleTestControllerRequest(store, {
      scenario: CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS,
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(result.success, true);
  });
});

// ── enforceMapCap ──────────────────────────────────────────

describe('enforceMapCap', () => {
  it('exports default cap of 1000', () => {
    assert.strictEqual(SESSION_ENTRY_CAP, 1000);
  });

  it('accepts net-new keys below the cap', () => {
    const m = new Map();
    for (let i = 0; i < 5; i++) {
      enforceMapCap(m, `k${i}`, 'things', 10);
      m.set(`k${i}`, i);
    }
    assert.strictEqual(m.size, 5);
  });

  it('allows overwriting an existing key at the cap', () => {
    const m = new Map();
    for (let i = 0; i < 3; i++) m.set(`k${i}`, i);
    // At cap, but key already exists — should not throw
    assert.doesNotThrow(() => enforceMapCap(m, 'k1', 'things', 3));
  });

  it('throws INVALID_STATE when adding a net-new key at the cap', () => {
    const m = new Map();
    for (let i = 0; i < 3; i++) m.set(`k${i}`, i);
    assert.throws(
      () => enforceMapCap(m, 'k999', 'account statuses', 3),
      err => {
        assert.ok(err instanceof TestControllerError);
        assert.strictEqual(err.code, 'INVALID_STATE');
        assert.match(err.message, /account statuses/);
        assert.match(err.message, /limit 3/);
        return true;
      }
    );
  });

  it('surfaces as a typed ControllerError when thrown from a store method', async () => {
    const m = new Map();
    for (let i = 0; i < 3; i++) m.set(`existing${i}`, 'active');
    const store = {
      async forceAccountStatus(id, status) {
        enforceMapCap(m, id, 'account statuses', 3);
        m.set(id, status);
        return { success: true, previous_state: null, current_state: status };
      },
    };
    const result = await handleTestControllerRequest(store, {
      scenario: 'force_account_status',
      params: { account_id: 'new-account', status: 'suspended' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'INVALID_STATE');
  });
});

describe('enforceMapCap label sanitization', () => {
  it('truncates label to 64 chars in the error message', () => {
    const m = new Map();
    for (let i = 0; i < 3; i++) m.set(`k${i}`, i);
    const longLabel = 'a'.repeat(200);
    try {
      enforceMapCap(m, 'new', longLabel, 3);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof TestControllerError);
      // Label portion of message should be capped; full 200-char label must not appear verbatim.
      assert.ok(!err.message.includes(longLabel));
      assert.ok(err.message.includes('a'.repeat(64)));
    }
  });

  it('strips non-printable characters from label', () => {
    const m = new Map();
    for (let i = 0; i < 3; i++) m.set(`k${i}`, i);
    try {
      enforceMapCap(m, 'new', 'injected\x00\x1bnewline\n', 3);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(!err.message.includes('\x00'));
      assert.ok(!err.message.includes('\x1b'));
      assert.ok(!err.message.includes('\n'));
    }
  });
});

// ── toMcpResponse ──────────────────────────────────────────

describe('toMcpResponse', () => {
  it('wraps success responses without isError', () => {
    const wrapped = toMcpResponse({ success: true, scenarios: ['force_account_status'] });
    assert.strictEqual(wrapped.isError, undefined);
    assert.ok(Array.isArray(wrapped.content));
    assert.match(wrapped.content[0].text, /Supported scenarios/);
  });

  it('sets isError: true on ControllerError responses', () => {
    const wrapped = toMcpResponse({ success: false, error: 'NOT_FOUND', error_detail: 'Account not found' });
    assert.strictEqual(wrapped.isError, true);
    assert.match(wrapped.content[0].text, /NOT_FOUND/);
  });

  it('emits structuredContent that round-trips the response shape', () => {
    const data = { success: true, previous_state: 'active', current_state: 'suspended' };
    const wrapped = toMcpResponse(data);
    assert.ok(wrapped.structuredContent, 'structuredContent should be present');
    assert.strictEqual(wrapped.structuredContent.current_state, 'suspended');
    assert.strictEqual(wrapped.structuredContent.previous_state, 'active');
  });
});

// ── registerTestController context echo ──────────────────
//
// Storyboards (controller_validation, deterministic_*) check `field_present: context`
// on every comply_test_controller response. `createAdcpServer` auto-echoes context
// for domain tools; `registerTestController` bypasses that pipeline, so the wrapper
// has to inject context itself or every storyboard fails. Regression test for that
// echo behavior.

describe('registerTestController context echo', () => {
  function makeFakeMcpServer() {
    const handlers = {};
    return {
      registerTool: (name, _meta, handler) => {
        handlers[name] = handler;
      },
      invoke: async (name, input) => handlers[name](input),
    };
  }

  it('attaches input.context to the structuredContent when handler does not set one', async () => {
    const { registerTestController } = require('../dist/lib/server/test-controller');
    const server = makeFakeMcpServer();
    const store = {
      async forceAccountStatus() {
        return { success: true, previous_state: 'active', current_state: 'suspended' };
      },
    };
    registerTestController(server, store);
    const reply = await server.invoke('comply_test_controller', {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
      context: { session_id: 'sess-abc', correlation_id: 'corr-123' },
    });
    assert.deepStrictEqual(reply.structuredContent.context, {
      session_id: 'sess-abc',
      correlation_id: 'corr-123',
    });
  });

  it('does not overwrite handler-supplied context', async () => {
    const { registerTestController } = require('../dist/lib/server/test-controller');
    const server = makeFakeMcpServer();
    const store = {
      async forceAccountStatus() {
        return {
          success: true,
          previous_state: 'active',
          current_state: 'suspended',
          context: { handler_tag: 'keeps_this' },
        };
      },
    };
    registerTestController(server, store);
    const reply = await server.invoke('comply_test_controller', {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
      context: { session_id: 'ignored' },
    });
    assert.deepStrictEqual(reply.structuredContent.context, { handler_tag: 'keeps_this' });
  });

  it('omits context when request carries none', async () => {
    const { registerTestController } = require('../dist/lib/server/test-controller');
    const server = makeFakeMcpServer();
    registerTestController(server, {
      async forceAccountStatus() {
        return { success: true, previous_state: 'active', current_state: 'suspended' };
      },
    });
    const reply = await server.invoke('comply_test_controller', {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(reply.structuredContent.context, undefined);
  });
});

// ── registerTestController capability block auto-emission ──
//
// Per AdCP 3.0, comply_test_controller support is declared via the
// `capabilities.compliance_testing` block — not as an entry in
// supported_protocols. When called against an AdcpServer produced by
// createAdcpServer, registerTestController MUST populate that block
// with the scenarios it advertises.

describe('registerTestController compliance_testing auto-emission', () => {
  it('sets capabilities.compliance_testing.scenarios from a TestControllerStoreFactory', () => {
    const { createAdcpServer, registerTestController } = require('../dist/lib/server');
    const server = createAdcpServer({
      name: 't',
      version: '0.0.1',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    registerTestController(server, {
      scenarios: ['force_media_buy_status', 'simulate_delivery'],
      createStore: () => ({
        forceMediaBuyStatus: async () => ({ success: true, previous_state: 'active', current_state: 'paused' }),
      }),
    });
    const caps = server[Symbol.for('@adcp/client.capabilities')];
    assert.ok(caps.compliance_testing, 'compliance_testing block must be emitted');
    assert.deepStrictEqual(caps.compliance_testing.scenarios, ['force_media_buy_status', 'simulate_delivery']);
  });

  it('infers scenarios from a plain TestControllerStore via method presence', () => {
    const { createAdcpServer, registerTestController } = require('../dist/lib/server');
    const server = createAdcpServer({
      name: 't',
      version: '0.0.1',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    registerTestController(server, {
      async forceCreativeStatus() {},
      async simulateBudgetSpend() {},
    });
    const caps = server[Symbol.for('@adcp/client.capabilities')];
    assert.ok(caps.compliance_testing);
    assert.ok(caps.compliance_testing.scenarios.includes('force_creative_status'));
    assert.ok(caps.compliance_testing.scenarios.includes('simulate_budget_spend'));
  });

  it('does NOT add compliance_testing to supported_protocols (it is a capability block, not a protocol)', () => {
    const { createAdcpServer, registerTestController } = require('../dist/lib/server');
    const server = createAdcpServer({
      name: 't',
      version: '0.0.1',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    registerTestController(server, {
      scenarios: ['force_account_status'],
      createStore: () => ({ forceAccountStatus: async () => ({}) }),
    });
    const caps = server[Symbol.for('@adcp/client.capabilities')];
    assert.ok(!caps.supported_protocols.includes('compliance_testing'));
  });
});

// ── TOOL_INPUT_SHAPE ───────────────────────────────────────

describe('TOOL_INPUT_SHAPE', () => {
  it('exposes exactly the four canonical fields (no account — not in AdCP schema)', () => {
    assert.deepStrictEqual(Object.keys(TOOL_INPUT_SHAPE).sort(), ['context', 'ext', 'params', 'scenario']);
  });

  it('requires scenario and parses an otherwise-empty request', () => {
    const schema = z.object(TOOL_INPUT_SHAPE);
    assert.doesNotThrow(() => schema.parse({ scenario: 'list_scenarios' }));
  });

  it('rejects a request missing scenario', () => {
    const schema = z.object(TOOL_INPUT_SHAPE);
    assert.throws(() => schema.parse({}), /scenario/);
  });

  it('accepts params, context, and ext as optional records', () => {
    const schema = z.object(TOOL_INPUT_SHAPE);
    assert.doesNotThrow(() =>
      schema.parse({
        scenario: 'force_account_status',
        params: { account_id: 'acct-1', status: 'suspended' },
        context: { session_id: 'sess_1' },
        ext: { vendor_specific: true },
      })
    );
  });
});

// ── SCENARIO_MAP coverage ───────────────────────────────────

describe('CONTROLLER_SCENARIOS / SCENARIO_MAP coverage', () => {
  it('advertises every CONTROLLER_SCENARIOS value when store implements all methods', async () => {
    const store = {
      async forceCreativeStatus() {},
      async forceAccountStatus() {},
      async forceMediaBuyStatus() {},
      async forceSessionStatus() {},
      async simulateDelivery() {},
      async simulateBudgetSpend() {},
    };
    const result = await handleTestControllerRequest(store, { scenario: 'list_scenarios' });
    const expected = Object.values(CONTROLLER_SCENARIOS).sort();
    assert.deepStrictEqual([...result.scenarios].sort(), expected);
  });
});

// ── expectControllerError ──────────────────────────────────

describe('expectControllerError', () => {
  it('returns the narrowed error when codes match', () => {
    const err = expectControllerError(
      { success: false, error: 'NOT_FOUND', error_detail: 'Account not found' },
      'NOT_FOUND'
    );
    assert.strictEqual(err.error, 'NOT_FOUND');
    assert.strictEqual(err.error_detail, 'Account not found');
  });

  it('throws when the response is success-shaped', () => {
    assert.throws(
      () => expectControllerError({ success: true, scenarios: [] }, 'NOT_FOUND'),
      /expected a ControllerError/
    );
  });

  it('throws when codes do not match', () => {
    assert.throws(
      () =>
        expectControllerError({ success: false, error: 'INVALID_PARAMS', error_detail: 'missing field' }, 'NOT_FOUND'),
      /expected error code "NOT_FOUND" but got "INVALID_PARAMS"/
    );
  });
});

// ── expectControllerSuccess ────────────────────────────────

describe('expectControllerSuccess', () => {
  it('returns the narrowed success when no kind is requested', () => {
    const ok = expectControllerSuccess({ success: true, scenarios: ['force_account_status'] });
    assert.deepStrictEqual(ok.scenarios, ['force_account_status']);
  });

  it('narrows to transition arm when kind="transition"', () => {
    const ok = expectControllerSuccess(
      { success: true, previous_state: 'active', current_state: 'suspended' },
      'transition'
    );
    assert.strictEqual(ok.current_state, 'suspended');
  });

  it('narrows to simulation arm when kind="simulation"', () => {
    const ok = expectControllerSuccess({ success: true, simulated: { impressions: 10000 } }, 'simulation');
    assert.strictEqual(ok.simulated.impressions, 10000);
  });

  it('throws when response is an error', () => {
    assert.throws(
      () => expectControllerSuccess({ success: false, error: 'NOT_FOUND', error_detail: 'missing' }),
      /expected a success response but got ControllerError NOT_FOUND/
    );
  });

  it('throws when kind does not match the success arm', () => {
    assert.throws(
      () => expectControllerSuccess({ success: true, previous_state: 'active', current_state: 'suspended' }, 'list'),
      /expected "list" arm but got "transition"/
    );
  });
});
