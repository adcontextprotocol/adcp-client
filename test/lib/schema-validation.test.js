// Unit tests for the schema-driven validator (issue #688).
// Exercises the real bundled schemas shipped with the SDK.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  validateRequest,
  validateResponse,
  formatIssues,
  buildValidationError,
  buildAdcpValidationErrorPayload,
  listValidatorKeys,
  resolveValidationModes,
} = require('../../dist/lib/validation');
const { validateOutgoingRequest, validateIncomingResponse } = require('../../dist/lib/validation/client-hooks.js');
const { _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');
const { ValidationError } = require('../../dist/lib/errors');

describe('schema-driven validation', () => {
  describe('validateRequest', () => {
    test('flags missing required fields with a JSON Pointer', () => {
      const outcome = validateRequest('get_products', {});
      assert.strictEqual(outcome.valid, false);
      assert.ok(outcome.issues.length > 0);
      const pointers = outcome.issues.map(i => i.pointer);
      // `buying_mode` is declared required on the get_products request.
      assert.ok(pointers.includes('/buying_mode'), `expected /buying_mode in ${pointers.join(', ')}`);
    });

    test('returns skipped for tools outside the AdCP catalog', () => {
      const outcome = validateRequest('custom_seller_extension', { anything: true });
      assert.strictEqual(outcome.valid, true);
      assert.strictEqual(outcome.variant, 'skipped');
    });

    test('accepts extension fields without error (additionalProperties permissive)', () => {
      const outcome = validateRequest('get_products', {
        brief: 'campaign brief',
        promoted_offering: 'product',
        buying_mode: 'sponsorship',
        // `ext` is a recognized extension hook; unknown vendor namespaces pass.
        ext: { gam: { custom_field: 1 } },
        // A completely unknown top-level extension should also pass.
        unknown_vendor_field: { ok: true },
      });
      // Response may or may not fully validate (other fields may be required);
      // the test is about additionalProperties tolerance, so we only assert
      // that the unknown extensions themselves don't show up in errors.
      for (const issue of outcome.issues) {
        assert.notStrictEqual(issue.pointer, '/unknown_vendor_field');
        assert.ok(!issue.pointer.startsWith('/ext'));
      }
    });
  });

  describe('validateResponse', () => {
    test('selects the submitted variant when status === submitted', () => {
      const outcome = validateResponse('create_media_buy', { status: 'submitted', task_id: 't_1' });
      assert.strictEqual(outcome.valid, true);
      assert.strictEqual(outcome.variant, 'submitted');
    });

    test('selects the working variant when status === working', () => {
      const outcome = validateResponse('create_media_buy', { status: 'working', task_id: 't_2' });
      assert.strictEqual(outcome.valid, true);
      assert.strictEqual(outcome.variant, 'working');
    });

    test('selects the input-required variant', () => {
      const outcome = validateResponse('create_media_buy', {
        status: 'input-required',
        task_id: 't_3',
      });
      assert.strictEqual(outcome.valid, true);
      assert.strictEqual(outcome.variant, 'input-required');
    });

    test('falls back to sync variant when no status field present', () => {
      // Raw partial payload — triggers sync schema errors on missing fields.
      const outcome = validateResponse('create_media_buy', { media_buy_id: 'mb_1' });
      assert.strictEqual(outcome.variant, 'sync');
    });

    test('surfaces schema errors with pointer + keyword + schemaPath', () => {
      const outcome = validateResponse('get_products', { products: 'not-an-array' });
      assert.strictEqual(outcome.valid, false);
      const productsIssue = outcome.issues.find(i => i.pointer === '/products');
      assert.ok(productsIssue, 'expected an issue at /products');
      assert.strictEqual(productsIssue.keyword, 'type');
      assert.ok(productsIssue.schemaPath.length > 0);
    });

    test('accepts envelope fields (replayed, unknown vendor keys) at the response root when bundled schema is additionalProperties:false', () => {
      // create_property_list-response declares additionalProperties:false at root.
      // Envelope fields like `replayed` (per security.mdx) must ride alongside.
      // Body fields (`list`, `auth_token`) are intentionally omitted — AJV runs
      // with allErrors, so required-field issues don't mask the envelope check.
      const outcome = validateResponse('create_property_list', {
        replayed: false,
        unknown_envelope_field: { any: 'value' },
      });
      const rootAdditional = outcome.issues.filter(
        i => i.keyword === 'additionalProperties' && (i.pointer === '' || i.pointer === '/')
      );
      assert.deepStrictEqual(
        rootAdditional,
        [],
        `envelope fields should not trigger additionalProperties at the response root: ${JSON.stringify(rootAdditional)}`
      );
    });

    test('envelope passthrough applies across the property-list family (not just create)', () => {
      // delete_property_list and get_property_list ship the same root-level
      // additionalProperties:false. One tool passing could be schema-specific;
      // a second tool confirms the loader fix is general.
      for (const tool of ['delete_property_list', 'get_property_list']) {
        const outcome = validateResponse(tool, { replayed: false });
        const rootAdditional = outcome.issues.filter(
          i => i.keyword === 'additionalProperties' && (i.pointer === '' || i.pointer === '/')
        );
        assert.deepStrictEqual(
          rootAdditional,
          [],
          `${tool}: envelope passthrough regressed at root: ${JSON.stringify(rootAdditional)}`
        );
      }
    });

    test('nested-body drift is still caught (relaxation does not recurse)', () => {
      // get_property_list-response nests `list: { ... }` with its own
      // additionalProperties:false. Typos inside the body must still fail
      // — envelope passthrough is a root-level concession only.
      const outcome = validateResponse('get_property_list', {
        list: { unknown_nested_field: 'typo' },
      });
      const nestedAdditional = outcome.issues.filter(
        i => i.keyword === 'additionalProperties' && i.pointer.startsWith('/list')
      );
      assert.ok(
        nestedAdditional.length > 0,
        `expected additionalProperties failure inside /list body, got: ${JSON.stringify(outcome.issues)}`
      );
    });
  });

  describe('validateRequest envelope strictness', () => {
    test('request schemas stay strict — unknown top-level fields are rejected', () => {
      // The fix explicitly preserves request strictness so outgoing drift
      // fails at the edge. Regression guard: if relaxResponseRoot ever leaks
      // to requests, this test catches it.
      const outcome = validateRequest('create_property_list', {
        name: 'Test',
        unknown_request_field: { should: 'reject' },
      });
      const additional = outcome.issues.filter(i => i.keyword === 'additionalProperties');
      assert.ok(
        additional.length > 0,
        `request validation should still reject unknown top-level fields: ${JSON.stringify(outcome.issues)}`
      );
    });
  });

  describe('formatIssues', () => {
    test('caps verbose failures and notes how many more there are', () => {
      const issues = [
        { pointer: '/a', message: 'oops', keyword: 'required', schemaPath: '#/required' },
        { pointer: '/b', message: 'oops', keyword: 'required', schemaPath: '#/required' },
        { pointer: '/c', message: 'oops', keyword: 'required', schemaPath: '#/required' },
        { pointer: '/d', message: 'oops', keyword: 'required', schemaPath: '#/required' },
      ];
      const summary = formatIssues(issues, 2);
      assert.ok(summary.includes('/a'));
      assert.ok(summary.includes('/b'));
      assert.ok(summary.includes('(+2 more)'));
    });
  });

  describe('buildValidationError / buildAdcpValidationErrorPayload', () => {
    test('wraps issues into a ValidationError carrying details', () => {
      const issues = [{ pointer: '/foo/bar', message: 'bad', keyword: 'type', schemaPath: '#/properties/foo/bar' }];
      const err = buildValidationError('get_products', 'request', issues);
      assert.ok(err instanceof ValidationError);
      assert.strictEqual(err.code, 'VALIDATION_ERROR');
      assert.strictEqual(err.details.tool, 'get_products');
      assert.strictEqual(err.details.side, 'request');
      assert.deepStrictEqual(err.details.issues, issues);
    });

    test('anyOf rejections also carry variant metadata', async () => {
      // `create_content_standards` has a top-level anyOf: pick policies OR
      // registry_policy_ids. An empty payload matches neither, so we should
      // see an enriched anyOf issue at `/` with both variants.
      const res = validateRequest('create_content_standards', {
        idempotency_key: '00000000-0000-0000-0000-000000000000',
        account: { account_id: 'acme' },
        scope: { kind: 'buyer' },
      });
      assert.strictEqual(res.valid, false);
      const anyOfIssue = res.issues.find(i => i.keyword === 'anyOf');
      assert.ok(anyOfIssue, 'anyOf issue must be present when neither variant matches');
      assert.ok(Array.isArray(anyOfIssue.variants), 'variants must be enriched on anyOf issues');
      assert.strictEqual(anyOfIssue.variants.length, 2);
      const requiredSets = anyOfIssue.variants.map(v => v.required);
      // The variants are symmetric (either policies OR registry_policy_ids) —
      // order not guaranteed, so check both are represented.
      assert.ok(
        requiredSets.some(r => r.includes('policies')),
        `policies variant missing: ${JSON.stringify(requiredSets)}`
      );
      assert.ok(
        requiredSets.some(r => r.includes('registry_policy_ids')),
        `registry_policy_ids variant missing: ${JSON.stringify(requiredSets)}`
      );
    });

    test('oneOf rejections carry variant metadata', async () => {
      // Malformed create_media_buy: account has account_id AND brand, matching
      // neither variant. Enrichment should expose both variants' required[].
      const res = validateRequest('create_media_buy', {
        idempotency_key: '00000000-0000-0000-0000-000000000000',
        account: { account_id: 'acme', brand: { domain: 'acme.com' } },
        brand: { domain: 'acme.com' },
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-05-31T23:59:59Z',
        packages: [{ buyer_ref: 'p1', product_id: 'p1', budget: 10, pricing_option_id: 'po1' }],
      });
      assert.strictEqual(res.valid, false);
      const oneOfIssue = res.issues.find(i => i.keyword === 'oneOf' && i.pointer === '/account');
      assert.ok(oneOfIssue, 'oneOf issue on /account must be present');
      assert.ok(Array.isArray(oneOfIssue.variants), 'variants must be enriched onto the oneOf issue');
      assert.strictEqual(oneOfIssue.variants.length, 2, 'account has 2 variants in AdCP 3.0');
      // Variant 0: account_id only
      assert.deepStrictEqual(oneOfIssue.variants[0].required, ['account_id']);
      // Variant 1: brand + operator (sandbox optional)
      assert.deepStrictEqual(oneOfIssue.variants[1].required, ['brand', 'operator']);
      // Non-oneOf issues must NOT carry variants (keeps envelope compact)
      const nonOneOf = res.issues.filter(i => i.keyword !== 'oneOf' && i.keyword !== 'anyOf');
      for (const issue of nonOneOf) {
        assert.strictEqual(
          issue.variants,
          undefined,
          `issue at ${issue.pointer} (keyword=${issue.keyword}) must not have variants`
        );
      }
    });

    test('variants ship by default; schemaPath stripped unless exposed', () => {
      // Different sensitivity classes:
      //   - schemaPath encodes seller handler branch ordering (impl detail) → gated
      //   - variants reflects the PUBLIC spec's union shape (already in bundled
      //     schemas shipped with @adcp/sdk) → NOT gated, so production LLMs
      //     get the recovery info #919 was built to provide.
      const issues = [
        {
          pointer: '/account',
          message: 'must match exactly one schema in oneOf',
          keyword: 'oneOf',
          schemaPath: '#/properties/account/oneOf',
          variants: [
            { index: 0, required: ['account_id'], properties: ['account_id'] },
            { index: 1, required: ['brand', 'operator'], properties: ['brand', 'operator', 'sandbox'] },
          ],
        },
      ];
      const defaultShape = buildAdcpValidationErrorPayload('create_media_buy', 'request', issues);
      assert.strictEqual(defaultShape.issues[0].schemaPath, undefined, 'schemaPath stripped by default');
      assert.ok(
        Array.isArray(defaultShape.issues[0].variants),
        'variants ships by default — helps naive LLMs recover in production'
      );
      assert.strictEqual(defaultShape.issues[0].variants.length, 2);
      const exposed = buildAdcpValidationErrorPayload('create_media_buy', 'request', issues, {
        exposeSchemaPath: true,
      });
      assert.strictEqual(exposed.issues[0].schemaPath, '#/properties/account/oneOf', 'schemaPath present when exposed');
      assert.ok(Array.isArray(exposed.issues[0].variants), 'variants present when exposed');
      assert.strictEqual(exposed.issues[0].variants.length, 2);
    });

    test('builds an L3 error payload for adcpError() with dual-location issues', () => {
      const issues = [
        { pointer: '/media_buy_id', message: 'is required', keyword: 'required', schemaPath: '#/required' },
      ];
      const payload = buildAdcpValidationErrorPayload('create_media_buy', 'response', issues);
      assert.ok(payload.message.includes('/media_buy_id'));
      assert.strictEqual(payload.field, '/media_buy_id');
      // Issues land at the top level AND inside details (spec-convention mirror).
      assert.ok(Array.isArray(payload.issues), 'issues must be a top-level array');
      assert.strictEqual(payload.issues.length, 1);
      assert.strictEqual(payload.issues[0].pointer, '/media_buy_id');
      assert.strictEqual(payload.issues[0].keyword, 'required');
      assert.strictEqual(payload.details.tool, 'create_media_buy');
      assert.strictEqual(payload.details.side, 'response');
      assert.ok(Array.isArray(payload.details.issues), 'details.issues mirrors for spec compatibility');
      assert.deepStrictEqual(payload.details.issues, payload.issues);
    });
  });

  describe('schemaId + discriminator enrichment (issue #1283)', () => {
    test('schemaId resolves to the validating schema $id', () => {
      // Adopters debugging an activate_signal validation error need to know
      // which schema rejected their payload. AdCP ships activate_signal in
      // the pre-resolved `bundled/` tree — the activation_key sub-schema is
      // inlined at bundle time without an inner $id — so the rejecting
      // schemaId is the response root. That's still the right answer for
      // the wire envelope: it names the schema the validator actually used,
      // matching exactly what `npm view @adcp/sdk` ships.
      const outcome = validateResponse('activate_signal', {
        deployments: [
          {
            type: 'platform',
            platform: 'dsp1',
            is_live: true,
            activation_key: { type: 'key_value' },
          },
        ],
      });
      assert.strictEqual(outcome.valid, false);
      const issue = outcome.issues.find(i => i.pointer.startsWith('/deployments/0/activation_key'));
      assert.ok(issue, `expected an activation_key issue, got: ${JSON.stringify(outcome.issues)}`);
      assert.ok(
        typeof issue.schemaId === 'string' && issue.schemaId.endsWith('.json'),
        `expected a registered schema $id, got: ${JSON.stringify(issue.schemaId)}`
      );
      assert.ok(
        issue.schemaId.includes('activate-signal-response') || issue.schemaId.includes('activation-key'),
        `schemaId should name the activate_signal response or its activation-key fragment, got: ${issue.schemaId}`
      );
    });

    test('schemaId falls back to the root validator $id for inline failures', () => {
      // get_products-request rejects an empty payload at the request root —
      // schemaPath is `#/required`, so schemaId comes from the root schema's $id.
      const outcome = validateRequest('get_products', {});
      assert.strictEqual(outcome.valid, false);
      const issue = outcome.issues[0];
      assert.ok(issue);
      assert.ok(typeof issue.schemaId === 'string', `expected schemaId on root issue, got: ${JSON.stringify(issue)}`);
      assert.ok(
        issue.schemaId.endsWith('-request.json'),
        `schemaId should be the request schema $id, got: ${issue.schemaId}`
      );
    });

    test('discriminator is attached to the surviving variant on a const collapse', () => {
      // activation_key is a oneOf split by `type` const ('segment_id' vs 'key_value').
      // Outer deployment matches the platform variant cleanly so only the inner
      // activation_key oneOf cascades. Picking type='key_value' but omitting
      // `key`/`value` leaves variant[1] as the best surviving variant — every
      // residual error inherited from that variant should carry
      // `discriminator: [{field: 'type', value: 'key_value'}]`.
      const outcome = validateResponse('activate_signal', {
        deployments: [
          {
            type: 'platform',
            platform: 'dsp1',
            is_live: true,
            activation_key: { type: 'key_value' },
          },
        ],
      });
      assert.strictEqual(outcome.valid, false);
      const tagged = outcome.issues.filter(i => Array.isArray(i.discriminator));
      assert.ok(
        tagged.length > 0,
        `expected at least one issue with a discriminator tag, got: ${JSON.stringify(outcome.issues)}`
      );
      const sample = tagged[0];
      assert.deepStrictEqual(
        sample.discriminator,
        [{ field: 'type', value: 'key_value' }],
        `discriminator should reflect the picked variant, got: ${JSON.stringify(sample.discriminator)}`
      );
    });

    test('formatIssues suffixes prose with schema and discriminator when present', () => {
      const issues = [
        {
          pointer: '/deployments/0/activation_key',
          message: "must have required property 'key'",
          keyword: 'required',
          schemaPath: '/schemas/3.0.5/core/activation-key.json/oneOf/1/required',
          schemaId: '/schemas/3.0.5/core/activation-key.json',
          discriminator: [{ field: 'type', value: 'key_value' }],
        },
      ];
      const summary = formatIssues(issues);
      assert.ok(
        summary.includes('(schema: /schemas/3.0.5/core/activation-key.json)'),
        `summary should embed schema $id, got: ${summary}`
      );
      assert.ok(
        summary.includes("(discriminator: type='key_value')"),
        `summary should embed discriminator, got: ${summary}`
      );
    });

    test('formatIssues suppresses (schema: …) when schemaId equals the rootSchemaId', () => {
      // Most issues land on the response root in the bundled tree; the
      // schema suffix would just restate the tool name. Adopters who want
      // the field unconditionally read it from the structured issues[].
      const rootSchemaId = '/schemas/3.0.5/bundled/signals/activate-signal-response.json';
      const issues = [
        {
          pointer: '/deployments/0/activation_key/key',
          message: "must have required property 'key'",
          keyword: 'required',
          schemaPath: '/schemas/3.0.5/bundled/signals/activate-signal-response.json/oneOf/0/...',
          schemaId: rootSchemaId,
          discriminator: [{ field: 'type', value: 'key_value' }],
        },
      ];
      const summary = formatIssues(issues, 3, { rootSchemaId });
      assert.ok(!summary.includes('(schema:'), `schema suffix should be suppressed at root, got: ${summary}`);
      assert.ok(
        summary.includes("(discriminator: type='key_value')"),
        `discriminator suffix must still ship, got: ${summary}`
      );
    });

    test('discriminator is absent when no const collapse picks a variant', () => {
      // create_content_standards uses an anyOf split by `required`-only
      // (policies vs registry_policy_ids), no `const` asserters.
      // discriminator is reserved for const-asserting unions where we
      // can name a specific field/value pair.
      const res = validateRequest('create_content_standards', {
        idempotency_key: '00000000-0000-0000-0000-000000000000',
        account: { account_id: 'acme' },
        scope: { kind: 'buyer' },
      });
      assert.strictEqual(res.valid, false);
      const anyOfIssue = res.issues.find(i => i.keyword === 'anyOf');
      assert.ok(anyOfIssue, 'anyOf issue must be present');
      assert.strictEqual(
        anyOfIssue.discriminator,
        undefined,
        `non-const unions must not carry discriminator, got: ${JSON.stringify(anyOfIssue.discriminator)}`
      );
      // ...but variants[] still ships (the public-spec recovery info).
      assert.ok(Array.isArray(anyOfIssue.variants));
    });

    test('nested unions: inner discriminator tag is preserved on leaf errors', () => {
      // activate_signal-response has nested oneOfs:
      //   response root oneOf (success/error) →
      //     deployments[].items oneOf (platform/agent) →
      //       activation_key oneOf (segment_id/key_value)
      // User picks platform deployment + key_value activation_key but
      // omits `key`/`value`. The leaf `required` errors live inside the
      // INNER activation_key oneOf — their tag must reflect the most-
      // specific discriminator (`type='key_value'`), not the outer
      // deployment discriminator (`type='platform'`). Adopters fix the
      // payload by reading the leaf, so the leaf tag is the actionable one.
      const outcome = validateResponse('activate_signal', {
        deployments: [
          {
            type: 'platform',
            platform: 'dsp1',
            is_live: true,
            activation_key: { type: 'key_value' },
          },
        ],
      });
      assert.strictEqual(outcome.valid, false);
      const leaf = outcome.issues.find(i => i.pointer === '/deployments/0/activation_key/key');
      assert.ok(leaf, `expected a leaf 'required' issue, got: ${JSON.stringify(outcome.issues)}`);
      assert.deepStrictEqual(
        leaf.discriminator,
        [{ field: 'type', value: 'key_value' }],
        `leaf tag must be the inner discriminator, got: ${JSON.stringify(leaf.discriminator)}`
      );
    });

    test('formatDiscriminator escapes apostrophes in const string values', () => {
      // No live AdCP const carries an apostrophe today, but a future
      // spec addition could. The wire suffix must stay unambiguous.
      const issues = [
        {
          pointer: '/x',
          message: 'must match',
          keyword: 'enum',
          schemaPath: '#/properties/x/enum',
          discriminator: [{ field: 'flavor', value: "it's spicy" }],
        },
      ];
      const summary = formatIssues(issues);
      assert.ok(
        summary.includes("flavor='it\\'s spicy'"),
        `apostrophe must be escaped in discriminator suffix, got: ${summary}`
      );
    });

    test('compound discriminators produce a multi-entry array', () => {
      // Synthetic ValidationIssue with two discriminator pairs (mirrors
      // audience-selector's `(type, value_type)` shape). formatDiscriminator
      // joins multiple entries with `, ` so adopters reading the wire
      // envelope see every discriminator field.
      const issues = [
        {
          pointer: '/audience_selector',
          message: 'must have required property X',
          keyword: 'required',
          schemaPath: '#/properties/audience_selector/oneOf/2/required',
          discriminator: [
            { field: 'type', value: 'demographic' },
            { field: 'value_type', value: 'range' },
          ],
        },
      ];
      const summary = formatIssues(issues);
      assert.ok(
        summary.includes("(discriminator: type='demographic', value_type='range')"),
        `compound discriminator must render as comma-joined pairs, got: ${summary}`
      );
    });

    test('buildAdcpValidationErrorPayload prose embeds schema and discriminator hints', () => {
      const issues = [
        {
          pointer: '/deployments/0/activation_key',
          message: "must have required property 'key'",
          keyword: 'required',
          schemaPath: '/schemas/3.0.5/core/activation-key.json/oneOf/1/required',
          schemaId: '/schemas/3.0.5/core/activation-key.json',
          discriminator: [{ field: 'type', value: 'key_value' }],
        },
      ];
      const payload = buildAdcpValidationErrorPayload('activate_signal', 'response', issues);
      assert.ok(
        payload.message.includes('schema: /schemas/3.0.5/core/activation-key.json'),
        `wire message should name the schema, got: ${payload.message}`
      );
      assert.ok(
        payload.message.includes("discriminator: type='key_value'"),
        `wire message should name the discriminator, got: ${payload.message}`
      );
      // schemaId and discriminator must survive the default (exposeSchemaPath: false) projection.
      assert.strictEqual(payload.issues[0].schemaId, '/schemas/3.0.5/core/activation-key.json');
      assert.deepStrictEqual(payload.issues[0].discriminator, [{ field: 'type', value: 'key_value' }]);
      assert.strictEqual(payload.issues[0].schemaPath, undefined, 'schemaPath stripped by default — schemaId is not');
    });

    test('buildAdcpValidationErrorPayload suppresses redundant schema suffix when rootSchemaId matches', () => {
      const rootSchemaId = '/schemas/3.0.5/bundled/signals/activate-signal-response.json';
      const issues = [
        {
          pointer: '/deployments/0/activation_key/key',
          message: "must have required property 'key'",
          keyword: 'required',
          schemaPath: '/schemas/3.0.5/bundled/signals/activate-signal-response.json/oneOf/0/.../required',
          schemaId: rootSchemaId,
          discriminator: [{ field: 'type', value: 'key_value' }],
        },
      ];
      const payload = buildAdcpValidationErrorPayload('activate_signal', 'response', issues, { rootSchemaId });
      assert.ok(
        !payload.message.includes('schema:'),
        `schema suffix should be suppressed when schemaId matches rootSchemaId, got: ${payload.message}`
      );
      assert.ok(
        payload.message.includes("discriminator: type='key_value'"),
        `discriminator suffix must still ship, got: ${payload.message}`
      );
      // The structured issue still carries schemaId for adopters who want it.
      assert.strictEqual(payload.issues[0].schemaId, rootSchemaId);
    });

    test('ValidationOutcome surfaces the root validator schemaId', () => {
      const outcome = validateResponse('activate_signal', {
        deployments: [
          {
            type: 'platform',
            platform: 'dsp1',
            is_live: true,
            activation_key: { type: 'key_value' },
          },
        ],
      });
      assert.match(
        outcome.schemaId ?? '',
        /^\/schemas\/3\.0\.\d+\/bundled\/signals\/activate-signal-response\.json$/,
        `outcome.schemaId should name the root validator, got: ${outcome.schemaId}`
      );
    });
  });

  describe('listValidatorKeys', () => {
    test('exposes every (tool, direction) pair with a shipped schema', () => {
      const keys = listValidatorKeys();
      assert.ok(keys.length > 0);
      // Spot-check a handful we know must be present.
      for (const key of ['get_products::request', 'get_products::sync', 'create_media_buy::submitted']) {
        assert.ok(keys.includes(key), `missing ${key}`);
      }
    });
  });

  describe('ensureCoreLoaded ordering (regression #862)', () => {
    // Belt-and-braces guard: when a flat-tree tool compile fires
    // `ensureCoreLoaded` FIRST, every non-tool fragment across the whole
    // schema tree gets pre-registered raw. That pre-registration must not
    // accidentally short-circuit the later `relaxResponseRoot` compile for
    // a bundled tool whose response has root-level `additionalProperties:
    // false`. Path-normalization drift between `fileIndex.values()` (the
    // tool-file skip list) and `walkJsonFiles` (the registration walker)
    // would cause this silent strict-mode flip — `create_property_list`
    // below would start rejecting `replayed` at the root instead of
    // passing it through as envelope.
    test('flat-tree compile before bundled compile still preserves relaxResponseRoot', () => {
      _resetValidationLoader();
      // Compile a flat-tree-only tool first; this fires `ensureCoreLoaded`
      // and walks every non-bundled directory.
      const flat = validateResponse('sync_plans', {
        plans: [{ plan_id: 'p1', status: 'active', version: 1 }],
      });
      assert.notStrictEqual(flat.variant, 'skipped', 'sync_plans must have a compiled validator');
      // Now compile a bundled tool whose root needs relaxation.
      const bundled = validateResponse('create_property_list', { replayed: false });
      const rootAdditional = bundled.issues.filter(
        i => i.keyword === 'additionalProperties' && (i.pointer === '' || i.pointer === '/')
      );
      assert.deepStrictEqual(
        rootAdditional,
        [],
        `relaxResponseRoot must still apply after ensureCoreLoaded pre-registers fragments: ${JSON.stringify(rootAdditional)}`
      );
    });
  });

  describe('cross-domain $ref resolution (regression #862)', () => {
    // sync-plans-request.json lives in governance/ and $refs three sibling
    // building-block fragments in the same directory:
    //   - governance/audience-constraints.json
    //   - governance/policy-entry.json
    //   - enums/restricted-attribute.json
    // Before the loader pre-registered flat-tree domain fragments, AJV could
    // not resolve the governance/* siblings and threw at compile time. This
    // guard compiles each validator and runs it against a minimal payload;
    // a $ref resolution regression would show up as a thrown exception.
    for (const tool of [
      'sync_plans',
      'check_governance',
      'acquire_rights',
      'update_rights',
      'get_rights',
      'create_content_standards',
      'create_property_list',
      'create_collection_list',
      'activate_signal',
    ]) {
      test(`${tool} request schema compiles + runs without $ref errors`, () => {
        let outcome;
        assert.doesNotThrow(() => {
          outcome = validateRequest(tool, {});
        });
        // Guard against silent-regression where a refactor drops the tool
        // from the catalog and the doesNotThrow assertion becomes trivial.
        assert.notStrictEqual(
          outcome.variant,
          'skipped',
          `${tool} must have a compiled request validator — got variant:skipped`
        );
        // Even if AJV ever demoted unresolved-$ref to a soft error instead
        // of throwing, the issue list would surface it.
        for (const issue of outcome.issues) {
          assert.ok(
            !/can't resolve reference/i.test(issue.message),
            `${tool} request compile leaked unresolved-$ref: ${issue.message}`
          );
        }
      });
      test(`${tool} response schema compiles + runs without $ref errors`, () => {
        let outcome;
        assert.doesNotThrow(() => {
          outcome = validateResponse(tool, {});
        });
        assert.notStrictEqual(
          outcome.variant,
          'skipped',
          `${tool} must have a compiled response validator — got variant:skipped`
        );
        for (const issue of outcome.issues) {
          assert.ok(
            !/can't resolve reference/i.test(issue.message),
            `${tool} response compile leaked unresolved-$ref: ${issue.message}`
          );
        }
      });
    }
  });

  describe('client hooks', () => {
    test('validateOutgoingRequest strict throws a ValidationError', () => {
      assert.throws(
        () => validateOutgoingRequest('create_media_buy', {}, 'strict'),
        err => err instanceof ValidationError && err.code === 'VALIDATION_ERROR'
      );
    });

    test('validateOutgoingRequest warn logs and returns without throwing', () => {
      const logs = [];
      const outcome = validateOutgoingRequest('create_media_buy', {}, 'warn', logs);
      assert.strictEqual(outcome.valid, false);
      assert.ok(logs.length === 1);
      assert.strictEqual(logs[0].type, 'warning');
    });

    test('validateOutgoingRequest off short-circuits without consulting the validator', () => {
      const outcome = validateOutgoingRequest('create_media_buy', {}, 'off');
      assert.strictEqual(outcome, undefined);
    });

    test('validateIncomingResponse off is a no-op valid', () => {
      const outcome = validateIncomingResponse('get_products', { products: 'not-array' }, 'off');
      assert.strictEqual(outcome.valid, true);
    });

    test('validateIncomingResponse warn logs and returns invalid outcome', () => {
      const logs = [];
      const outcome = validateIncomingResponse('get_products', { products: 'not-array' }, 'warn', logs);
      assert.strictEqual(outcome.valid, false);
      assert.ok(logs.length === 1);
    });
  });

  describe('resolveValidationModes defaults', () => {
    test('requests default to warn', () => {
      const modes = resolveValidationModes();
      assert.strictEqual(modes.requests, 'warn');
    });

    test('responses default to warn regardless of NODE_ENV', () => {
      const prev = process.env.NODE_ENV;
      try {
        for (const env of ['development', 'test', 'production', undefined]) {
          if (env === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = env;
          const modes = resolveValidationModes();
          assert.strictEqual(
            modes.responses,
            'warn',
            `expected warn under NODE_ENV=${env ?? 'unset'}, got ${modes.responses}`
          );
        }
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    test('explicit config overrides defaults', () => {
      const modes = resolveValidationModes({ requests: 'strict', responses: 'off' });
      assert.strictEqual(modes.requests, 'strict');
      assert.strictEqual(modes.responses, 'off');
    });
  });
});
