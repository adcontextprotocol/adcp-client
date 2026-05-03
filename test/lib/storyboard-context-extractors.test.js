const { describe, it } = require('node:test');
const assert = require('node:assert');
const { extractContext } = require('../../dist/lib/testing/storyboard/context');

describe('CONTEXT_EXTRACTORS.sync_accounts', () => {
  it('builds natural-key account when both brand and operator are present', () => {
    const result = extractContext('sync_accounts', {
      accounts: [
        {
          account_id: 'acct-1',
          status: 'active',
          brand: { domain: 'example.com' },
          operator: 'operator.com',
        },
      ],
    });
    assert.deepStrictEqual(result.account, {
      brand: { domain: 'example.com' },
      operator: 'operator.com',
    });
    assert.strictEqual(result.account_id, 'acct-1');
    assert.strictEqual(result.account_status, 'active');
  });

  it('falls back to brand.domain when seller omits operator', () => {
    // Sellers are not required to echo operator back; the natural-key arm
    // requires it, so we derive it from brand.domain.
    const result = extractContext('sync_accounts', {
      accounts: [
        {
          account_id: 'acct-2',
          brand: { domain: 'direct.example.com' },
          // operator intentionally absent
        },
      ],
    });
    assert.deepStrictEqual(result.account, {
      brand: { domain: 'direct.example.com' },
      operator: 'direct.example.com',
    });
  });

  it('does not set account when brand is absent (account_id-only response)', () => {
    // When only account_id is returned, context.account is omitted so
    // downstream request-builders fall through to resolveAccount(options),
    // which always produces a valid natural-key ref.
    const result = extractContext('sync_accounts', {
      accounts: [{ account_id: 'acct-3' }],
    });
    assert.strictEqual(result.account, undefined);
    assert.strictEqual(result.account_id, 'acct-3');
  });

  it('does not set account when brand is absent and operator is present', () => {
    const result = extractContext('sync_accounts', {
      accounts: [{ account_id: 'acct-4', operator: 'op.example.com' }],
    });
    assert.strictEqual(result.account, undefined);
  });

  it('does not set account when brand is non-object (null)', () => {
    const result = extractContext('sync_accounts', {
      accounts: [{ account_id: 'acct-5', brand: null }],
    });
    assert.strictEqual(result.account, undefined);
  });

  it('does not set account when brand has no domain and operator is absent', () => {
    const result = extractContext('sync_accounts', {
      accounts: [{ brand: {} }],
    });
    assert.strictEqual(result.account, undefined);
  });

  it('returns empty object when accounts array is empty', () => {
    const result = extractContext('sync_accounts', { accounts: [] });
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when data is null', () => {
    const result = extractContext('sync_accounts', null);
    assert.deepStrictEqual(result, {});
  });
});
