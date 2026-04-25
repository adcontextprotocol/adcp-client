/**
 * Tests for detectFormatMismatchHints — the format-mismatch hint detector
 * that fires when lenient Zod passes but strict AJV rejects on a format
 * keyword (issue #947).
 *
 * Covers: basic detection, strict_only_failure gate, observed_value extraction
 * (including RFC 6901 pointer decoding and length truncation), expected_format
 * parsing, and the message fallback when the AJV message template doesn't match.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectFormatMismatchHints } = require('../../dist/lib/testing/storyboard/format-mismatch-hints');

function makeStrictOnlyFailure(instancePath, message, tool = 'create_media_buy') {
  return [
    {
      check: 'response_schema',
      passed: true, // lenient Zod accepted
      description: 'response matches schema',
      strict: {
        valid: false,
        variant: 'sync',
        issues: [
          {
            instance_path: instancePath,
            schema_path: '#/properties/start_date/format',
            keyword: 'format',
            message,
          },
        ],
      },
    },
  ];
}

describe('detectFormatMismatchHints', () => {
  test('emits hint on strict_only_failure with format keyword', () => {
    const validations = makeStrictOnlyFailure('/start_date', 'must match format "date-time"');
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', { start_date: '2026-04-25' });

    assert.equal(hints.length, 1);
    const h = hints[0];
    assert.equal(h.kind, 'format_mismatch');
    assert.equal(h.tool, 'create_media_buy');
    assert.equal(h.instance_path, '/start_date');
    assert.equal(h.expected_format, 'date-time');
    assert.equal(h.observed_value, '2026-04-25');
    assert.ok(h.message.includes('date-time'));
    assert.ok(h.message.includes('start_date'));
    assert.ok(h.message.includes('2026-04-25'));
  });

  test('does not emit hint when lenient Zod also failed (strict_only_failure gate)', () => {
    const validations = [
      {
        check: 'response_schema',
        passed: false, // lenient also failed — no hint
        description: 'response matches schema',
        strict: {
          valid: false,
          variant: 'sync',
          issues: [
            {
              instance_path: '/expires_at',
              schema_path: '#/properties/expires_at/format',
              keyword: 'format',
              message: 'must match format "date-time"',
            },
          ],
        },
      },
    ];
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', { expires_at: 'not-a-date' });
    assert.equal(hints.length, 0);
  });

  test('does not emit hint when strict AJV passed', () => {
    const validations = [
      {
        check: 'response_schema',
        passed: true,
        description: 'response matches schema',
        strict: { valid: true, variant: 'sync' },
      },
    ];
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', { start_date: '2026-04-25T00:00:00Z' });
    assert.equal(hints.length, 0);
  });

  test('does not emit hint for non-format AJV issues', () => {
    const validations = [
      {
        check: 'response_schema',
        passed: true,
        strict: {
          valid: false,
          variant: 'sync',
          issues: [
            {
              instance_path: '/name',
              schema_path: '#/properties/name/maxLength',
              keyword: 'maxLength', // not 'format'
              message: 'must NOT have more than 255 characters',
            },
          ],
        },
        description: 'response matches schema',
      },
    ];
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', {});
    assert.equal(hints.length, 0);
  });

  test('emits one hint per format issue when multiple issues present', () => {
    const validations = [
      {
        check: 'response_schema',
        passed: true,
        description: 'response matches schema',
        strict: {
          valid: false,
          variant: 'sync',
          issues: [
            {
              instance_path: '/start_date',
              schema_path: '#/properties/start_date/format',
              keyword: 'format',
              message: 'must match format "date-time"',
            },
            {
              instance_path: '/advertiser_id',
              schema_path: '#/properties/advertiser_id/format',
              keyword: 'format',
              message: 'must match format "uuid"',
            },
          ],
        },
      },
    ];
    const data = { start_date: '2026-04-25', advertiser_id: 'not-a-uuid' };
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', data);
    assert.equal(hints.length, 2);
    const kinds = new Set(hints.map(h => h.expected_format));
    assert.ok(kinds.has('date-time'));
    assert.ok(kinds.has('uuid'));
  });

  test('RFC 6901 pointer decoded correctly: ~1 and ~0 escapes', () => {
    // /prop~0with~1slash → prop~with/slash key (RFC 6901 §3: ~1 before ~0)
    const validations = makeStrictOnlyFailure('/prop~0with~1slash', 'must match format "uri"');
    const data = { 'prop~with/slash': 'not-a-uri' };
    const hints = detectFormatMismatchHints(validations, 'sync_creatives', data);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].instance_path, '/prop~0with~1slash');
    assert.equal(hints[0].observed_value, 'not-a-uri');
  });

  test('RFC 6901 pointer with array index', () => {
    const validations = makeStrictOnlyFailure('/packages/0/start_date', 'must match format "date-time"');
    const data = { packages: [{ start_date: '2026-04-25' }] };
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', data);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].observed_value, '2026-04-25');
  });

  test('observed_value omitted for non-string values', () => {
    const validations = makeStrictOnlyFailure('/count', 'must match format "integer"');
    const data = { count: 42 }; // number, not string
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', data);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].observed_value, undefined);
  });

  test('observed_value truncated at 200 codepoints for long strings', () => {
    // Build a string of exactly 201 'a' characters
    const longValue = 'a'.repeat(201);
    const validations = makeStrictOnlyFailure('/description', 'must match format "uri"');
    const data = { description: longValue };
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', data);
    assert.equal(hints.length, 1);
    const ov = hints[0].observed_value;
    assert.ok(ov !== undefined);
    // Should be 199 'a' + ellipsis (200 codepoints total)
    assert.equal(Array.from(ov).length, 200);
    assert.ok(ov.endsWith('…'));
  });

  test('expected_format falls back to (unknown) when AJV message does not match template', () => {
    const validations = makeStrictOnlyFailure('/field', 'custom validator rejected value');
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', {});
    assert.equal(hints.length, 1);
    assert.equal(hints[0].expected_format, '(unknown)');
    assert.ok(hints[0].message.includes('(unknown)'));
  });

  test('returns empty array when validations is empty', () => {
    const hints = detectFormatMismatchHints([], 'create_media_buy', {});
    assert.equal(hints.length, 0);
  });

  test('returns empty array when data is undefined', () => {
    const validations = makeStrictOnlyFailure('/start_date', 'must match format "date-time"');
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', undefined);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].observed_value, undefined);
  });

  test('non-response_schema checks are ignored', () => {
    const validations = [
      {
        check: 'field_present', // not response_schema
        passed: true,
        description: 'field present',
        strict: {
          valid: false,
          variant: 'sync',
          issues: [{ instance_path: '/x', schema_path: '', keyword: 'format', message: 'must match format "uri"' }],
        },
      },
    ];
    const hints = detectFormatMismatchHints(validations, 'create_media_buy', { x: 'not-a-uri' });
    assert.equal(hints.length, 0);
  });
});
