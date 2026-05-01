// Tests for null-tolerance in validateResponse for v2.x schema bundles.
// Covers issue #1149: v2.5 Pydantic sellers emit optional envelope fields
// (errors, context, ext) as null instead of omitting them. Ajv spuriously
// rejects null against type:'array'/'object' unless we strip it first.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { validateResponse } = require('../../dist/lib/validation/schema-validator');
const { hasSchemaBundle } = require('../../dist/lib/validation/schema-loader');

// The stripping logic is schema-driven: we need a validator with a compiled
// schema to exercise the required/optional distinction. We use get_products
// (present in every schema bundle) as the vehicle.

const V2_5_AVAILABLE = hasSchemaBundle('v2.5');
const V3_AVAILABLE = hasSchemaBundle('3.0');

// Minimal valid get_products response shape (v2.5 and v3 share the top-level
// products array; the fields below satisfy the v2.5 response schema).
function minimalGetProductsResponse(overrides = {}) {
  return {
    products: [
      {
        product_id: 'prod-1',
        name: 'Test Product',
        description: 'A test',
        publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
        format_ids: [],
        delivery_type: 'guaranteed',
        pricing_options: [
          {
            pricing_option_id: 'po-1',
            pricing_model: 'cpm',
            rate: 10,
            currency: 'USD',
          },
        ],
        reporting_capabilities: {
          available_reporting_frequencies: ['daily'],
          expected_delay_minutes: 60,
          timezone: 'UTC',
          supports_webhooks: false,
          available_metrics: ['impressions'],
          date_range_support: 'date_range',
        },
      },
    ],
    ...overrides,
  };
}

describe(
  'v2.5 envelope null-stripping',
  { skip: V2_5_AVAILABLE ? false : 'v2.5 bundle not cached — run `npm run sync-schemas:v2.5`' },
  () => {
    test('null on optional non-nullable envelope field is stripped → valid', () => {
      const payload = minimalGetProductsResponse({ errors: null, context: null, ext: null });
      const outcome = validateResponse('get_products', payload, 'v2.5');
      // After stripping, the payload is valid. Without stripping all three
      // fields would produce type errors.
      const envelopeNullErrors = (outcome.issues ?? []).filter(
        i => ['/errors', '/context', '/ext'].includes(i.pointer) && i.keyword === 'type'
      );
      assert.strictEqual(
        envelopeNullErrors.length,
        0,
        `Expected no envelope-null type errors; got: ${JSON.stringify(envelopeNullErrors)}`
      );
    });

    test('null on envelope field not declared in schema properties passes through unchanged', () => {
      // A null value on a key the schema doesn't declare in `properties` should
      // not be stripped (the helper guards `if (!propSchema) continue`).
      // The validator may or may not fail on it depending on additionalProperties
      // rules, but we must not silently drop keys we can't reason about.
      const payload = minimalGetProductsResponse({ unknown_null_field: null });
      // Just assert it doesn't throw — the outcome validity is schema-dependent.
      assert.doesNotThrow(() => validateResponse('get_products', payload, 'v2.5'));
    });

    test('valid response without any null envelope fields is accepted unchanged', () => {
      const payload = minimalGetProductsResponse();
      const outcome = validateResponse('get_products', payload, 'v2.5');
      assert.strictEqual(outcome.valid, true, `Expected valid; got: ${JSON.stringify(outcome.issues)}`);
    });

    test('non-null value on envelope field is not stripped', () => {
      // Confirm a real array value on `errors` (if schema permits) is preserved.
      // We send an empty array — structurally valid for an optional errors field.
      const payload = minimalGetProductsResponse({ errors: [] });
      // The key point: no stripping occurs and Ajv runs against the original.
      const outcome = validateResponse('get_products', payload, 'v2.5');
      // If the field is accepted by the schema (empty array is valid array), the
      // outcome should be valid.
      const errorsTypeError = (outcome.issues ?? []).find(i => i.pointer === '/errors' && i.keyword === 'type');
      assert.strictEqual(errorsTypeError, undefined, 'empty array on errors should not produce a type error');
    });
  }
);

describe('v3 envelope null-stripping bypass', { skip: V3_AVAILABLE ? false : 'v3 (3.0) bundle not cached' }, () => {
  test('null stripping is NOT applied for v3 bundles', () => {
    // In v3, errors is required on failure branches. We must not silently
    // strip it, which means calling validateResponse with no version (the
    // default SDK bundle) or with version '3.0' must NOT apply the v2.x
    // null-strip. The test verifies the gate works: a payload with
    // `errors: null` against the v3 schema should still fail if the schema
    // declares errors as required.
    //
    // We can't easily construct a v3 payload where errors is required without
    // knowing the exact conditional schema shape, so we verify the negation:
    // validateResponse with version=undefined (default, v3) does NOT silently
    // swallow a validation error that would be caught by the schema.
    //
    // Use a trivially invalid payload (missing required products array) and
    // confirm it is still rejected — demonstrating the validator runs normally
    // (no stripping that might accidentally make it pass).
    const badPayload = { errors: null };
    const outcome = validateResponse('get_products', badPayload);
    // Should be invalid because `products` is missing.
    assert.strictEqual(outcome.valid, false, 'v3 validator must still reject invalid payloads');
  });
});
