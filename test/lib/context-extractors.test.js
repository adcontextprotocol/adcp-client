const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractContext } = require('../../dist/lib/testing/storyboard/context.js');

describe('context extractors', () => {
  describe('check_governance', () => {
    it('extracts governance_context, check_id, plan_id, and status', () => {
      const data = {
        status: 'approved',
        check_id: 'chk_123',
        plan_id: 'plan_1',
        governance_context: 'opaque-ctx-abc123',
      };
      const result = extractContext('check_governance', data);
      assert.deepStrictEqual(result, {
        governance_context: 'opaque-ctx-abc123',
        check_id: 'chk_123',
        plan_id: 'plan_1',
        governance_status: 'approved',
      });
    });

    it('extracts only present fields', () => {
      const data = { status: 'denied' };
      const result = extractContext('check_governance', data);
      assert.deepStrictEqual(result, { governance_status: 'denied' });
    });

    it('returns empty object for empty data', () => {
      assert.deepStrictEqual(extractContext('check_governance', {}), {});
    });
  });

  describe('report_plan_outcome', () => {
    it('extracts outcome_id and outcome_status', () => {
      const data = { status: 'completed', outcome_id: 'out_456' };
      const result = extractContext('report_plan_outcome', data);
      assert.deepStrictEqual(result, { outcome_id: 'out_456', outcome_status: 'completed' });
    });

    it('returns empty object when status is missing', () => {
      assert.deepStrictEqual(extractContext('report_plan_outcome', {}), {});
    });
  });
});
