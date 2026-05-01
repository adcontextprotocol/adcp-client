// Adapter conformance against the v2.5 schema bundle.
//
// Takes a canonical v3 input for each tool that has a v2 adapter, runs it
// through `adaptRequestForServerVersion`, and asserts the adapted shape
// validates against `schemas/cache/v2.5/`. CI signal for "the v2 wire
// adapters produce v2.5-conformant output."
//
// Tools with KNOWN drift get explicit `expected_failures` entries pointing at
// the tracking issue. The test asserts the failure mode matches what was
// surfaced (so a fix that closes the gap surfaces as an unexpected pass and
// prompts the test to be flipped to "must pass"). When the underlying issue
// is closed, the entry is removed and the case becomes a regular passing
// fixture.
//
// Add new fixtures here when adding a v2 adapter. The conformance suite is
// the source of truth for what shape a v2.5 server expects to receive.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validateRequest } = require('../../dist/lib/validation/schema-validator');
const { hasSchemaBundle } = require('../../dist/lib/validation/schema-loader.js');
const { adaptGetProductsRequestForV2 } = require('../../dist/lib/utils/pricing-adapter');
const {
  adaptCreateMediaBuyRequestForV2,
  adaptUpdateMediaBuyRequestForV2,
} = require('../../dist/lib/utils/creative-adapter');
const { adaptSyncCreativesRequestForV2 } = require('../../dist/lib/utils/sync-creatives-adapter');

// Fresh clones that haven't run `npm run sync-schemas:v2.5` won't have the
// bundle. CI runs `sync-schemas:all` so it's present there.
const V2_5_AVAILABLE = hasSchemaBundle('v2.5');

// Canonical v3 inputs per tool. Match the shape a v3 buyer would write
// before any wire adaptation.
const FIXTURES = {
  get_products: {
    adapter: adaptGetProductsRequestForV2,
    v3: {
      buying_mode: 'brief',
      brief: 'Premium ad placements',
      brand: { domain: 'example.com' },
    },
  },
  create_media_buy: {
    adapter: adaptCreateMediaBuyRequestForV2,
    v3: {
      account: { account_id: 'acct-1' },
      brand: { domain: 'example.com' },
      packages: [{ product_id: 'prod-1', budget: 1000, pricing_option_id: 'po-1' }],
      start_time: 'asap',
      end_time: '2027-12-31T23:59:59Z',
      idempotency_key: '11111111-1111-1111-1111-111111111111',
    },
    // Was a known-drift fixture against #1115 until that adapter learned to
    // derive buyer_ref from idempotency_key (top-level + per-package).
  },
  update_media_buy: {
    adapter: adaptUpdateMediaBuyRequestForV2,
    v3: {
      media_buy_id: 'mb-1',
      idempotency_key: '22222222-2222-2222-2222-222222222222',
    },
  },
  sync_creatives: {
    adapter: adaptSyncCreativesRequestForV2,
    v3: {
      account: { account_id: 'acct-1' },
      creatives: [
        {
          creative_id: 'cre-1',
          name: 'Test Creative',
          format_id: { agent_url: 'https://test.example', id: 'format1' },
          assets: {
            video: {
              asset_type: 'video',
              url: 'https://example.com/video.mp4',
              width: 1920,
              height: 1080,
              duration_ms: 30000,
            },
          },
        },
      ],
      idempotency_key: '33333333-3333-3333-3333-333333333333',
    },
    expected_failures: {
      // FOLLOW-UP: #1118's "manifest flatten" claim that v2.5 expects a
      // single-asset payload is contradicted by the v2.5 schema cache —
      // `creative-asset.json` declares `assets` as an object with
      // patternProperties keyed by asset role (i.e., the same role-keyed
      // manifest shape v3 uses). Post-#1118 the adapter emits a flat
      // shape that fails v2.5 validation on every flat field. Either the
      // schema needs updating or the flatten needs reverting; tracking in
      // a follow-up issue. This fixture pins the current failure surface
      // so further drift is loud.
      issue: 'adcontextprotocol/adcp-client#1116',
      pointers: ['/creatives/0/assets/asset_type'],
    },
  },
};

describe(
  'v2 adapter conformance against v2.5 schema bundle',
  { skip: V2_5_AVAILABLE ? false : 'v2.5 bundle not cached — run `npm run sync-schemas:v2.5`' },
  () => {
    for (const [taskName, fixture] of Object.entries(FIXTURES)) {
      if (fixture.expected_failures) {
        test(`${taskName} — KNOWN drift, tracked at ${fixture.expected_failures.issue}`, () => {
          const adapted = fixture.adapter(structuredClone(fixture.v3));
          const outcome = validateRequest(taskName, adapted, 'v2.5');
          assert.strictEqual(
            outcome.valid,
            false,
            `${taskName} unexpectedly passed v2.5 validation. If ${fixture.expected_failures.issue} was fixed, ` +
              `remove the expected_failures entry and let this test enforce conformance.`
          );
          // Pin the specific failure mode so a fix that changes the shape
          // surfaces as an assertion break here (signaling the test should
          // be flipped to a passing fixture).
          const surfacedPointers = new Set(outcome.issues.map(i => i.pointer));
          for (const expected of fixture.expected_failures.pointers) {
            assert.ok(
              surfacedPointers.has(expected),
              `${taskName} did not surface expected drift at ${expected}; surfaced: ${[...surfacedPointers].join(', ')}. ` +
                `If the failure mode changed, update or remove this fixture.`
            );
          }
        });
        continue;
      }
      test(`${taskName} — adapted shape conforms to v2.5`, () => {
        const adapted = fixture.adapter(structuredClone(fixture.v3));
        const outcome = validateRequest(taskName, adapted, 'v2.5');
        assert.strictEqual(
          outcome.valid,
          true,
          `${taskName} adapter output failed v2.5 validation:\n${outcome.issues
            .map(i => `  - ${i.pointer} | ${i.keyword} | ${i.message}`)
            .join('\n')}`
        );
      });
    }

    test('every v2-adapted tool has a fixture in this suite', () => {
      // Authoritative list mirrors `SingleAgentClient.adaptRequestForServerVersion`.
      // If a new adapter lands without a fixture, this test fails so we don't
      // ship an unvalidated v2 wire path.
      const adaptedTools = ['get_products', 'create_media_buy', 'update_media_buy', 'sync_creatives'];
      for (const tool of adaptedTools) {
        assert.ok(FIXTURES[tool], `missing conformance fixture for v2-adapted tool: ${tool}`);
      }
    });
  }
);
