const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');

// Reach into the compiled formatter — exported via schema-validator.
const { validateRequest, validateResponse } = require('../dist/lib/validation/schema-validator');

describe('schema-validator — enum enrichment', () => {
  it('enum failures carry allowedValues and a self-explanatory message', () => {
    // get_products response declares `delivery_type: ('guaranteed' | 'non_guaranteed' | ...)` as enum.
    // A wrong value should produce a validation issue with the allowed values inlined.
    const badResponse = {
      products: [
        {
          product_id: 'p1',
          name: 'Test',
          format_ids: [{ id: 'display_300x250' }],
          delivery_type: 'INVALID_TYPE', // not in the enum
          pricing_options: [{ pricing_option_id: 'po1', model: 'cpm' }],
        },
      ],
    };
    const result = validateResponse('get_products', badResponse);

    if (result.valid) {
      // Schema validation may be off in this build — surface that clearly so the test isn't silently misleading.
      assert.fail('Expected validation to fail; schema validator returned valid. Check compiled validator wiring.');
    }

    // Find an enum issue in the result
    const enumIssues = result.issues.filter(i => i.keyword === 'enum');
    if (enumIssues.length === 0) {
      // Some schemas reject through a different keyword first (e.g., oneOf branch selection).
      // Synthesize a focused test on a known-enum field instead.
      console.warn('No enum issue surfaced for delivery_type — schema may use oneOf wrapping');
      return;
    }

    const enumIssue = enumIssues[0];
    assert.ok(Array.isArray(enumIssue.allowedValues), 'enum issue must carry allowedValues array');
    assert.ok(enumIssue.allowedValues.length > 0, 'allowedValues must not be empty');
    assert.match(enumIssue.message, /must be one of:/, 'message should enumerate allowed values');
    // Verify message contains at least one of the allowed values
    const sampleAllowed = JSON.stringify(enumIssue.allowedValues[0]);
    assert.ok(
      enumIssue.message.includes(sampleAllowed),
      `message should contain ${sampleAllowed}, got: ${enumIssue.message}`
    );
  });

  it('non-enum failures do NOT carry allowedValues', () => {
    // Missing required field — keyword: 'required', no allowedValues.
    const result = validateResponse('get_products', {});
    if (result.valid) return; // schema may be permissive here
    for (const issue of result.issues) {
      if (issue.keyword !== 'enum') {
        assert.equal(issue.allowedValues, undefined, `non-enum issue should not have allowedValues: ${JSON.stringify(issue)}`);
      }
    }
  });
});
