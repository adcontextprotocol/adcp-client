// Tests for sandbox account resolution logic in audience sync
const { describe, test } = require('node:test');
const assert = require('node:assert');

const { resolveAccountForAudiences } = require('../../dist/lib/testing/index.js');

describe('resolveAccountForAudiences', () => {
  const defaultOptions = { brand: { domain: 'test.example.com' } };

  test('explicit audience_account_id takes precedence over sandbox', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, audience_account_id: 'acct-123', sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => { throw new Error('should not be called'); }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'acct-123' });
    assert.strictEqual(steps.length, 0, 'no steps needed for explicit account_id');
  });

  test('sandbox with list_accounts returning accounts uses discovered account_id', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => ({ success: true, data: { accounts: [{ account_id: 'sandbox-acct-1' }] } })
    );

    assert.deepStrictEqual(accountRef, { account_id: 'sandbox-acct-1' });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, true);
    assert.match(steps[0].details, /sandbox-acct-1/);
  });

  test('sandbox with list_accounts returning empty accounts falls back to natural key', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => ({ success: true, data: { accounts: [] } })
    );

    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example.com');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example.com' });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, true, 'step should be marked passed (informational probe)');
    assert.match(steps[0].details, /No explicit sandbox accounts found/);
  });

  test('sandbox with list_accounts failure falls back to natural key', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => ({ success: false, error: 'auth error' })
    );

    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example.com');
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, true, 'step should be marked passed (fallback succeeded)');
    assert.match(steps[0].details, /list_accounts failed/);
  });

  test('sandbox without list_accounts uses natural key directly', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['sync_audiences'],
      async () => { throw new Error('should not be called'); }
    );

    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example.com');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example.com' });
    assert.strictEqual(steps.length, 0, 'no steps needed for direct natural key');
  });

  test('non-sandbox with list_accounts discovers production account', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      defaultOptions,
      ['list_accounts', 'sync_audiences'],
      async () => ({ success: true, data: { accounts: [{ account_id: 'prod-acct-1' }] } })
    );

    assert.deepStrictEqual(accountRef, { account_id: 'prod-acct-1' });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, true);
    assert.match(steps[0].details, /prod-acct-1/);
  });

  test('non-sandbox with list_accounts returning empty yields undefined with details', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      defaultOptions,
      ['list_accounts', 'sync_audiences'],
      async () => ({ success: true, data: { accounts: [] } })
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].details, 'list_accounts returned no accounts');
  });

  test('non-sandbox with list_accounts failure yields undefined with details', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      defaultOptions,
      ['list_accounts', 'sync_audiences'],
      async () => ({ success: false, error: 'server error' })
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].details, 'list_accounts call failed');
  });

  test('non-sandbox with list_accounts exception yields undefined', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      defaultOptions,
      ['list_accounts', 'sync_audiences'],
      async () => { throw new Error('network timeout'); }
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, false);
    assert.strictEqual(steps[0].details, 'list_accounts call failed');
  });

  test('no sandbox and no list_accounts yields undefined', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      defaultOptions,
      ['sync_audiences'],
      async () => { throw new Error('should not be called'); }
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 0);
  });

  test('sandbox list_accounts passes sandbox: true parameter', async () => {
    let capturedParams;
    await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async (params) => {
        capturedParams = params;
        return { success: true, data: { accounts: [] } };
      }
    );

    assert.deepStrictEqual(capturedParams, { sandbox: true });
  });

  test('non-sandbox list_accounts passes empty params', async () => {
    let capturedParams;
    await resolveAccountForAudiences(
      defaultOptions,
      ['list_accounts', 'sync_audiences'],
      async (params) => {
        capturedParams = params;
        return { success: true, data: { accounts: [{ account_id: 'x' }] } };
      }
    );

    assert.deepStrictEqual(capturedParams, {});
  });

  test('sandbox list_accounts exception is caught by runStep', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => { throw new Error('network timeout'); }
    );

    // Should fall back to natural key
    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example.com');
    assert.strictEqual(steps.length, 1);
    // runStep catches the exception and marks passed=false, then our code sets passed=true and clears error for fallback
    assert.strictEqual(steps[0].passed, true);
    assert.strictEqual(steps[0].error, undefined, 'error should be cleared when fallback succeeds');
    assert.match(steps[0].details, /list_accounts failed/);
  });
});
