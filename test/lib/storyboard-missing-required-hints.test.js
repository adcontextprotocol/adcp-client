/**
 * Tests for missing-required-field hint detection (issue #946).
 *
 * The runner emits a non-fatal hint when the strict AJV validator flags a
 * required-field violation. Hints are additive — step pass/fail is unchanged.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectMissingRequiredHints } = require('../../dist/lib/testing/storyboard/missing-required-hints');

function makeValidation(issues) {
  return {
    check: 'response_schema',
    passed: true,
    description: 'response schema',
    strict: {
      valid: false,
      variant: 'sync',
      issues,
    },
  };
}

function requiredIssue(fieldPath, fieldName) {
  return {
    instance_path: fieldPath,
    schema_path: '#/required',
    keyword: 'required',
    message: `must have required property '${fieldName}'`,
  };
}

describe('detectMissingRequiredHints', () => {
  test('returns empty array when validations is empty', () => {
    assert.deepEqual(detectMissingRequiredHints('get_products', []), []);
  });

  test('returns empty array when no strict issues', () => {
    const validations = [{ check: 'response_schema', passed: true, description: 'd' }];
    assert.deepEqual(detectMissingRequiredHints('get_products', validations), []);
  });

  test('returns empty array when strict.valid is true', () => {
    const validations = [makeValidation(undefined)];
    validations[0].strict.valid = true;
    validations[0].strict.issues = undefined;
    assert.deepEqual(detectMissingRequiredHints('get_products', validations), []);
  });

  test('emits hint for root-level missing required field', () => {
    const validations = [makeValidation([requiredIssue('/products', 'products')])];
    const hints = detectMissingRequiredHints('get_products', validations);
    assert.equal(hints.length, 1);
    const h = hints[0];
    assert.equal(h.kind, 'missing_required_field');
    assert.equal(h.tool, 'get_products');
    assert.equal(h.field_path, '/products');
    assert.equal(h.schema_ref, '#/required');
    assert.ok(h.message.includes('get_products'));
    assert.ok(h.message.includes("'products'"));
  });

  test('emits hint for nested missing required field', () => {
    const validations = [makeValidation([requiredIssue('/account/brand', 'brand')])];
    const hints = detectMissingRequiredHints('create_media_buy', validations);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].field_path, '/account/brand');
    assert.equal(hints[0].tool, 'create_media_buy');
  });

  test('ignores non-required keyword issues', () => {
    const validations = [makeValidation([
      {
        instance_path: '/budget',
        schema_path: '#/properties/budget/type',
        keyword: 'type',
        message: 'must be number',
      },
    ])];
    assert.deepEqual(detectMissingRequiredHints('create_media_buy', validations), []);
  });

  test('emits multiple hints for multiple required violations', () => {
    const validations = [makeValidation([
      requiredIssue('/name', 'name'),
      requiredIssue('/budget', 'budget'),
    ])];
    const hints = detectMissingRequiredHints('create_media_buy', validations);
    assert.equal(hints.length, 2);
    assert.equal(hints[0].field_path, '/name');
    assert.equal(hints[1].field_path, '/budget');
  });

  test('deduplicates the same field_path across multiple ValidationResult entries', () => {
    const issue = requiredIssue('/name', 'name');
    const validations = [makeValidation([issue]), makeValidation([issue])];
    const hints = detectMissingRequiredHints('create_media_buy', validations);
    assert.equal(hints.length, 1);
  });

  test('fallback: passes when strict.issues is empty array', () => {
    const validations = [makeValidation([])];
    assert.deepEqual(detectMissingRequiredHints('get_products', validations), []);
  });
});
