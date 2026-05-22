/**
 * Tests for the seller-level capability rollup helpers
 * (adcp-client#1818).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { rollupOptimizationMetricsFromProducts } = require('../../dist/lib/utils/capability-rollups.js');

describe('rollupOptimizationMetricsFromProducts', () => {
  test('returns empty array for empty catalog', () => {
    assert.deepStrictEqual(rollupOptimizationMetricsFromProducts([]), []);
  });

  test('unions metrics across products', () => {
    const result = rollupOptimizationMetricsFromProducts([
      { metric_optimization: { supported_metrics: ['clicks', 'views'] } },
      { metric_optimization: { supported_metrics: ['views', 'completed_views'] } },
    ]);
    assert.deepStrictEqual(result, ['clicks', 'completed_views', 'views']);
  });

  test('de-duplicates within and across products', () => {
    const result = rollupOptimizationMetricsFromProducts([
      { metric_optimization: { supported_metrics: ['clicks', 'clicks', 'views'] } },
      { metric_optimization: { supported_metrics: ['clicks'] } },
    ]);
    assert.deepStrictEqual(result, ['clicks', 'views']);
  });

  test('sorts alphabetically for stable declarations', () => {
    const result = rollupOptimizationMetricsFromProducts([
      { metric_optimization: { supported_metrics: ['views', 'clicks', 'completed_views'] } },
    ]);
    assert.deepStrictEqual(result, ['clicks', 'completed_views', 'views']);
  });

  test('products without metric_optimization contribute nothing', () => {
    const result = rollupOptimizationMetricsFromProducts([
      { metric_optimization: { supported_metrics: ['clicks'] } },
      {},
      { name: 'no metric_optimization' },
    ]);
    assert.deepStrictEqual(result, ['clicks']);
  });

  test('products with empty supported_metrics contribute nothing', () => {
    const result = rollupOptimizationMetricsFromProducts([
      { metric_optimization: { supported_metrics: [] } },
      { metric_optimization: {} },
    ]);
    assert.deepStrictEqual(result, []);
  });

  test('drops non-string entries defensively', () => {
    const result = rollupOptimizationMetricsFromProducts([
      { metric_optimization: { supported_metrics: ['clicks', null, undefined, '', 42] } },
    ]);
    assert.deepStrictEqual(result, ['clicks']);
  });

  test('does not mutate input', () => {
    const input = [{ metric_optimization: { supported_metrics: ['views', 'clicks'] } }];
    const original = JSON.parse(JSON.stringify(input));
    rollupOptimizationMetricsFromProducts(input);
    assert.deepStrictEqual(input, original);
  });
});
