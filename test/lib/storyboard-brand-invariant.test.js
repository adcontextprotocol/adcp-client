/**
 * Storyboard runner: brand/account invariant.
 *
 * Issue #579 — sellers that scope session state by brand lost cross-step
 * state when a create step sent `brand: acmeoutdoor.example` but a follow-up
 * get/update/delete step either omitted brand or let it default to
 * `test.example`. The runner now overrides brand on every outgoing request
 * after builder / sample_request resolution so a storyboard run lands in one
 * session, regardless of per-tool authorship.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { applyBrandInvariant } = require('../../dist/lib/testing/storyboard/runner.js');

const BRAND = { domain: 'acmeoutdoor.example' };

describe('applyBrandInvariant', () => {
  test('injects brand when the request omits it', () => {
    const result = applyBrandInvariant({ list_id: 'pl-1' }, { brand: BRAND });
    assert.deepStrictEqual(result.brand, BRAND);
    assert.strictEqual(result.list_id, 'pl-1');
  });

  test('overrides a conflicting brand so every step shares one session', () => {
    const result = applyBrandInvariant({ brand: { domain: 'other.example' }, list_id: 'pl-1' }, { brand: BRAND });
    assert.deepStrictEqual(result.brand, BRAND);
  });

  test('fills in account.brand when the request carries an account', () => {
    const result = applyBrandInvariant(
      { account: { operator: 'acmeoutdoor.example' }, list_id: 'pl-1' },
      { brand: BRAND }
    );
    assert.deepStrictEqual(result.account, { operator: 'acmeoutdoor.example', brand: BRAND });
  });

  test('overrides a conflicting account.brand', () => {
    const result = applyBrandInvariant(
      { account: { brand: { domain: 'other.example' }, operator: 'other.example' } },
      { brand: BRAND }
    );
    assert.deepStrictEqual(result.account.brand, BRAND);
  });

  test('passes through when no brand is configured (e.g. security probes)', () => {
    const input = { list_id: 'pl-1' };
    const result = applyBrandInvariant(input, {});
    assert.strictEqual(result, input);
  });

  test('leaves non-object account values alone', () => {
    const result = applyBrandInvariant({ account: null }, { brand: BRAND });
    assert.strictEqual(result.account, null);
  });

  test('does not mutate the input request', () => {
    const input = { account: { operator: 'x' }, list_id: 'pl-1' };
    applyBrandInvariant(input, { brand: BRAND });
    assert.deepStrictEqual(input, { account: { operator: 'x' }, list_id: 'pl-1' });
  });
});
