const assert = require('node:assert');
const { describe, test } = require('node:test');

const { BiddingPolicySchema, CanonicalBudgetAllocationSchema } = require('../../dist/lib/schemas');

describe('semantic AdCP 3.2 leaf schemas', () => {
  test('BiddingPolicySchema rejects missing, non-positive, and incompatible controls', () => {
    const invalid = [
      {},
      { extension_only: true },
      { automatic: true, max_bid: 1 },
      { bid_amount: 1, max_bid: 2 },
      { bid_amount: -1 },
      { max_bid: 0 },
      { cost_per: { amount: -1, strength: 'cap' } },
      { roas: { value: 0, strength: 'target' } },
      {
        cost_per: { amount: 1, strength: 'cap' },
        roas: { value: 2, strength: 'target' },
      },
    ];

    for (const value of invalid) {
      assert.strictEqual(BiddingPolicySchema.safeParse(value).success, false, JSON.stringify(value));
    }
  });

  test('BiddingPolicySchema preserves compatible controls and extension fields', () => {
    const value = { max_bid: 2, extension_control: { strategy: 'publisher_defined' } };
    const result = BiddingPolicySchema.safeParse(value);
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, value);
  });

  test('CanonicalBudgetAllocationSchema requires seller optimization goals', () => {
    assert.strictEqual(
      CanonicalBudgetAllocationSchema.safeParse({ mode: 'seller_optimized', optimization_goals: [] }).success,
      false
    );
    assert.strictEqual(
      CanonicalBudgetAllocationSchema.safeParse({
        mode: 'seller_optimized',
        optimization_goals: [{ kind: 'metric', metric: 'clicks' }],
      }).success,
      true
    );
  });
});
