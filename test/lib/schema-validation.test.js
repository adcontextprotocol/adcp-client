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

    test('builds an L3 error payload for adcpError()', () => {
      const issues = [
        { pointer: '/media_buy_id', message: 'is required', keyword: 'required', schemaPath: '#/required' },
      ];
      const payload = buildAdcpValidationErrorPayload('create_media_buy', 'response', issues);
      assert.ok(payload.message.includes('/media_buy_id'));
      assert.strictEqual(payload.field, '/media_buy_id');
      assert.strictEqual(payload.details.tool, 'create_media_buy');
      assert.strictEqual(payload.details.side, 'response');
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

    test('responses default to strict in non-production', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const modes = resolveValidationModes();
        assert.strictEqual(modes.responses, 'strict');
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    test('responses default to warn in production', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const modes = resolveValidationModes();
        assert.strictEqual(modes.responses, 'warn');
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
