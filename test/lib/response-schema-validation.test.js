/**
 * Tests for validateResponseSchema utility
 *
 * Validates that response schema validation catches:
 * - Missing required fields (#371)
 * - Invalid enum values (#372)
 * - Correct parameter usage (#373)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateResponseSchema } = require('../../dist/lib/testing/client');
const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas');

// --- Fixtures ---

const validProduct = {
  product_id: 'p1',
  name: 'Test Product',
  description: 'A test product',
  publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
  format_ids: [{ agent_url: 'https://example.com', id: 'fmt1' }],
  delivery_type: 'guaranteed',
  pricing_options: [{ pricing_option_id: 'po1', pricing_model: 'cpm', rate: 10, currency: 'USD' }],
  reporting_capabilities: {
    available_reporting_frequencies: ['daily'],
    expected_delay_minutes: 60,
    timezone: 'UTC',
    supports_webhooks: false,
    available_metrics: ['impressions'],
    date_range_support: 'date_range',
  },
};

const validCreateMediaBuySuccess = {
  media_buy_id: 'mb1',
  buyer_ref: 'ref-123',
  confirmed_at: '2026-01-15T10:00:00Z',
  revision: 1,
  valid_actions: ['pause', 'cancel', 'update_budget'],
  packages: [{ package_id: 'pkg1' }],
};

const validMediaBuy = {
  media_buy_id: 'mb1',
  status: 'active',
  currency: 'USD',
  total_budget: 1000,
  packages: [{ package_id: 'pkg1' }],
};

const validDeployment = {
  type: 'platform',
  platform: 'dv360',
  is_live: false,
};

const validSignalPricingOption = {
  pricing_option_id: 'spo1',
  model: 'cpm',
  cpm: 2.5,
  currency: 'USD',
};

const validSignal = {
  signal_id: { source: 'agent', agent_url: 'https://signals.example.com', id: 'sig-001' },
  signal_agent_segment_id: 'seg-001',
  name: 'Tech Enthusiasts',
  description: 'Users interested in technology',
  signal_type: 'marketplace',
  data_provider: 'Test Provider',
  coverage_percentage: 15.5,
  deployments: [validDeployment],
  pricing_options: [validSignalPricingOption],
};

// --- Tests ---

describe('validateResponseSchema', () => {
  // ---- get_products (#371) ----
  describe('get_products — required fields (#371)', () => {
    it('passes for valid response', () => {
      const result = validateResponseSchema('get_products', { products: [validProduct], cache_scope: 'public' });
      assert.strictEqual(result.passed, true);
    });

    it('passes for empty products array', () => {
      const result = validateResponseSchema('get_products', { products: [], cache_scope: 'public' });
      assert.strictEqual(result.passed, true);
    });

    it('fails when cache_scope is missing on a products response', () => {
      const result = validateResponseSchema('get_products', { products: [] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('cache_scope'), `Expected cache_scope error, got: ${result.error}`);
    });

    it('passes when cache_scope is missing on a server-declared 3.0 products response', () => {
      const result = validateResponseSchema('get_products', { products: [] }, '3.0');
      assert.strictEqual(result.passed, true);
    });

    it('passes for unchanged wholesale-feed responses without products', () => {
      const result = validateResponseSchema('get_products', {
        unchanged: true,
        wholesale_feed_version: 'wf_v1',
        cache_scope: 'public',
      });
      assert.strictEqual(result.passed, true);
    });

    it('fails when cache_scope is missing on an unchanged wholesale-feed response', () => {
      const result = validateResponseSchema('get_products', {
        unchanged: true,
        wholesale_feed_version: 'wf_v1',
      });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('cache_scope'), `Expected cache_scope error, got: ${result.error}`);
    });

    it('fails when product_id is missing', () => {
      const { product_id, ...without } = validProduct;
      const result = validateResponseSchema('get_products', { products: [without], cache_scope: 'public' });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('product_id'), `Expected product_id error, got: ${result.error}`);
    });

    it('fails when name is missing', () => {
      const { name, ...without } = validProduct;
      const result = validateResponseSchema('get_products', { products: [without], cache_scope: 'public' });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('name'), `Expected name error, got: ${result.error}`);
    });

    // 3.1.0-beta.3 made `products` OPTIONAL on the get_products response
    // envelope: a wholesale-feed unchanged response legitimately omits
    // products (while still requiring cache_scope), and an error
    // response carries `errors[]` instead of `products[]`. The "absent
    // products is a failure" assertion no longer matches the spec.
    // Constraint coverage when products IS provided remains in the
    // type-shape and item-content tests above and below.

    it('fails when products is null', () => {
      const result = validateResponseSchema('get_products', { products: null });
      assert.strictEqual(result.passed, false);
    });

    it('fails when products is not an array', () => {
      const result = validateResponseSchema('get_products', { products: 'not-an-array' });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- create_media_buy (#371) ----
  describe('create_media_buy — required fields (#371)', () => {
    it('passes for valid success response', () => {
      const result = validateResponseSchema('create_media_buy', validCreateMediaBuySuccess);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails when media_buy_id is missing', () => {
      const { media_buy_id, ...without } = validCreateMediaBuySuccess;
      const result = validateResponseSchema('create_media_buy', without);
      assert.strictEqual(result.passed, false);
    });

    it('passes when buyer_ref is missing (no longer required)', () => {
      const { buyer_ref, ...without } = validCreateMediaBuySuccess;
      const result = validateResponseSchema('create_media_buy', without);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('create_media_buy', {
        errors: [{ code: 'validation_error', message: 'Bad request' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails for error response with incomplete error object', () => {
      const result = validateResponseSchema('create_media_buy', {
        errors: [{ message: 'Missing code field' }],
      });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- get_media_buys (#372) ----
  describe('get_media_buys — required fields and enum validation (#371, #372)', () => {
    it('passes for valid status enum values', () => {
      for (const status of ['pending_start', 'active', 'paused', 'completed', 'rejected', 'canceled']) {
        const data = { media_buys: [{ ...validMediaBuy, status }] };
        const result = validateResponseSchema('get_media_buys', data);
        assert.strictEqual(result.passed, true, `Expected pass for status "${status}": ${result.error || ''}`);
      }
    });

    it('fails for invalid status enum value', () => {
      const data = { media_buys: [{ ...validMediaBuy, status: 'totally_bogus_status' }] };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('status'), `Expected status error, got: ${result.error}`);
    });

    it('fails when currency is missing', () => {
      const { currency, ...without } = validMediaBuy;
      const result = validateResponseSchema('get_media_buys', { media_buys: [without] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('currency'), `Expected currency error, got: ${result.error}`);
    });

    it('fails when packages is missing', () => {
      const { packages, ...without } = validMediaBuy;
      const result = validateResponseSchema('get_media_buys', { media_buys: [without] });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- get_media_buys lifecycle fields ----
  describe('get_media_buys — lifecycle fields', () => {
    it('passes with lifecycle fields (confirmed_at, revision, valid_actions)', () => {
      const data = {
        media_buys: [
          {
            ...validMediaBuy,
            confirmed_at: '2026-01-15T10:00:00Z',
            revision: 3,
            valid_actions: ['pause', 'cancel', 'update_budget'],
          },
        ],
      };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes with canceled media buy fields', () => {
      const data = {
        media_buys: [
          {
            ...validMediaBuy,
            status: 'canceled',
            canceled_at: '2026-01-20T14:30:00Z',
            canceled_by: 'buyer',
            cancellation_reason: 'Campaign strategy changed',
            revision: 5,
            valid_actions: [],
          },
        ],
      };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes with package cancellation fields', () => {
      const data = {
        media_buys: [
          {
            ...validMediaBuy,
            packages: [
              {
                package_id: 'pkg1',
                canceled: true,
                canceled_at: '2026-01-20T14:30:00Z',
                canceled_by: 'seller',
                cancellation_reason: 'Policy violation',
                creative_deadline: '2026-02-01T23:59:59Z',
              },
            ],
          },
        ],
      };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes with history entries', () => {
      const data = {
        media_buys: [
          {
            ...validMediaBuy,
            revision: 3,
            history: [
              { revision: 3, timestamp: '2026-01-18T12:00:00Z', action: 'resumed', actor: 'buyer-agent' },
              { revision: 2, timestamp: '2026-01-17T10:00:00Z', action: 'paused' },
              { revision: 1, timestamp: '2026-01-15T10:00:00Z', action: 'created', summary: 'Created with 2 packages' },
            ],
          },
        ],
      };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });
  });

  // ---- get_signals (#371, #372) ----
  describe('get_signals — required fields and enum validation', () => {
    it('passes for valid response', () => {
      const result = validateResponseSchema('get_signals', { signals: [validSignal] });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for empty signals array', () => {
      const result = validateResponseSchema('get_signals', { signals: [] });
      assert.strictEqual(result.passed, true);
    });

    it('fails when signal_agent_segment_id is missing', () => {
      const { signal_agent_segment_id, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
      assert.ok(
        result.error.includes('signal_agent_segment_id'),
        `Expected signal_agent_segment_id error, got: ${result.error}`
      );
    });

    it('fails when signal_type is missing', () => {
      const { signal_type, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
    });

    it('fails for invalid signal_type enum value', () => {
      const result = validateResponseSchema('get_signals', {
        signals: [{ ...validSignal, signal_type: 'bogus_type' }],
      });
      assert.strictEqual(result.passed, false);
    });

    it('passes for all valid signal_type enum values', () => {
      for (const signal_type of ['marketplace', 'custom', 'owned']) {
        const result = validateResponseSchema('get_signals', {
          signals: [{ ...validSignal, signal_type }],
        });
        assert.strictEqual(
          result.passed,
          true,
          `Expected pass for signal_type "${signal_type}": ${result.error || ''}`
        );
      }
    });

    it('passes when data_provider is missing (optional display field)', () => {
      const { data_provider, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails when deployments is missing', () => {
      const { deployments, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- activate_signal ----
  describe('activate_signal — required fields', () => {
    it('passes for valid success response', () => {
      const result = validateResponseSchema('activate_signal', {
        deployments: [validDeployment],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('activate_signal', {
        errors: [{ code: 'invalid_signal', message: 'Signal not found' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails when deployments has invalid structure', () => {
      const result = validateResponseSchema('activate_signal', {
        deployments: [{ type: 'platform' }],
      });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- sync_audiences ----
  describe('sync_audiences — match breakdown and effective_match_rate', () => {
    const validAudienceResult = {
      audience_id: 'existing_customers',
      action: 'updated',
      status: 'ready',
      uploaded_count: 5000,
      matched_count: 18750,
    };

    it('passes for valid response without match breakdown', () => {
      const result = validateResponseSchema('sync_audiences', {
        audiences: [validAudienceResult],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for response with effective_match_rate and match_breakdown', () => {
      const result = validateResponseSchema('sync_audiences', {
        audiences: [
          {
            ...validAudienceResult,
            effective_match_rate: 0.75,
            match_breakdown: [
              { id_type: 'hashed_email', submitted: 25000, matched: 17500, match_rate: 0.7 },
              { id_type: 'hashed_phone', submitted: 15000, matched: 12000, match_rate: 0.8 },
              { id_type: 'rampid', submitted: 8000, matched: 7200, match_rate: 0.9 },
            ],
          },
        ],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('sync_audiences', {
        errors: [{ code: 'validation_error', message: 'Invalid audience data' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for audience with failed action', () => {
      const result = validateResponseSchema('sync_audiences', {
        audiences: [
          {
            audience_id: 'bad_audience',
            action: 'failed',
            errors: [{ code: 'invalid_format', message: 'Bad hash' }],
          },
        ],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });
  });

  // ---- get_signals with governance metadata ----
  describe('get_signals — governance metadata on signal definitions', () => {
    it('passes for signal with restricted_attributes and policy_categories', () => {
      const result = validateResponseSchema('get_signals', {
        signals: [
          {
            ...validSignal,
            restricted_attributes: ['health_data'],
            policy_categories: ['pharmaceutical_advertising'],
          },
        ],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });
  });

  // ---- Schema registry completeness ----
  describe('schema registry', () => {
    it('has schemas for all tools used in compliance scenarios', () => {
      const scenarioTools = [
        'get_products',
        'create_media_buy',
        'get_media_buys',
        'list_creative_formats',
        'get_signals',
        'activate_signal',
        'sync_audiences',
      ];
      for (const tool of scenarioTools) {
        assert.ok(TOOL_RESPONSE_SCHEMAS[tool], `Missing schema for scenario tool: ${tool}`);
      }
    });
  });

  // ---- Unknown tool ----
  describe('unknown tool', () => {
    it('passes with warning for unregistered tool', () => {
      const result = validateResponseSchema('unknown_tool', {});
      assert.strictEqual(result.passed, true);
      assert.ok(result.details.includes('No response schema'));
      assert.ok(result.warnings?.length > 0, 'Expected a warning for unregistered tool');
      assert.ok(result.warnings[0].includes('unknown_tool'));
    });
  });

  // ---- Constraint vs missing classification (#1736 / adcp#3025) ----
  describe('constraint violations vs missing required fields (#1736)', () => {
    it('classifies an invalid enum value as a constraint violation, not a missing field', () => {
      // `status` violates the enum constraint — the field is present but
      // the value is rejected. This is a *constraint* failure, not a
      // *missing field* failure; remediation differs (fix the value vs.
      // add the field).
      const result = validateResponseSchema('get_media_buys', {
        media_buys: [
          {
            media_buy_id: 'mb1',
            status: 'totally_bogus_status',
            currency: 'USD',
            total_budget: 1000,
            packages: [{ package_id: 'pkg1' }],
          },
        ],
      });
      assert.strictEqual(result.passed, false);
      assert.ok(
        result.error.includes('constraint violations'),
        `Expected constraint violations header, got: ${result.error}`
      );
      assert.ok(
        result.error.includes('/media_buys/0/status'),
        `Expected JSON Pointer /media_buys/0/status, got: ${result.error}`
      );
      assert.ok(
        !result.error.includes('missing required fields'),
        `Invalid-enum must not be reported as missing, got: ${result.error}`
      );
    });

    // Skipped: 3.1.0-beta.3 changed CreateMediaBuyResponseSchema from a bare
    // `z.union([variant1, variant2, variant3])` to
    // `z.object({...envelope...}).passthrough().and(z.union([...]))` so
    // envelope fields (status, context_id, …) sit above the variant union.
    // That puts a `ZodIntersection` at the top, which means union-error
    // disambiguation (`getBestUnionErrors` walks `schema._def.options`)
    // can't reach the variants from the root schema — so the validator
    // classifies the failure as a single root `oneOf` constraint instead
    // of the variant-specific missing-field report this test expects.
    // The "test to the spec" verdict here is that the SDK should still
    // surface the missing field; restoring it requires teaching
    // `getBestUnionErrors` to descend into intersections, which is a
    // source-side change outside this test-fixture catch-up. Tracked
    // alongside the other "union schema error reporting" skips below.
    it('classifies an absent required field as missing, with JSON Pointer', () => {
      const { media_buy_id, ...without } = validCreateMediaBuySuccess;
      const result = validateResponseSchema('create_media_buy', without);
      assert.strictEqual(result.passed, false);
      assert.ok(
        result.error.includes('missing required fields'),
        `Expected missing required fields header, got: ${result.error}`
      );
      assert.ok(result.error.includes('/media_buy_id'), `Expected JSON Pointer /media_buy_id, got: ${result.error}`);
      assert.ok(
        !result.error.includes('constraint violations'),
        `Absent field must not be reported as constraint, got: ${result.error}`
      );
    });

    it('emits both groups when a response has missing AND constraint violations', () => {
      // Missing required `currency`, plus invalid enum value on `status`.
      const result = validateResponseSchema('get_media_buys', {
        media_buys: [
          {
            media_buy_id: 'mb1',
            status: 'totally_bogus_status',
            total_budget: 1000,
            packages: [{ package_id: 'pkg1' }],
          },
        ],
      });
      assert.strictEqual(result.passed, false);
      assert.ok(
        result.error.includes('missing required fields'),
        `Expected missing-fields group, got: ${result.error}`
      );
      assert.ok(
        result.error.includes('/media_buys/0/currency'),
        `Expected currency in missing group, got: ${result.error}`
      );
      assert.ok(result.error.includes('constraint violations'), `Expected constraint group, got: ${result.error}`);
    });

    it('AJV strict validator classifies revision: 0 as keyword=minimum, not missing', async () => {
      // The Zod-generated schema in `TOOL_RESPONSE_SCHEMAS` does not carry
      // `minimum` constraints (Zod codegen drops them today), so the
      // schema-level `minimum: 1` violation for `revision: 0` is caught by
      // the AJV strict validator in the storyboard pipeline. This test
      // pins the structured output that downstream evaluators classify on.
      const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
      const payload = {
        media_buy_id: 'mb1',
        packages: [{ package_id: 'pkg1' }],
        revision: 0,
      };
      const outcome = validateResponse('create_media_buy', payload);
      assert.strictEqual(outcome.valid, false);
      const minimumIssue = outcome.issues.find(i => i.keyword === 'minimum' && i.pointer === '/revision');
      assert.ok(
        minimumIssue,
        `Expected an issue with keyword='minimum' at /revision, got: ${JSON.stringify(outcome.issues)}`
      );
    });
  });

  // ---- Union schema error messages ----
  // All five tests in this group are skipped pending a source-side fix.
  //
  // Background: 3.1.0-beta.3 reshaped response schemas that previously were a
  // bare `z.union([variant1, variant2, ...])` (CreateMediaBuyResponseSchema,
  // ActivateSignalResponseSchema, BuildCreativeResponseSchema, …) into
  // `z.object({...envelope...}).passthrough().and(z.union([...]))` so the
  // newly-required envelope fields (status, context_id, task_id, adcp_error,
  // …) live above the variant union. That puts a `ZodIntersection` at the
  // top of the schema tree, which means:
  //   - `getBestUnionErrors` can't access the variants via the documented
  //     `schema._def.options` (intersections expose `_def.left`/`_def.right`),
  //     so it returns `null` and the validator falls through to reporting a
  //     single root `oneOf` constraint instead of the variant-specific
  //     missing-field message these tests assert on.
  //   - The "non-union schemas" guard (`get_products` with `{ not_products: true }`)
  //     also flips: 3.1.0-beta.3 made `products` OPTIONAL on the get_products
  //     response (the `unchanged: true` shape legitimately omits products), so the
  //     payload now validates and no missing-field message is produced.
  //   - The Zod-internals canary fails for the same reason — the schema is no
  //     longer a `ZodUnion`, so `_def.options` is intentionally absent.
  //
  // Restoring variant-specific error reporting needs `getBestUnionErrors` to
  // descend into `ZodIntersection` (and `ZodEffects`/`ZodPipeline` while
  // we're there) to find the inner `ZodUnion`. That's a source-side change,
  // outside the scope of the cluster-3 test-fixture catch-up.
  describe('union schema error reporting', () => {
    it('reports specific field errors for create_media_buy instead of (root): Invalid input', () => {
      const result = validateResponseSchema('create_media_buy', {
        packages: [{ package_id: 'pkg1', budget: 1000 }],
      });
      assert.strictEqual(result.passed, false);
      assert.ok(!result.error.includes('(root): Invalid input'), 'Should not show generic union error');
      assert.ok(result.error.includes('media_buy_id'), 'Should mention the missing field');
    });

    it('reports specific field errors for activate_signal union schema', () => {
      const result = validateResponseSchema('activate_signal', { signal_id: 'sig1' });
      assert.strictEqual(result.passed, false);
      assert.ok(!result.error.includes('(root): Invalid input'), 'Should not show generic union error');
      assert.ok(result.error.includes('deployments'), 'Should mention the missing field');
    });

    it('reports specific field errors for build_creative 3-variant union', () => {
      const result = validateResponseSchema('build_creative', { creative_id: 'c1' });
      assert.strictEqual(result.passed, false);
      assert.ok(!result.error.includes('(root): Invalid input'), 'Should not show generic union error');
      assert.ok(result.error.includes('creative_manifest'), 'Should mention a specific missing field');
    });

    it('still reports normal errors for non-union schemas', () => {
      // `get_products` had `products: ZodArray` before 3.1.0-beta.3 reshaped
      // its response shape (products is now optional; cache_scope is required).
      // Use `get_media_buy_delivery` for the "non-union schema with a required
      // field that's missing" case — `currency` is required there and the
      // schema isn't a discriminated union.
      const result = validateResponseSchema('get_media_buy_delivery', { not_real_field: true });
      assert.strictEqual(result.passed, false);
      // Missing one of the required fields is the canonical "normal error";
      // the schema isn't a union arm so we get a direct field-level message
      // rather than going through `getBestUnionErrors`.
      assert.ok(
        result.error.includes('reporting_period') || result.error.includes('media_buy_deliveries'),
        `Should mention a missing required field; got: ${result.error}`
      );
    });

    it('can access union variant options from Zod schema internals', () => {
      // Canary test: if Zod upgrades break the internals our union-error
      // disambiguator walks, this catches it. 3.1.0-beta.3 reshaped several
      // tool-response unions from bare `z.union([...])` to
      // `z.object({...envelope...}).passthrough().and(z.union([...]))`, so the
      // union arm is now reached via `_def.right._def.options` (the
      // production `getBestUnionErrors` helper handles both shapes).
      const schema = TOOL_RESPONSE_SCHEMAS['create_media_buy'];
      const def = schema._def;
      const directOptions = def?.options;
      const rightOptions = def?.right?._def?.options;
      const leftOptions = def?.left?._def?.options;
      const options = directOptions ?? rightOptions ?? leftOptions;
      assert.ok(
        Array.isArray(options),
        'Expected union options on `_def.options` (bare union) or `_def.{left,right}._def.options` (intersection-wrapped union); Zod internals may have changed'
      );
      assert.ok(options.length >= 2, 'create_media_buy should be a union of at least 2 variants');
    });
  });
});
