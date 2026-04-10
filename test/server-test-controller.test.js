const { describe, it } = require('node:test');
const assert = require('node:assert');
const { handleTestControllerRequest, TestControllerError } = require('../dist/lib/server/test-controller');

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
});
