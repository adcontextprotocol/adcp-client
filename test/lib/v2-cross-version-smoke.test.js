// Cross-version smoke test — exercises the end-to-end shape a buyer
// sees when talking to a v1 seller versus a v2 seller, with the V2-
// augmentation helper layered on top.
//
// Two scenarios, mocked at the response-shape level (no transport
// involved — the projection layer is pure):
//
//   1. v1 seller — response carries `format_ids[]` only. Buyer calls
//      `withFormatOptions(response)` and reads `format_options[]`
//      transparently.
//
//   2. v2 seller — response carries `format_options[]` directly. Buyer
//      calls `withFormatOptions(response)` (idempotent) and reads the
//      same shape.
//
// In both cases, the assertions a v2-aware storyboard step would make
// (`products[0].format_options[0].format_kind` exists,
// `products[0].format_ids[0].agent_url` exists when emitted) pass.
//
// This is the SDK-level proof that the 7.10 V2 mental model is wire-
// agnostic. Full storyboard-runner cross-version wiring (changing
// `--adcp-version` and re-running) lands at 8.0 alongside the V2-by-
// default narrowing.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { withFormatOptions } = require('../../dist/lib/v2/projection/index.js');
const { betaProjectionSkipReason } = require('./helpers/optional-3-1-beta.js');

describe(
  'cross-version smoke — buyer sees V2 shape regardless of seller wire version',
  { skip: betaProjectionSkipReason() },
  () => {
    test('v1 seller (format_ids only) — buyer reads format_options after augmentation', () => {
      // Simulates the wire shape a 3.0.x seller would emit.
      const v1WireResponse = {
        products: [
          {
            product_id: 'iab_mrec_inventory',
            name: 'IAB MREC',
            description: 'standard 300x250 banner inventory',
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
            pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
          },
        ],
      };

      const { response, diagnostics } = withFormatOptions(v1WireResponse);

      // V2 view: format_options carries the canonical declaration.
      assert.strictEqual(response.products[0].format_options.length, 1);
      assert.strictEqual(response.products[0].format_options[0].format_kind, 'image');

      // V1 view (still works — buyers on 7.x code keep reading format_ids).
      assert.strictEqual(response.products[0].format_ids.length, 1);
      assert.strictEqual(response.products[0].format_ids[0].id, 'display_300x250_image');

      // No projection diagnostics (catalog has this format).
      assert.strictEqual(diagnostics.length, 0);

      // Non-projection fields preserved verbatim.
      assert.strictEqual(response.products[0].pricing_options[0].fixed_price, 5);
    });

    test('v2 seller (format_options only) — buyer reads same V2 shape; no double projection', () => {
      // Simulates the wire shape a 3.1+ seller emits when V2-native.
      const v2WireResponse = {
        products: [
          {
            product_id: 'native_v2_product',
            name: 'V2 native',
            description: 'declared at v2',
            format_ids: [],
            format_options: [
              {
                format_kind: 'image',
                params: { width: 300, height: 250 },
                v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
              },
            ],
          },
        ],
      };

      const { response, diagnostics } = withFormatOptions(v2WireResponse);

      // V2 shape unchanged.
      assert.strictEqual(response.products[0].format_options[0].format_kind, 'image');
      // Same reference (idempotent).
      assert.strictEqual(response.products[0], v2WireResponse.products[0]);
      assert.strictEqual(diagnostics.length, 0);
    });

    test('mixed seller (some products v1-shaped, some v2-shaped) — augmentation per-product', () => {
      // A seller mid-migration emits some products with format_options and
      // some with only format_ids. The helper runs per-product and the
      // buyer reads a uniform V2 view.
      const mixedResponse = {
        products: [
          {
            product_id: 'legacy_v1',
            name: 'legacy',
            description: '',
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          },
          {
            product_id: 'native_v2',
            name: 'native',
            description: '',
            format_ids: [],
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
          },
        ],
      };

      const { response, diagnostics } = withFormatOptions(mixedResponse);

      assert.strictEqual(response.products.length, 2);
      // Both products have format_options after augmentation.
      assert.strictEqual(response.products[0].format_options[0].format_kind, 'image');
      assert.strictEqual(response.products[1].format_options[0].format_kind, 'video_hosted');
      assert.strictEqual(diagnostics.length, 0);
    });

    test('format-projection-failed surfaces a structured diagnostic with the failing product_id', () => {
      // A seller emits a format_id we can't project (publisher-bespoke +
      // not in any catalog). The augmentation surfaces this via the
      // structured diagnostic stream so the buyer SDK can show it on
      // the response envelope's errors[] array — same shape upstream
      // assertions would consume.
      const partial = {
        products: [
          {
            product_id: 'mystery',
            name: 'm',
            description: 'd',
            format_ids: [{ agent_url: 'https://obscure.example/', id: 'format_we_dont_know' }],
          },
        ],
      };
      const { response, diagnostics } = withFormatOptions(partial);

      assert.strictEqual(response.products[0].format_options.length, 0, 'no projection for unknown format');
      assert.strictEqual(diagnostics.length, 1);
      const d = diagnostics[0];
      assert.strictEqual(d.source, 'sdk', 'spec-mandated source marker');
      assert.strictEqual(d.code, 'FORMAT_PROJECTION_FAILED');
      assert.ok(d.field.includes('mystery'), 'diagnostic field points at the offending product_id');
      assert.match(d.sdk_id, /^@adcp\/sdk@\d+\.\d+\.\d+/);
    });
  }
);
