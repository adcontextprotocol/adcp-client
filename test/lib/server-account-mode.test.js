// Tests for `src/lib/server/account-mode.ts` — the three-mode account
// model and sandbox-authority gate primitives. See
// docs/proposals/lifecycle-state-and-sandbox-authority.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { getAccountMode, isSandboxOrMockAccount, assertSandboxAccount } = require('../../dist/lib/server/index.js');

describe('getAccountMode', () => {
  test('returns explicit mode when set', () => {
    assert.strictEqual(getAccountMode({ mode: 'live' }), 'live');
    assert.strictEqual(getAccountMode({ mode: 'sandbox' }), 'sandbox');
    assert.strictEqual(getAccountMode({ mode: 'mock' }), 'mock');
  });

  test('back-compat: legacy sandbox: true reads as sandbox mode', () => {
    assert.strictEqual(getAccountMode({ sandbox: true }), 'sandbox');
  });

  test('explicit mode wins over legacy sandbox flag', () => {
    // If both are present, the explicit mode is authoritative.
    assert.strictEqual(getAccountMode({ mode: 'live', sandbox: true }), 'live');
    assert.strictEqual(getAccountMode({ mode: 'mock', sandbox: false }), 'mock');
  });

  test('defaults to live for missing/unknown values (fail-closed)', () => {
    assert.strictEqual(getAccountMode(undefined), 'live');
    assert.strictEqual(getAccountMode(null), 'live');
    assert.strictEqual(getAccountMode({}), 'live');
    assert.strictEqual(getAccountMode({ sandbox: false }), 'live');
    assert.strictEqual(getAccountMode({ mode: 'production' }), 'live'); // unknown mode → live
    assert.strictEqual(getAccountMode('not-an-object'), 'live');
  });

  test('immune to Object.prototype pollution', () => {
    // Regression: if an attacker reaches a `__proto__`-via-merge sink upstream
    // and stamps `Object.prototype.mode = 'sandbox'` (or `sandbox = true`),
    // every plain object would inherit those values via bare dot access.
    // `getAccountMode` reads via `Object.hasOwn` so the gate stays closed.
    try {
      Object.prototype.mode = 'sandbox';
      Object.prototype.sandbox = true;
      assert.strictEqual(getAccountMode({}), 'live');
      assert.strictEqual(getAccountMode({ id: 'acc' }), 'live');
    } finally {
      delete Object.prototype.mode;
      delete Object.prototype.sandbox;
    }
  });
});

describe('isSandboxOrMockAccount', () => {
  test('true for sandbox and mock modes', () => {
    assert.strictEqual(isSandboxOrMockAccount({ mode: 'sandbox' }), true);
    assert.strictEqual(isSandboxOrMockAccount({ mode: 'mock' }), true);
  });

  test('false for live mode', () => {
    assert.strictEqual(isSandboxOrMockAccount({ mode: 'live' }), false);
  });

  test('back-compat: sandbox: true is a non-production account', () => {
    assert.strictEqual(isSandboxOrMockAccount({ sandbox: true }), true);
  });

  test('false for missing account / unknown shapes (fail-closed)', () => {
    assert.strictEqual(isSandboxOrMockAccount(undefined), false);
    assert.strictEqual(isSandboxOrMockAccount(null), false);
    assert.strictEqual(isSandboxOrMockAccount({}), false);
  });
});

describe('assertSandboxAccount', () => {
  test('no-op for sandbox / mock / legacy sandbox: true', () => {
    assert.doesNotThrow(() => assertSandboxAccount({ mode: 'sandbox' }));
    assert.doesNotThrow(() => assertSandboxAccount({ mode: 'mock' }));
    assert.doesNotThrow(() => assertSandboxAccount({ sandbox: true }));
  });

  test('throws PERMISSION_DENIED for live accounts', () => {
    let caught;
    try {
      assertSandboxAccount({ mode: 'live' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'PERMISSION_DENIED');
    assert.strictEqual(caught.details?.scope, 'sandbox-gate');
    assert.strictEqual(caught.details?.reason, 'sandbox-or-mock-required');
  });

  test('throws PERMISSION_DENIED for missing account (fail-closed)', () => {
    let caught;
    try {
      assertSandboxAccount(undefined);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'PERMISSION_DENIED');
  });

  test('throws PERMISSION_DENIED for empty / unknown-shape accounts', () => {
    assert.throws(() => assertSandboxAccount({}), { code: 'PERMISSION_DENIED' });
    assert.throws(() => assertSandboxAccount({ sandbox: false }), { code: 'PERMISSION_DENIED' });
    assert.throws(() => assertSandboxAccount({ mode: 'production' }), { code: 'PERMISSION_DENIED' });
  });

  test('tool name surfaces in details when supplied', () => {
    let caught;
    try {
      assertSandboxAccount({ mode: 'live' }, { tool: 'comply_test_controller' });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(caught.details?.tool, 'comply_test_controller');
  });

  test('custom message override', () => {
    let caught;
    try {
      assertSandboxAccount({ mode: 'live' }, { message: 'Tenant not provisioned for testing' });
    } catch (err) {
      caught = err;
    }
    assert.match(caught.message, /Tenant not provisioned for testing/);
  });
});
