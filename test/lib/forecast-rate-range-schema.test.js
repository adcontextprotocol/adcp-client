const assert = require('node:assert/strict');
const { test } = require('node:test');

const { ForecastRateRangeSchema } = require('../../dist/lib/schemas/index.js');

test('ForecastRateRangeSchema accepts probabilities and enforces their upper bound', () => {
  assert.equal(ForecastRateRangeSchema.safeParse({ low: 0.4, mid: 0.5, high: 0.8 }).success, true);
  assert.equal(ForecastRateRangeSchema.safeParse({ mid: 1.01 }).success, false);
});
