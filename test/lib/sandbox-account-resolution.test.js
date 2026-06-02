// Tests for sandbox account resolution logic in audience sync
const { describe, test } = require('node:test');
const assert = require('node:assert');

const { resolveAccountForAudiences, resolveAccountForMediaBuy } = require('../../dist/lib/testing/index.js');
const { buildCreateMediaBuyRequest } = require('../../dist/lib/testing/scenarios/media-buy.js');

describe('resolveAccountForAudiences', () => {
  const defaultOptions = { brand: { domain: 'test.example' } };

  test('explicit audience_account_id takes precedence over sandbox', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, audience_account_id: 'acct-123', sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => {
        throw new Error('should not be called');
      }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'acct-123' });
    assert.strictEqual(steps.length, 0, 'no steps needed for explicit account_id');
  });

  test('shared account_id is used when audience_account_id is absent', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, account_id: 'acct-shared', sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => {
        throw new Error('should not be called');
      }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'acct-shared' });
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
    assert.strictEqual(accountRef.operator, 'test.example');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example' });
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
    assert.strictEqual(accountRef.operator, 'test.example');
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, true, 'step should be marked passed (fallback succeeded)');
    assert.match(steps[0].details, /list_accounts failed/);
  });

  test('sandbox without list_accounts uses natural key directly', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['sync_audiences'],
      async () => {
        throw new Error('should not be called');
      }
    );

    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example' });
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
      async () => {
        throw new Error('network timeout');
      }
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, false);
    assert.strictEqual(steps[0].details, 'list_accounts call failed');
  });

  test('no sandbox and no list_accounts yields undefined', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(defaultOptions, ['sync_audiences'], async () => {
      throw new Error('should not be called');
    });

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 0);
  });

  test('sandbox list_accounts passes sandbox: true parameter', async () => {
    let capturedParams;
    await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async params => {
        capturedParams = params;
        return { success: true, data: { accounts: [] } };
      }
    );

    assert.deepStrictEqual(capturedParams, { sandbox: true });
  });

  test('non-sandbox list_accounts passes empty params', async () => {
    let capturedParams;
    await resolveAccountForAudiences(defaultOptions, ['list_accounts', 'sync_audiences'], async params => {
      capturedParams = params;
      return { success: true, data: { accounts: [{ account_id: 'x' }] } };
    });

    assert.deepStrictEqual(capturedParams, {});
  });

  test('sandbox list_accounts exception is caught by runStep', async () => {
    const { accountRef, steps } = await resolveAccountForAudiences(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'sync_audiences'],
      async () => {
        throw new Error('network timeout');
      }
    );

    // Should fall back to natural key
    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example');
    assert.strictEqual(steps.length, 1);
    // runStep catches the exception and marks passed=false, then our code sets passed=true and clears error for fallback
    assert.strictEqual(steps[0].passed, true);
    assert.strictEqual(steps[0].error, undefined, 'error should be cleared when fallback succeeds');
    assert.match(steps[0].details, /list_accounts failed/);
  });
});

describe('resolveAccountForMediaBuy', () => {
  const defaultOptions = { brand: { domain: 'test.example' } };

  test('media_buy_account_id takes precedence over shared account_id and sandbox', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      {
        ...defaultOptions,
        media_buy_account_id: 'media-acct',
        account_id: 'shared-acct',
        sandbox: true,
      },
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => {
        throw new Error('should not be called');
      }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'media-acct' });
    assert.strictEqual(steps.length, 0);
  });

  test('shared account_id is used when media_buy_account_id is absent', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      { ...defaultOptions, account_id: 'shared-acct', sandbox: true },
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => {
        throw new Error('should not be called');
      }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'shared-acct' });
    assert.strictEqual(steps.length, 0);
  });

  test('sandbox with list_accounts returning accounts uses discovered account_id', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'get_products', 'create_media_buy'],
      async params => {
        assert.deepStrictEqual(params, { sandbox: true, status: 'active' });
        return { success: true, data: { accounts: [{ account_id: 'sandbox-media-acct', status: 'active' }] } };
      }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'sandbox-media-acct' });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].step, 'Discover sandbox accounts for media buy');
    assert.match(steps[0].details, /sandbox-media-acct/);
  });

  test('sandbox with empty list_accounts falls back to natural key', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => ({ success: true, data: { accounts: [] } })
    );

    assert.strictEqual(accountRef.sandbox, true);
    assert.strictEqual(accountRef.operator, 'test.example');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example' });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, true);
    assert.match(steps[0].details, /no active accounts/);
  });

  test('non-sandbox with list_accounts discovers account', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['list_accounts', 'get_products', 'create_media_buy'],
      async params => {
        assert.deepStrictEqual(params, { status: 'active' });
        return { success: true, data: { accounts: [{ account_id: 'prod-media-acct', status: 'active' }] } };
      }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'prod-media-acct' });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].step, 'Discover accounts for media buy');
    assert.match(steps[0].details, /prod-media-acct/);
  });

  test('non-sandbox with list_accounts returning empty yields undefined', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => ({ success: true, data: { accounts: [] } })
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].details, 'list_accounts returned no active accounts with account_id');
  });

  test('non-active discovered accounts are not selected for media-buy creation', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => ({
        success: true,
        data: { accounts: [{ account_id: 'pending-acct', status: 'pending_approval' }] },
      }),
      { requireOperatorAuth: true }
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].details, 'list_accounts returned no active accounts with account_id');
  });

  test('declared implicit seller uses natural key even when list_accounts exists', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => {
        throw new Error('should not be called');
      },
      { requireOperatorAuth: false }
    );

    assert.strictEqual(accountRef.operator, 'test.example');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example' });
    assert.strictEqual(steps.length, 0);
  });

  test('declared explicit sandbox seller fails instead of falling back when no account is returned', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      { ...defaultOptions, sandbox: true },
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => ({ success: true, data: { accounts: [] } }),
      { requireOperatorAuth: true }
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].passed, false);
    assert.strictEqual(steps[0].details, 'list_accounts returned no active accounts with account_id');
  });

  test('multiple accounts are ambiguous unless one matches the requested brand/operator', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => ({
        success: true,
        data: {
          accounts: [
            {
              account_id: 'acct-other',
              brand: { domain: 'other.example' },
              operator: 'other.example',
              status: 'active',
            },
            {
              account_id: 'acct-match',
              brand: { domain: 'test.example' },
              operator: 'test.example',
              status: 'active',
            },
          ],
        },
      }),
      { requireOperatorAuth: true }
    );

    assert.deepStrictEqual(accountRef, { account_id: 'acct-match' });
    assert.match(steps[0].details, /brand-matched account: acct-match/);
  });

  test('multiple matching accounts require explicit media_buy_account_id', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['list_accounts', 'get_products', 'create_media_buy'],
      async () => ({
        success: true,
        data: {
          accounts: [
            {
              account_id: 'acct-1',
              brand: { domain: 'test.example' },
              operator: 'test.example',
              status: 'active',
            },
            {
              account_id: 'acct-2',
              brand: { domain: 'test.example' },
              operator: 'test.example',
              status: 'active',
            },
          ],
        },
      }),
      { requireOperatorAuth: true }
    );

    assert.strictEqual(accountRef, undefined);
    assert.strictEqual(steps.length, 1);
    assert.match(steps[0].details, /multiple matching accounts/);
    assert.match(steps[0].details, /media_buy_account_id/);
  });

  test('without list_accounts uses natural key for implicit-account sellers', async () => {
    const { accountRef, steps } = await resolveAccountForMediaBuy(
      defaultOptions,
      ['get_products', 'create_media_buy'],
      async () => {
        throw new Error('should not be called');
      }
    );

    assert.strictEqual(accountRef.sandbox, undefined);
    assert.strictEqual(accountRef.operator, 'test.example');
    assert.deepStrictEqual(accountRef.brand, { domain: 'test.example' });
    assert.strictEqual(steps.length, 0);
  });
});

describe('buildCreateMediaBuyRequest accountRef override', () => {
  const product = {
    product_id: 'prod-1',
    name: 'Product 1',
    pricing_options: [{ pricing_option_id: 'po-1', pricing_model: 'cpm' }],
  };
  const pricingOption = product.pricing_options[0];

  test('uses provided accountRef instead of natural key', () => {
    const request = buildCreateMediaBuyRequest(
      product,
      pricingOption,
      { brand: { domain: 'test.example' } },
      {
        accountRef: { account_id: 'acct-override' },
      }
    );

    assert.deepStrictEqual(request.account, { account_id: 'acct-override' });
  });

  test('throws when accountRef is explicitly undefined', () => {
    assert.throws(
      () =>
        buildCreateMediaBuyRequest(
          product,
          pricingOption,
          { brand: { domain: 'test.example' } },
          {
            accountRef: undefined,
          }
        ),
      /Resolve an account before building the request/
    );
  });
});
