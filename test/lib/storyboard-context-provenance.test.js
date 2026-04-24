/**
 * Tests for provenance-aware context writers (issue #870).
 *
 * `extractContextWithProvenance` and `applyContextOutputsWithProvenance`
 * mirror their non-provenance counterparts but also return the per-key
 * origin info the rejection-hint detector needs to trace a rejected value
 * back to the step that wrote it.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractContext,
  extractContextWithProvenance,
  applyContextOutputs,
  applyContextOutputsWithProvenance,
} = require('../../dist/lib/testing/storyboard/context');

describe('extractContextWithProvenance', () => {
  test('returns same values as extractContext', () => {
    const data = { products: [{ product_id: 'prd_1' }] };
    const plain = extractContext('get_products', data);
    const withProv = extractContextWithProvenance('get_products', data, 'step_1');
    assert.deepEqual(withProv.values, plain);
  });

  test('tags each written key as convention-sourced', () => {
    const data = { products: [{ product_id: 'prd_1' }] };
    const { provenance } = extractContextWithProvenance('get_products', data, 'step_1');
    assert.equal(provenance.product_id.source_step_id, 'step_1');
    assert.equal(provenance.product_id.source_kind, 'convention');
    assert.equal(provenance.product_id.source_task, 'get_products');
    assert.equal(provenance.product_id.response_path, undefined);
  });

  test('returns empty provenance when no values extracted', () => {
    const { values, provenance } = extractContextWithProvenance('get_products', { products: [] }, 's');
    assert.deepEqual(values, {});
    assert.deepEqual(provenance, {});
  });

  test('returns empty provenance for unknown task', () => {
    const { values, provenance } = extractContextWithProvenance('not_a_task', { x: 1 }, 's');
    assert.deepEqual(values, {});
    assert.deepEqual(provenance, {});
  });
});

describe('applyContextOutputsWithProvenance', () => {
  test('returns same values as applyContextOutputs', () => {
    const data = { signals: [{ pricing_options: [{ pricing_option_id: 'po_x' }] }] };
    const outputs = [
      { key: 'first_signal_pricing_option_id', path: 'signals[0].pricing_options[0].pricing_option_id' },
    ];
    const plain = applyContextOutputs(data, outputs);
    const withProv = applyContextOutputsWithProvenance(data, outputs, 'search_by_spec', 'get_signals');
    assert.deepEqual(withProv.values, plain);
  });

  test('records YAML response_path per output', () => {
    const data = { signals: [{ pricing_options: [{ pricing_option_id: 'po_x' }] }] };
    const outputs = [
      { key: 'first_signal_pricing_option_id', path: 'signals[0].pricing_options[0].pricing_option_id' },
    ];
    const { provenance } = applyContextOutputsWithProvenance(data, outputs, 'search_by_spec', 'get_signals');
    assert.equal(provenance.first_signal_pricing_option_id.source_step_id, 'search_by_spec');
    assert.equal(provenance.first_signal_pricing_option_id.source_kind, 'context_outputs');
    assert.equal(
      provenance.first_signal_pricing_option_id.response_path,
      'signals[0].pricing_options[0].pricing_option_id'
    );
    assert.equal(provenance.first_signal_pricing_option_id.source_task, 'get_signals');
  });

  test('evaluates deep paths with array indices (resolvePath passthrough)', () => {
    const data = {
      signals: [
        { pricing_options: [{ pricing_option_id: 'po_a' }, { pricing_option_id: 'po_b' }] },
        { pricing_options: [{ pricing_option_id: 'po_c' }] },
      ],
    };
    const outputs = [
      { key: 'po_first', path: 'signals[0].pricing_options[0].pricing_option_id' },
      { key: 'po_second_signal', path: 'signals[1].pricing_options[0].pricing_option_id' },
    ];
    const { values, provenance } = applyContextOutputsWithProvenance(data, outputs, 'step', 'get_signals');
    assert.equal(values.po_first, 'po_a');
    assert.equal(values.po_second_signal, 'po_c');
    assert.equal(provenance.po_first.response_path, 'signals[0].pricing_options[0].pricing_option_id');
    assert.equal(provenance.po_second_signal.response_path, 'signals[1].pricing_options[0].pricing_option_id');
  });

  test('omits provenance for outputs that resolved to undefined', () => {
    const outputs = [
      { key: 'present', path: 'a' },
      { key: 'missing', path: 'b' },
    ];
    const { values, provenance } = applyContextOutputsWithProvenance({ a: 'yes' }, outputs, 's', 't');
    assert.deepEqual(values, { present: 'yes' });
    assert.equal(provenance.present.source_kind, 'context_outputs');
    assert.equal(provenance.missing, undefined);
  });
});
