// Tests for the warn-only post-adapter validation pass.
// After SingleAgentClient calls adaptRequestForServerVersion, when targeting
// a v2 server, the SDK validates the adapted shape against the cached v2.5
// schema bundle. Warn-only — never throws, surfaces drift via debugLogs.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validateRequest } = require('../../dist/lib/validation');
const { validateOutgoingRequest } = require('../../dist/lib/validation/client-hooks.js');
const { hasSchemaBundle } = require('../../dist/lib/validation/schema-loader.js');

// Fresh clones that haven't run `npm run sync-schemas:v2.5` won't have the
// bundle. CI runs `sync-schemas:all` so it's present there. Locally, skip
// with a clear message rather than fail with confusing AJV errors.
const V2_5_AVAILABLE = hasSchemaBundle('v2.5');

describe(
  'post-adapter v2.5 validation',
  { skip: V2_5_AVAILABLE ? false : 'v2.5 bundle not cached — run `npm run sync-schemas:v2.5`' },
  () => {
    test('v2.5 schema bundle is loadable and a clean adapted get_products payload validates', () => {
      // The shape adaptGetProductsRequestForV2 emits — minimum: brief.
      // (account/brand/buying_mode get stripped by the v2 adapter.)
      const outcome = validateRequest(
        'get_products',
        {
          brief: 'Premium ad placements',
        },
        'v2.5'
      );
      assert.strictEqual(outcome.valid, true, `expected valid; got: ${JSON.stringify(outcome.issues)}`);
    });

    test('warn-only mode never throws and writes drift to debugLogs', () => {
      // Construct a v2.5-invalid create_media_buy payload (missing required
      // buyer_ref). Confirm validateOutgoingRequest with mode='warn' returns
      // an outcome AND appends a warning entry to the debugLogs array.
      const debugLogs = [];
      let threw = false;
      try {
        validateOutgoingRequest(
          'create_media_buy',
          {
            packages: [{ product_id: 'prod-1', budget: 1000, pricing_option_id: 'po-1' }],
            start_time: 'asap',
            end_time: '2027-12-31T23:59:59Z',
            idempotency_key: '11111111-1111-1111-1111-111111111111',
          },
          'warn',
          debugLogs,
          'v2.5'
        );
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, false, 'warn-only mode must never throw');
      assert.ok(debugLogs.length > 0, 'expected at least one debug log entry');
      const warning = debugLogs.find(e => e.type === 'warning');
      assert.ok(warning, `expected a warning entry; got: ${JSON.stringify(debugLogs)}`);
      assert.match(warning.message, /create_media_buy/);
      assert.ok(Array.isArray(warning.issues) && warning.issues.length > 0);
    });

    test('warn-only mode is silent when payload validates clean', () => {
      const debugLogs = [];
      validateOutgoingRequest('get_products', { brief: 'test' }, 'warn', debugLogs, 'v2.5');
      assert.strictEqual(debugLogs.length, 0, `clean payload should not log; got: ${JSON.stringify(debugLogs)}`);
    });

    test('omitted debugLogs does not throw when validation fails', () => {
      // Defensive: SingleAgentClient call sites pass no debugLogs today.
      // The warn path must tolerate that without crashing.
      let threw = false;
      try {
        validateOutgoingRequest(
          'create_media_buy',
          { packages: [], start_time: 'asap', end_time: '2027-12-31T23:59:59Z' },
          'warn',
          undefined,
          'v2.5'
        );
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, false, 'warn mode without debugLogs must not throw');
    });

    test('TaskExecutor.validateAdaptedRequestAgainstV2 is warn-only and version-pinned to v2.5', () => {
      // Reach into the built executor module and confirm the public seam
      // doesn't throw on v2.5-invalid input. The whole point is that adapter
      // bugs surface as drift signal, not as user-request failures.
      const { AdCPClient } = require('../../dist/lib/index.js');
      const mockAgent = { id: 'test-agent', name: 'Test', agent_uri: 'https://test.example', protocol: 'a2a' };
      const client = new AdCPClient([mockAgent]);
      const inner = client.agent(mockAgent.id).client;
      const executor = inner.executor;
      assert.ok(typeof executor.validateAdaptedRequestAgainstV2 === 'function', 'public seam must exist');

      // Known-invalid v2.5 shape (missing buyer_ref). Must not throw.
      let threw = false;
      try {
        executor.validateAdaptedRequestAgainstV2('create_media_buy', {
          packages: [],
          start_time: 'asap',
          end_time: '2027-12-31T23:59:59Z',
        });
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, false, 'validateAdaptedRequestAgainstV2 must never throw');
    });
  }
);
