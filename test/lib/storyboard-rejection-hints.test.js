/**
 * Tests for context-value-rejected hint detection (issue #870).
 *
 * The runner emits a non-fatal hint when a seller's error carries an
 * `available:` / `allowed:` / `accepted_values:` list and the rejected
 * request value traces back to a prior-step `$context.*` write. Without
 * the hint, the rejection in logs is indistinguishable from an SDK bug.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectContextRejectionHints } = require('../../dist/lib/testing/storyboard/rejection-hints');
const {
  extractContextWithProvenance,
  applyContextOutputsWithProvenance,
} = require('../../dist/lib/testing/storyboard/context');

function provenance(entries) {
  const m = new Map();
  for (const [key, entry] of Object.entries(entries)) m.set(key, entry);
  return m;
}

describe('detectContextRejectionHints', () => {
  test('emits hint when details.available rejects a context_outputs-sourced value', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'Pricing option not found: po_prism_abandoner_cpm',
            details: {
              field: 'packages[0].pricing_option_id',
              available: ['po_prism_cart_cpm'],
            },
          },
        ],
      },
    };
    const request = {
      packages: [{ product_id: 'prd_prism', pricing_option_id: 'po_prism_abandoner_cpm' }],
    };
    const context = { pricing_option_id: 'po_prism_abandoner_cpm' };
    const prov = provenance({
      pricing_option_id: {
        source_step_id: 'search_by_spec',
        source_kind: 'context_outputs',
        response_path: 'signals[0].pricing_options[0].pricing_option_id',
        source_task: 'get_signals',
      },
    });

    const hints = detectContextRejectionHints(taskResult, request, context, prov);

    assert.equal(hints.length, 1);
    const h = hints[0];
    assert.equal(h.kind, 'context_value_rejected');
    assert.equal(h.context_key, 'pricing_option_id');
    assert.equal(h.source_step_id, 'search_by_spec');
    assert.equal(h.source_kind, 'context_outputs');
    assert.equal(h.response_path, 'signals[0].pricing_options[0].pricing_option_id');
    assert.equal(h.rejected_value, 'po_prism_abandoner_cpm');
    assert.equal(h.request_field, 'packages[0].pricing_option_id');
    assert.deepEqual(h.accepted_values, ['po_prism_cart_cpm']);
    assert.equal(h.error_code, 'INVALID_PRICING_MODEL');
    assert.match(h.message, /\$context\.pricing_option_id/);
    assert.match(h.message, /search_by_spec/);
    assert.match(h.message, /signals\[0\]\.pricing_options\[0\]\.pricing_option_id/);
    assert.match(h.message, /po_prism_cart_cpm/);
  });

  test('emits hint when seller reports field at errors[].field (spec shape)', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'Pricing option not found',
            field: 'packages[0].pricing_option_id',
            details: { available: ['po_cart'] },
          },
        ],
      },
    };
    const request = { packages: [{ pricing_option_id: 'po_abandoner' }] };
    const context = { pricing_option_id: 'po_abandoner' };
    const prov = provenance({
      pricing_option_id: { source_step_id: 'get_signals', source_kind: 'convention', source_task: 'get_signals' },
    });

    const hints = detectContextRejectionHints(taskResult, request, context, prov);

    assert.equal(hints.length, 1);
    assert.equal(hints[0].request_field, 'packages[0].pricing_option_id');
    assert.equal(hints[0].source_kind, 'convention');
    assert.equal(hints[0].response_path, undefined);
    assert.match(hints[0].message, /convention extractor for `get_signals`/);
  });

  test('accepts RFC 6901 JSON pointer in field', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'x',
            field: '/packages/0/pricing_option_id',
            details: { accepted_values: ['po_ok'] },
          },
        ],
      },
    };
    const request = { packages: [{ pricing_option_id: 'po_bad' }] };
    const context = { pricing_option_id: 'po_bad' };
    const prov = provenance({
      pricing_option_id: {
        source_step_id: 'discovery',
        source_kind: 'context_outputs',
        response_path: 'signals[0].pricing_options[0].pricing_option_id',
      },
    });

    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].request_field, 'packages[0].pricing_option_id');
  });

  test('recognizes accepted_values: as rejection list', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_FIELD',
            message: 'no',
            field: 'format_id',
            details: { accepted_values: ['display_300x250', 'display_728x90'] },
          },
        ],
      },
    };
    const request = { format_id: 'display_bad' };
    const context = { format_id: 'display_bad' };
    const prov = provenance({
      format_id: { source_step_id: 's', source_kind: 'convention', source_task: 'list_formats' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].accepted_values, ['display_300x250', 'display_728x90']);
  });

  test('recognizes top-level available: (outside details) as rejection list', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_SIGNAL',
            message: 'no',
            field: 'signal_id',
            available: ['sig_a', 'sig_b'],
          },
        ],
      },
    };
    const request = { signal_id: 'sig_missing' };
    const context = { signal_id: 'sig_missing' };
    const prov = provenance({
      signal_id: { source_step_id: 'get_signals', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].accepted_values, ['sig_a', 'sig_b']);
  });

  test('coerces integer-like IDs across number/string boundaries', () => {
    // Agents sometimes serialize IDs as numbers vs strings; the hint
    // matcher should treat `42` and `"42"` as equal for rejection lookup.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_ACCOUNT',
            message: 'no',
            field: 'account_id',
            details: { available: ['101'] },
          },
        ],
      },
    };
    const request = { account_id: 42 };
    const context = { account_id: 42 };
    const prov = provenance({
      account_id: { source_step_id: 'list_accounts', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].rejected_value, 42);
  });

  test('coerces when context stores a string but request (or seller list) carries a number', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_ACCOUNT',
            message: 'no',
            field: 'account_id',
            details: { available: [101] }, // number
          },
        ],
      },
    };
    const request = { account_id: '42' };
    const context = { account_id: '42' };
    const prov = provenance({
      account_id: { source_step_id: 'list_accounts', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].rejected_value, '42');
  });

  test('matches nested object context values (stringify path)', () => {
    // Context carries an object; seller rejects at a nested path with
    // another object in `available:`. The stringify branch of valueEquals
    // handles this, and the no-field fallback's recursive request walk
    // finds the context object inside the request tree.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_ACCOUNT',
            message: 'no',
            details: { available: [{ brand: 'other' }] },
          },
        ],
      },
    };
    const request = { account: { brand: 'acme' } };
    const context = { account: { brand: 'acme' } };
    const prov = provenance({
      account: { source_step_id: 'sync_accounts', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].rejected_value, { brand: 'acme' });
    assert.equal(hints[0].context_key, 'account');
  });

  test('empty available: [] list still emits a hint (seller rejects with no accepted set)', () => {
    // Seller declared "I accept nothing for this field" — the hint still
    // helps the caller trace which step supplied the rejected value.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'nope',
            field: 'pricing_option_id',
            details: { available: [] },
          },
        ],
      },
    };
    const request = { pricing_option_id: 'po_x' };
    const context = { pricing_option_id: 'po_x' };
    const prov = provenance({
      pricing_option_id: { source_step_id: 's', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].accepted_values, []);
  });

  test('recognizes allowed: (as well as available:) as rejection list', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_FIELD',
            message: 'nope',
            field: 'product_id',
            details: { allowed: ['prd_ok'] },
          },
        ],
      },
    };
    const request = { product_id: 'prd_bad' };
    const context = { product_id: 'prd_bad' };
    const prov = provenance({
      product_id: { source_step_id: 's', source_kind: 'convention', source_task: 'get_products' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].accepted_values, ['prd_ok']);
  });

  test('no hint when rejected value did not come from context', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'Pricing option not found',
            field: 'packages[0].pricing_option_id',
            details: { available: ['po_cart'] },
          },
        ],
      },
    };
    const request = { packages: [{ pricing_option_id: 'po_hardcoded' }] };
    const context = { pricing_option_id: 'po_from_context' };
    const prov = provenance({
      pricing_option_id: { source_step_id: 's', source_kind: 'convention' },
    });

    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.deepEqual(hints, []);
  });

  test('no hint when response has no rejection list', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [{ code: 'INTERNAL_ERROR', message: 'oops' }],
      },
    };
    const prov = provenance({
      x: { source_step_id: 's', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, { x: 'y' }, { x: 'y' }, prov);
    assert.deepEqual(hints, []);
  });

  test('no hint when errors is absent', () => {
    const taskResult = { success: true, data: { signals: [] } };
    const prov = provenance({
      x: { source_step_id: 's', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, {}, {}, prov);
    assert.deepEqual(hints, []);
  });

  test('recognizes adcp_error singular envelope from adcpError() SDK helper', () => {
    // `adcpError()` produces `{ adcp_error: { code, message, field, details, ... } }`
    // (singular object). Most sellers use the helper, so the detector
    // must treat this as a one-element errors list. Surfaced during
    // dogfood (#907).
    const taskResult = {
      success: false,
      data: {
        adcp_error: {
          code: 'PRODUCT_NOT_FOUND',
          message: "Product 'prod-a' not found",
          recovery: 'correctable',
          field: 'packages[0].product_id',
          details: { available: ['prod-b'] },
        },
      },
    };
    const request = { packages: [{ product_id: 'prod-a' }] };
    const context = { first_product_id: 'prod-a' };
    const prov = provenance({
      first_product_id: {
        source_step_id: 'discover',
        source_kind: 'context_outputs',
        response_path: 'products[0].product_id',
        source_task: 'get_products',
      },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].error_code, 'PRODUCT_NOT_FOUND');
    assert.equal(hints[0].context_key, 'first_product_id');
    assert.equal(hints[0].rejected_value, 'prod-a');
    assert.deepEqual(hints[0].accepted_values, ['prod-b']);
  });

  test('recognizes adcp_error array envelope (defensive)', () => {
    // Some sellers have been observed emitting `adcp_error` as an array
    // rather than the canonical singular object. Handle both.
    const taskResult = {
      success: false,
      data: {
        adcp_error: [
          {
            code: 'INVALID_REQUEST',
            message: 'bad',
            field: 'x',
            details: { available: ['ok'] },
          },
        ],
      },
    };
    const request = { x: 'bad' };
    const context = { x: 'bad' };
    const prov = provenance({
      x: { source_step_id: 's', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].accepted_values, ['ok']);
  });

  test('prefers errors[] when both envelope shapes are present', () => {
    // Defensive: if an agent somehow emits BOTH (shouldn't happen but
    // possible in a migration), read the plural array — it's the
    // authoritative spec shape.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'FROM_ARRAY',
            message: '1',
            field: 'x',
            details: { available: ['ok'] },
          },
        ],
        adcp_error: {
          code: 'FROM_SINGULAR',
          message: '2',
          field: 'x',
          details: { available: ['different'] },
        },
      },
    };
    const request = { x: 'bad' };
    const context = { x: 'bad' };
    const prov = provenance({
      x: { source_step_id: 's', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].error_code, 'FROM_ARRAY');
  });

  test('no hint when taskResult is undefined', () => {
    const prov = provenance({});
    const hints = detectContextRejectionHints(undefined, {}, {}, prov);
    assert.deepEqual(hints, []);
  });

  test('no hint when seller claims to accept the rejected value (inconsistent error shape)', () => {
    // Defensive: if `available` contains the rejected value, the error is
    // internally inconsistent — don't emit a confusing hint.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'X',
            message: 'x',
            field: 'k',
            details: { available: ['po_x'] },
          },
        ],
      },
    };
    const request = { k: 'po_x' };
    const context = { k: 'po_x' };
    const prov = provenance({ k: { source_step_id: 's', source_kind: 'convention' } });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.deepEqual(hints, []);
  });

  test('no-field-pointer fallback: scans request for context-sourced rejected values', () => {
    // Seller didn't tell us which field was rejected, just the available
    // set. We should find the context-sourced value that was in the
    // request but absent from the accepted list.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'Pricing option not found',
            details: { available: ['po_good'] },
          },
        ],
      },
    };
    const request = { packages: [{ pricing_option_id: 'po_bad' }] };
    const context = { pricing_option_id: 'po_bad' };
    const prov = provenance({
      pricing_option_id: {
        source_step_id: 'search_by_spec',
        source_kind: 'context_outputs',
        response_path: 'signals[0].pricing_options[0].pricing_option_id',
      },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].context_key, 'pricing_option_id');
    assert.equal(hints[0].request_field, undefined);
  });

  test('no-field fallback ignores context values not present in the request', () => {
    // prior step wrote context.media_buy_id, but the current request is a
    // sync_creatives call that doesn't carry it. We should not emit a
    // hint for a context key that isn't in the request.
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_FORMAT',
            message: 'no',
            details: { available: ['display_banner', 'video_15s'] },
          },
        ],
      },
    };
    const request = { creatives: [{ format_id: 'display_300x250' }] };
    const context = { media_buy_id: 'mb_123', format_id: 'display_300x250' };
    const prov = provenance({
      media_buy_id: { source_step_id: 'create', source_kind: 'convention' },
      format_id: { source_step_id: 'list_formats', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].context_key, 'format_id');
  });

  test('de-dupes a single (context_key, rejected_value) across multiple errors', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'bad',
            field: 'packages[0].pricing_option_id',
            details: { available: ['po_ok'] },
          },
          {
            // Same field, same rejection, duplicate error — sellers sometimes
            // do this in verbose modes.
            code: 'INVALID_PRICING_MODEL',
            message: 'bad (again)',
            field: 'packages[0].pricing_option_id',
            details: { available: ['po_ok'] },
          },
        ],
      },
    };
    const request = { packages: [{ pricing_option_id: 'po_bad' }] };
    const context = { pricing_option_id: 'po_bad' };
    const prov = provenance({
      pricing_option_id: { source_step_id: 's', source_kind: 'convention' },
    });
    const hints = detectContextRejectionHints(taskResult, request, context, prov);
    assert.equal(hints.length, 1);
  });

  test('composes end-to-end with context writers (issue #870 flow)', () => {
    // Simulate the runner's cross-step wiring: step A succeeds with a
    // context_outputs extraction; step B sends a request carrying the
    // extracted value and the seller rejects it with an `available:` list.
    // Proves the three modules compose correctly — the exact integration
    // point that an implementation-only bug in the runner could miss.

    // Step A: search_by_spec → get_signals response
    const stepAData = {
      signals: [
        {
          signal_agent_segment_id: 'sig_prism_abandoner',
          pricing_options: [{ pricing_option_id: 'po_prism_abandoner_cpm' }],
        },
      ],
    };
    const stepAOutputs = [
      { key: 'first_signal_id', path: 'signals[0].signal_agent_segment_id' },
      { key: 'first_signal_pricing_option_id', path: 'signals[0].pricing_options[0].pricing_option_id' },
    ];
    const { values: aValues, provenance: aProv } = applyContextOutputsWithProvenance(
      stepAData,
      stepAOutputs,
      'search_by_spec',
      'get_signals'
    );

    // Accumulate into the runner's per-run maps.
    const accContext = { ...aValues };
    const accProvenance = new Map(Object.entries(aProv));

    // Step B: activate_signal → seller says catalog has po_prism_cart_cpm.
    const stepBRequest = {
      signal_agent_segment_id: accContext.first_signal_id,
      pricing_option_id: accContext.first_signal_pricing_option_id,
    };
    const stepBTaskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRICING_MODEL',
            message: 'Pricing option not found: po_prism_abandoner_cpm',
            details: {
              field: 'pricing_option_id',
              available: ['po_prism_cart_cpm'],
            },
          },
        ],
      },
    };

    const hints = detectContextRejectionHints(stepBTaskResult, stepBRequest, accContext, accProvenance);

    assert.equal(hints.length, 1);
    assert.equal(hints[0].context_key, 'first_signal_pricing_option_id');
    assert.equal(hints[0].source_step_id, 'search_by_spec');
    assert.equal(hints[0].source_kind, 'context_outputs');
    assert.equal(hints[0].response_path, 'signals[0].pricing_options[0].pricing_option_id');
    assert.equal(hints[0].rejected_value, 'po_prism_abandoner_cpm');
    assert.equal(hints[0].request_field, 'pricing_option_id');
    assert.deepEqual(hints[0].accepted_values, ['po_prism_cart_cpm']);
  });

  test('composes with convention extractor (extractContextWithProvenance)', () => {
    // Step A: get_products writes product_id via CONTEXT_EXTRACTORS (convention).
    const { values, provenance } = extractContextWithProvenance(
      'get_products',
      { products: [{ product_id: 'prd_1' }] },
      'discover_products'
    );
    const accContext = { ...values };
    const accProvenance = new Map(Object.entries(provenance));

    // Step B: create_media_buy request uses product_id, seller rejects it.
    const stepBRequest = { packages: [{ product_id: 'prd_1' }] };
    const stepBTaskResult = {
      success: false,
      data: {
        errors: [
          {
            code: 'INVALID_PRODUCT',
            message: 'product not found',
            field: 'packages[0].product_id',
            details: { available: ['prd_other'] },
          },
        ],
      },
    };

    const hints = detectContextRejectionHints(stepBTaskResult, stepBRequest, accContext, accProvenance);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].context_key, 'product_id');
    assert.equal(hints[0].source_step_id, 'discover_products');
    assert.equal(hints[0].source_kind, 'convention');
    assert.equal(hints[0].source_task, 'get_products');
    assert.match(hints[0].message, /convention extractor for `get_products`/);
  });

  test('empty provenance map yields no hints (provenance gate, not value absence)', () => {
    // With the request carrying `a: "c"` and the error rejecting "c",
    // the only thing holding the hint back is the empty provenance map —
    // confirm by running the same shape with a provenance entry and
    // asserting a hint fires.
    const taskResult = {
      success: false,
      data: {
        errors: [{ code: 'X', message: 'x', field: 'a', details: { available: ['b'] } }],
      },
    };
    const request = { a: 'c' };
    const context = { a: 'c' };
    assert.deepEqual(detectContextRejectionHints(taskResult, request, context, new Map()), []);
    const populated = detectContextRejectionHints(
      taskResult,
      request,
      context,
      provenance({ a: { source_step_id: 's', source_kind: 'convention' } })
    );
    assert.equal(populated.length, 1);
  });
});
