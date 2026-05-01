/**
 * Storyboard runner: ext.adcp.disable_sandbox hint (issue #841).
 *
 * When the operator passes `--no-sandbox`, the runner stamps
 * `ext.adcp.disable_sandbox: true` on every outgoing request so adopters
 * that read this field bypass internal sandbox routing (env-var
 * fallbacks, brand-domain heuristics, fixture substitutes) and exercise
 * their real adapter path.
 *
 * This is distinct from the existing `--no-sandbox` behavior of setting
 * `account.sandbox: false` (a value, not a routing hint). The pair
 * (sandbox=false + disable_sandbox=true) is the strongest "production
 * path only" signal the runner can send.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { applyDisableSandboxHint } = require('../../dist/lib/testing/storyboard/runner.js');

describe('applyDisableSandboxHint', () => {
  test('injects ext.adcp.disable_sandbox=true on a request with no existing ext block', () => {
    const result = applyDisableSandboxHint({ product_id: 'p1' });
    assert.deepStrictEqual(result, {
      product_id: 'p1',
      ext: { adcp: { disable_sandbox: true } },
    });
  });

  test('preserves existing ext fields outside the adcp namespace', () => {
    const result = applyDisableSandboxHint({
      product_id: 'p1',
      ext: { vendor_x: { foo: 'bar' } },
    });
    assert.deepStrictEqual(result.ext, {
      vendor_x: { foo: 'bar' },
      adcp: { disable_sandbox: true },
    });
  });

  test('preserves existing ext.adcp.* keys alongside disable_sandbox', () => {
    const result = applyDisableSandboxHint({
      product_id: 'p1',
      ext: { adcp: { other_hint: true } },
    });
    assert.deepStrictEqual(result.ext.adcp, {
      other_hint: true,
      disable_sandbox: true,
    });
  });

  test('does not mutate the input request', () => {
    const original = { product_id: 'p1', ext: { adcp: { other_hint: true } } };
    const snapshot = JSON.parse(JSON.stringify(original));
    applyDisableSandboxHint(original);
    assert.deepStrictEqual(original, snapshot, 'input must not be mutated');
  });

  test('treats non-object ext gracefully (replaces with new object)', () => {
    // Defensive: a malformed fixture might author `ext: null` or `ext: 'string'`.
    // The hint must still land cleanly without throwing or coalescing into a
    // shape that fails AJV validation.
    const result = applyDisableSandboxHint({ product_id: 'p1', ext: null });
    assert.deepStrictEqual(result.ext, { adcp: { disable_sandbox: true } });

    const result2 = applyDisableSandboxHint({ product_id: 'p1', ext: 'malformed' });
    assert.deepStrictEqual(result2.ext, { adcp: { disable_sandbox: true } });
  });

  test('treats non-object ext.adcp gracefully (replaces with new object)', () => {
    const result = applyDisableSandboxHint({
      product_id: 'p1',
      ext: { adcp: 'not-an-object' },
    });
    assert.deepStrictEqual(result.ext.adcp, { disable_sandbox: true });
  });

  test('injects ext on every AdCP 3.0 tool (ext is standardized at the top level)', () => {
    // AdCP 3.0.1 standardizes `ext` as a top-level field on every tool's
    // request schema, so the schema-permits-ext check is permissive in
    // practice. Spot-check a few representative tools to confirm the hint
    // lands cleanly across protocol surfaces.
    for (const taskName of ['get_products', 'comply_test_controller', 'tasks_get', 'si_get_offering']) {
      const result = applyDisableSandboxHint({ scenario: 'list_scenarios' }, taskName);
      assert.deepStrictEqual(
        result.ext?.adcp?.disable_sandbox,
        true,
        `${taskName} request should carry ext.adcp.disable_sandbox=true`
      );
    }
  });

  test('runs without taskName (defensive — preserves test-call ergonomics)', () => {
    const result = applyDisableSandboxHint({ product_id: 'p1' });
    assert.deepStrictEqual(result.ext.adcp.disable_sandbox, true);
  });
});
