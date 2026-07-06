'use strict';

// Regression for adcp-client#2327: `field_value` object equality was a
// JSON.stringify comparison, which is key-order-sensitive — a content-equal
// object whose members serialize in a different order false-negatived the
// check (observed live: a format_id {id, agent_url} echoed as {agent_url, id}
// failed "round-trips verbatim"). JSON object member order is not significant
// (RFC 8259 section 4); array element order is, and stays strict.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../dist/lib/testing/storyboard/validations.js');

function makeCtx({ data, storyboardContext } = {}) {
  return {
    taskName: 'list_creative_formats',
    agentUrl: 'https://example.com/mcp',
    contributions: new Set(),
    taskResult: { success: true, data: data ?? {} },
    storyboardContext: storyboardContext,
  };
}

describe('field_value object equality is key-order-insensitive (#2327)', () => {
  it('passes when actual object has the same members in a different order', () => {
    const [result] = runValidations(
      [
        {
          check: 'field_value',
          path: 'formats[0].format_id',
          value: { id: 'video_1920x1080', agent_url: 'https://example.com/mcp' },
          description: 'format_id round-trips verbatim',
        },
      ],
      // Insertion order deliberately reversed vs the expectation.
      makeCtx({ data: { formats: [{ format_id: { agent_url: 'https://example.com/mcp', id: 'video_1920x1080' } }] } })
    );
    assert.strictEqual(result.passed, true, JSON.stringify(result));
  });

  it('passes on nested objects with reordered members', () => {
    const [result] = runValidations(
      [
        {
          check: 'field_value',
          path: 'pkg',
          value: { a: 1, inner: { x: 'y', n: [1, 2] } },
          description: 'nested reorder',
        },
      ],
      makeCtx({ data: { pkg: { inner: { n: [1, 2], x: 'y' }, a: 1 } } })
    );
    assert.strictEqual(result.passed, true, JSON.stringify(result));
  });

  it('still fails when a member value differs', () => {
    const [result] = runValidations(
      [
        {
          check: 'field_value',
          path: 'formats[0].format_id',
          value: { id: 'video_1920x1080', agent_url: 'https://example.com/mcp' },
          description: 'format_id round-trips verbatim',
        },
      ],
      makeCtx({ data: { formats: [{ format_id: { agent_url: 'https://example.com/mcp', id: 'display_300x250' } }] } })
    );
    assert.strictEqual(result.passed, false);
  });

  it('still fails when a member is missing or extra', () => {
    const [missing] = runValidations(
      [{ check: 'field_value', path: 'o', value: { a: 1, b: 2 }, description: 'missing member' }],
      makeCtx({ data: { o: { a: 1 } } })
    );
    assert.strictEqual(missing.passed, false);
    const [extra] = runValidations(
      [{ check: 'field_value', path: 'o', value: { a: 1 }, description: 'extra member' }],
      makeCtx({ data: { o: { a: 1, b: 2 } } })
    );
    assert.strictEqual(extra.passed, false);
  });

  it('array element order remains significant', () => {
    const [result] = runValidations(
      [{ check: 'field_value', path: 'arr', value: [1, 2, 3], description: 'array order strict' }],
      makeCtx({ data: { arr: [3, 2, 1] } })
    );
    assert.strictEqual(result.passed, false);
  });

  it('allowed_values honors key-order-insensitive object match', () => {
    const [result] = runValidations(
      [
        {
          check: 'field_value',
          path: 'o',
          allowed_values: [{ a: 1, b: 2 }, { c: 3 }],
          description: 'allowed_values object member',
        },
      ],
      makeCtx({ data: { o: { b: 2, a: 1 } } })
    );
    assert.strictEqual(result.passed, true, JSON.stringify(result));
  });
});
