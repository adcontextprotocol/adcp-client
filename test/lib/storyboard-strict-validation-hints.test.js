/**
 * `MissingRequiredFieldHint` + `FormatMismatchHint` from the strict-AJV
 * verdict on `response_schema` validations (issue #935).
 *
 * The detector partitions strict issues into two structured-hint flavors:
 *   - `keyword: required` issues → grouped by parent `instance_path` so a
 *     seller filling out N missing required fields sees them in one round.
 *   - all other AJV keywords → one `format_mismatch` hint per issue, capped
 *     at MAX_FORMAT_HINTS to keep `step.hints[]` bounded on pathological
 *     responses.
 *
 * Tests drive the detector directly with synthetic `ValidationResult[]` so
 * we don't need to boot the runner / load schemas.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectStrictValidationHints } = require('../../dist/lib/testing/storyboard/strict-validation-hints.js');

function withStrict(taskName, strict, schema_url) {
  return [
    {
      check: 'response_schema',
      passed: true,
      description: 'response conforms',
      strict,
      ...(schema_url !== undefined ? { schema_url } : {}),
    },
  ];
}

describe('detectStrictValidationHints', () => {
  test('returns empty array when no validations carry a strict verdict', () => {
    const out = detectStrictValidationHints('any_tool', [{ check: 'field_present', passed: true, description: 'x' }]);
    assert.deepEqual(out, []);
  });

  test('returns empty when strict.valid is true', () => {
    const out = detectStrictValidationHints(
      'list_creative_formats',
      withStrict('list_creative_formats', { valid: true, variant: 'sync' })
    );
    assert.deepEqual(out, []);
  });

  test('groups `required` issues under their parent instance_path', () => {
    const out = detectStrictValidationHints(
      'get_products',
      withStrict('get_products', {
        valid: false,
        variant: 'sync',
        issues: [
          {
            instance_path: '/products/0/reporting_capabilities',
            schema_path: '#/properties/products/items/properties/reporting_capabilities/required',
            keyword: 'required',
            message: "must have required property 'available_breakdowns'",
          },
          {
            instance_path: '/products/0/reporting_capabilities',
            schema_path: '#/properties/products/items/properties/reporting_capabilities/required',
            keyword: 'required',
            message: "must have required property 'standard_metrics'",
          },
        ],
      })
    );
    const grouped = out.filter(h => h.kind === 'missing_required_field');
    assert.equal(grouped.length, 1, 'two issues under the same parent collapse into one hint');
    assert.equal(grouped[0].tool, 'get_products');
    assert.equal(grouped[0].instance_path, '/products/0/reporting_capabilities');
    assert.deepEqual(grouped[0].missing_fields, ['available_breakdowns', 'standard_metrics']);
    assert.match(grouped[0].message, /missing required fields at \/products\/0\/reporting_capabilities/);
    assert.match(grouped[0].message, /available_breakdowns, standard_metrics/);
  });

  test('emits one format_mismatch per non-required issue (up to cap)', () => {
    const out = detectStrictValidationHints(
      'list_creative_formats',
      withStrict('list_creative_formats', {
        valid: false,
        variant: 'sync',
        issues: [
          {
            instance_path: '/formats/0/format_id/agent_url',
            schema_path: '#/properties/formats/items/properties/format_id/properties/agent_url/format',
            keyword: 'format',
            message: 'must match format "uri"',
          },
          {
            instance_path: '/formats/1/format_id/agent_url',
            schema_path: '#/properties/formats/items/properties/format_id/properties/agent_url/format',
            keyword: 'format',
            message: 'must match format "uri"',
          },
        ],
      })
    );
    const formats = out.filter(h => h.kind === 'format_mismatch');
    assert.equal(formats.length, 2, 'one hint per non-required issue');
    assert.equal(formats[0].tool, 'list_creative_formats');
    assert.equal(formats[0].keyword, 'format');
    assert.equal(formats[0].instance_path, '/formats/0/format_id/agent_url');
    assert.match(formats[0].message, /failed strict format/);
  });

  test('caps format_mismatch hints at 5 to keep step.hints[] bounded', () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      instance_path: `/x/${i}`,
      schema_path: '#',
      keyword: 'format',
      message: 'must match format "uri"',
    }));
    const out = detectStrictValidationHints(
      'list_creative_formats',
      withStrict('list_creative_formats', { valid: false, variant: 'sync', issues })
    );
    const formats = out.filter(h => h.kind === 'format_mismatch');
    assert.equal(formats.length, 5, 'cap trips on > 5 non-required issues');
  });

  test('schema_url passes through to every hint when available', () => {
    const out = detectStrictValidationHints(
      'list_creative_formats',
      withStrict(
        'list_creative_formats',
        {
          valid: false,
          variant: 'sync',
          issues: [
            {
              instance_path: '/formats',
              schema_path: '#',
              keyword: 'required',
              message: "must have required property 'foo'",
            },
            {
              instance_path: '/formats/0/agent_url',
              schema_path: '#',
              keyword: 'format',
              message: 'must match format "uri"',
            },
          ],
        },
        'https://adcontextprotocol.org/schemas/3.0.0/creative/list-creative-formats-response.json'
      )
    );
    for (const hint of out) {
      assert.equal(
        hint.schema_url,
        'https://adcontextprotocol.org/schemas/3.0.0/creative/list-creative-formats-response.json'
      );
    }
  });

  test('schema_url field absent when ValidationResult does not carry one', () => {
    const out = detectStrictValidationHints(
      'list_creative_formats',
      withStrict('list_creative_formats', {
        valid: false,
        variant: 'sync',
        issues: [
          {
            instance_path: '/formats/0/agent_url',
            schema_path: '#',
            keyword: 'format',
            message: 'must match format "uri"',
          },
        ],
      })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].schema_url, undefined);
  });
});
