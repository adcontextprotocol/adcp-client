// Tests for #1339 — accounts.resolve security presets layered with
// composeMethod (requireAccountMatch / requireAdvertiserMatch /
// requireOrgScope).

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { composeMethod } = require('../dist/lib/server/decisioning/compose');
const {
  requireAccountMatch,
  requireAdvertiserMatch,
  requireOrgScope,
} = require('../dist/lib/server/decisioning/resolve-presets');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

const buildAccount = (overrides = {}) => ({
  id: 'acc_1',
  name: 'Acme',
  status: 'active',
  ctx_metadata: {},
  ...overrides,
});

describe('requireAccountMatch (#1339)', () => {
  it('passes through the account when predicate returns true', async () => {
    const inner = async () => buildAccount({ advertiser: 'acme.com' });
    const wrapped = composeMethod(
      inner,
      requireAccountMatch(() => true)
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result.id, 'acc_1');
  });

  it('returns null when predicate denies (default onDeny)', async () => {
    const inner = async () => buildAccount({ advertiser: 'acme.com' });
    const wrapped = composeMethod(
      inner,
      requireAccountMatch(() => false)
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result, null);
  });

  it('throws PermissionDeniedError when predicate denies and onDeny=throw', async () => {
    const inner = async () => buildAccount();
    const wrapped = composeMethod(
      inner,
      requireAccountMatch(() => false, { onDeny: 'throw', action: 'accounts.resolve.test' })
    );
    await assert.rejects(
      () => wrapped({ account_id: 'acc_1' }, {}),
      err => {
        assert.ok(err instanceof AdcpError, 'expected AdcpError');
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(err.details?.action, 'accounts.resolve.test');
        return true;
      }
    );
  });

  it('propagates null from inner without invoking the predicate', async () => {
    const inner = async () => null;
    let predicateCalled = false;
    const wrapped = composeMethod(
      inner,
      requireAccountMatch(() => {
        predicateCalled = true;
        return false;
      })
    );
    const result = await wrapped({ account_id: 'unknown' }, {});
    assert.strictEqual(result, null);
    assert.strictEqual(predicateCalled, false, 'predicate must not run on null');
  });

  it('passes the resolved account and ctx into the predicate', async () => {
    const inner = async () => buildAccount({ advertiser: 'acme.com' });
    let sawAccount;
    let sawCtx;
    const wrapped = composeMethod(
      inner,
      requireAccountMatch((account, ctx) => {
        sawAccount = account;
        sawCtx = ctx;
        return true;
      })
    );
    await wrapped({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', principal: 'p1' } });
    assert.strictEqual(sawAccount.advertiser, 'acme.com');
    assert.deepStrictEqual(sawCtx, { authInfo: { kind: 'oauth', principal: 'p1' } });
  });

  it('awaits async predicates', async () => {
    const inner = async () => buildAccount();
    const wrapped = composeMethod(
      inner,
      requireAccountMatch(async () => {
        await new Promise(resolve => setImmediate(resolve));
        return false;
      })
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result, null);
  });
});

describe('requireAdvertiserMatch (#1339)', () => {
  it('allows accounts whose advertiser is in the roster', async () => {
    const inner = async () => buildAccount({ advertiser: 'acme.com' });
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(() => ['nike.com', 'acme.com'])
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result.advertiser, 'acme.com');
  });

  it('denies accounts whose advertiser is not in the roster', async () => {
    const inner = async () => buildAccount({ advertiser: 'evil.com' });
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(() => ['acme.com'])
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result, null);
  });

  it('denies accounts with no advertiser set', async () => {
    const inner = async () => buildAccount();
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(() => ['acme.com'])
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result, null);
  });

  it('threads ctx into the roster getter for per-principal rosters', async () => {
    const rosterByAgent = {
      agent_a: ['acme.com'],
      agent_b: ['nike.com'],
    };
    const inner = async () => buildAccount({ advertiser: 'acme.com' });
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(ctx => rosterByAgent[ctx?.agent?.id ?? ''] ?? [])
    );

    const okResult = await wrapped({ account_id: 'acc_1' }, { agent: { id: 'agent_a' } });
    assert.strictEqual(okResult?.advertiser, 'acme.com');

    const denyResult = await wrapped({ account_id: 'acc_1' }, { agent: { id: 'agent_b' } });
    assert.strictEqual(denyResult, null);

    const noAgentResult = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(noAgentResult, null);
  });

  it('accepts an async roster getter', async () => {
    const inner = async () => buildAccount({ advertiser: 'acme.com' });
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(async () => new Set(['acme.com']))
    );
    const result = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(result?.advertiser, 'acme.com');
  });

  it('throws PermissionDeniedError on deny when configured', async () => {
    const inner = async () => buildAccount({ advertiser: 'evil.com' });
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(() => ['acme.com'], { onDeny: 'throw', action: 'advertiser.gate' })
    );
    await assert.rejects(
      () => wrapped({ account_id: 'acc_1' }, {}),
      err => {
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(err.details?.action, 'advertiser.gate');
        return true;
      }
    );
  });

  it('still propagates null from inner without invoking the roster getter', async () => {
    const inner = async () => null;
    let rosterCalled = false;
    const wrapped = composeMethod(
      inner,
      requireAdvertiserMatch(() => {
        rosterCalled = true;
        return ['acme.com'];
      })
    );
    const result = await wrapped({ account_id: 'unknown' }, {});
    assert.strictEqual(result, null);
    assert.strictEqual(rosterCalled, false);
  });
});

describe('requireOrgScope (#1339)', () => {
  it('allows when account-org and ctx-org match', async () => {
    const inner = async () => buildAccount({ ctx_metadata: { orgId: 'org_42' } });
    const wrapped = composeMethod(
      inner,
      requireOrgScope(
        account => account.ctx_metadata.orgId,
        ctx => ctx?.authInfo?.extra?.orgId
      )
    );
    const result = await wrapped({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', extra: { orgId: 'org_42' } } });
    assert.strictEqual(result?.id, 'acc_1');
  });

  it('denies when ctx-org and account-org disagree', async () => {
    const inner = async () => buildAccount({ ctx_metadata: { orgId: 'org_42' } });
    const wrapped = composeMethod(
      inner,
      requireOrgScope(
        account => account.ctx_metadata.orgId,
        ctx => ctx?.authInfo?.extra?.orgId
      )
    );
    const result = await wrapped(
      { account_id: 'acc_1' },
      { authInfo: { kind: 'oauth', extra: { orgId: 'org_other' } } }
    );
    assert.strictEqual(result, null);
  });

  it('denies when either side is undefined', async () => {
    const inner = async () => buildAccount({ ctx_metadata: { orgId: 'org_42' } });
    const wrapped = composeMethod(
      inner,
      requireOrgScope(
        account => account.ctx_metadata.orgId,
        ctx => ctx?.authInfo?.extra?.orgId
      )
    );

    const noCtxOrg = await wrapped({ account_id: 'acc_1' }, {});
    assert.strictEqual(noCtxOrg, null);

    const innerNoOrg = async () => buildAccount({ ctx_metadata: {} });
    const wrappedNoAcct = composeMethod(
      innerNoOrg,
      requireOrgScope(
        account => account.ctx_metadata.orgId,
        ctx => ctx?.authInfo?.extra?.orgId
      )
    );
    const noAcctOrg = await wrappedNoAcct(
      { account_id: 'acc_1' },
      { authInfo: { kind: 'oauth', extra: { orgId: 'org_42' } } }
    );
    assert.strictEqual(noAcctOrg, null);
  });
});

describe('resolve-presets composition (#1339)', () => {
  it('layers naturally inside a real DecisioningPlatform.accounts.resolve shape', async () => {
    // Realistic shape: base resolves by ref into a per-tenant DB,
    // requireAdvertiserMatch enforces the configured advertiser roster.
    const db = {
      acc_1: buildAccount({ id: 'acc_1', advertiser: 'acme.com' }),
      acc_2: buildAccount({ id: 'acc_2', advertiser: 'evil.com' }),
    };
    const baseResolve = async ref => (ref?.account_id ? (db[ref.account_id] ?? null) : null);
    const tenantRoster = ['acme.com'];

    const resolve = composeMethod(
      baseResolve,
      requireAdvertiserMatch(() => tenantRoster)
    );

    assert.strictEqual((await resolve({ account_id: 'acc_1' }, {}))?.advertiser, 'acme.com');
    assert.strictEqual(await resolve({ account_id: 'acc_2' }, {}), null);
    assert.strictEqual(await resolve({ account_id: 'unknown' }, {}), null);
  });
});
