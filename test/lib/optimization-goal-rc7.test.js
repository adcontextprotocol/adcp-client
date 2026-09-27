const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CanonicalOptimizationGoalSchema,
  OptimizationGoalSchema,
} = require('../../dist/lib/types/schemas.generated.js');

for (const [name, schema] of [
  ['OptimizationGoal', OptimizationGoalSchema],
  ['CanonicalOptimizationGoal', CanonicalOptimizationGoalSchema],
]) {
  test(`${name} preserves the rc.7 metric discriminator and viewability fields`, () => {
    assert.equal(schema.safeParse({ kind: 'bogus' }).success, false);
    assert.equal(schema.safeParse({ kind: 'metric', metric: 'bogus' }).success, false);
    assert.equal(
      schema.safeParse({ kind: 'metric', metric: 'clicks', target: { kind: 'threshold_rate', value: -5 } }).success,
      false
    );

    const parsed = schema.safeParse({ kind: 'metric', metric: 'viewable_rate', standard: 'mrc' });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.kind, 'metric');
    assert.equal(parsed.data.metric, 'viewable_rate');
    assert.equal(parsed.data.standard, 'mrc');
  });
}
