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
