const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createTenantStore, narrowAccountRef } = require('../../dist/lib/server/decisioning/index.js');

// ── Test fixtures ──────────────────────────────────────────────────────────

const TENANTS = new Map([
  ['t_pinnacle', { id: 't_pinnacle', display_name: 'Pinnacle' }],
  ['t_meridian', { id: 't_meridian', display_name: 'Meridian' }],
]);

const OPERATOR_TO_TENANT = new Map([
  ['pinnacle.example', 't_pinnacle'],
  ['meridian.example', 't_meridian'],
]);

const PRINCIPAL_TO_TENANT = new Map([
  ['buyer@pinnacle', 't_pinnacle'],
  ['buyer@meridian', 't_meridian'],
]);

function tenantFromOperator(operator) {
  const id = OPERATOR_TO_TENANT.get(operator);
  return id ? (TENANTS.get(id) ?? null) : null;
}

function tenantFromPrincipal(principal) {
  if (!principal) return null;
  const id = PRINCIPAL_TO_TENANT.get(principal);
  return id ? (TENANTS.get(id) ?? null) : null;
}

function buildStore(opts = {}) {
  const cfg = {
    resolveByRef: ref => {
      const r = ref ?? {};
      if (r.account_id) {
        // For tests, account_id starts with "t_pinnacle:" / "t_meridian:" prefix
        const tid = String(r.account_id).split(':')[0];
        return TENANTS.get(tid) ?? null;
      }
      return tenantFromOperator(r.operator);
    },
    resolveFromAuth: ctx => tenantFromPrincipal(ctx?.authInfo?.credential?.principal),
    tenantId: t => t.id,
    tenantToAccount: (tenant, ref) => ({
      id: tenant.id,
      name: tenant.display_name,
      status: 'active',
      operator: ref?.operator ?? 'derived',
      sandbox: ref?.sandbox ?? false,
    }),
    ...opts,
  };
  return createTenantStore(cfg);
}

function ctxWith(principal) {
  return { authInfo: { credential: { principal } } };
}

// ── resolve ────────────────────────────────────────────────────────────────

describe('createTenantStore — resolve', () => {
  test('Path 1: operator ref → tenant', async () => {
    const store = buildStore();
    const acc = await store.resolve(
      { brand: { domain: 'acme.example' }, operator: 'pinnacle.example' },
      ctxWith('buyer@pinnacle')
    );
    assert.equal(acc.id, 't_pinnacle');
  });

  test('Path 2: no ref → resolveFromAuth (auth-derived tenant)', async () => {
    const store = buildStore();
    const acc = await store.resolve(undefined, ctxWith('buyer@pinnacle'));
    assert.equal(acc.id, 't_pinnacle');
  });

  test('returns null when ref is unknown', async () => {
    const store = buildStore();
    const acc = await store.resolve(
      { operator: 'unknown.example', brand: { domain: 'x.example' } },
      ctxWith('buyer@pinnacle')
    );
    assert.equal(acc, null);
  });

  test('returns null when auth principal is unknown', async () => {
    const store = buildStore();
    const acc = await store.resolve(undefined, ctxWith('not-registered'));
    assert.equal(acc, null);
  });

  test('threads sandbox flag through the projector', async () => {
    const store = buildStore();
    const acc = await store.resolve(
      { brand: { domain: 'acme.example' }, operator: 'pinnacle.example', sandbox: true },
      ctxWith('buyer@pinnacle')
    );
    assert.equal(acc.sandbox, true);
  });
});

// ── upsert (sync_accounts) — tenant-isolation gate ─────────────────────────

describe('createTenantStore — upsert tenant-isolation gate', () => {
  function buildWithUpsert() {
    const writes = [];
    const store = buildStore({
      upsertRow: (tenant, ref, _ctx) => {
        writes.push({ tenant: tenant.id, ref });
        return {
          brand: ref.brand,
          operator: ref.operator,
          action: 'created',
          status: 'active',
        };
      },
    });
    return { store, writes };
  }

  test('passes through entries whose tenant matches auth tenant', async () => {
    const { store, writes } = buildWithUpsert();
    const rows = await store.upsert(
      [{ brand: { domain: 'acme.example' }, operator: 'pinnacle.example' }],
      ctxWith('buyer@pinnacle')
    );
    assert.equal(writes.length, 1);
    assert.equal(rows[0].action, 'created');
    assert.equal(rows[0].status, 'active');
  });

  test('rejects cross-tenant entry with PERMISSION_DENIED (Meridian cred / Pinnacle operator)', async () => {
    const { store, writes } = buildWithUpsert();
    const rows = await store.upsert(
      [{ brand: { domain: 'acme.example' }, operator: 'pinnacle.example' }],
      ctxWith('buyer@meridian')
    );
    assert.equal(writes.length, 0, 'upsertRow MUST NOT run for cross-tenant entries');
    assert.equal(rows[0].action, 'failed');
    assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[0].errors[0].code, 'PERMISSION_DENIED');
  });

  test('rejects unknown operator with ACCOUNT_NOT_FOUND, not PERMISSION_DENIED', async () => {
    const { store, writes } = buildWithUpsert();
    const rows = await store.upsert(
      [{ brand: { domain: 'x.example' }, operator: 'unknown.example' }],
      ctxWith('buyer@pinnacle')
    );
    assert.equal(writes.length, 0);
    assert.equal(rows[0].errors[0].code, 'ACCOUNT_NOT_FOUND');
  });

  test('fail-closed: unknown auth principal rejects every entry with PERMISSION_DENIED', async () => {
    const { store, writes } = buildWithUpsert();
    const rows = await store.upsert(
      [
        { brand: { domain: 'acme.example' }, operator: 'pinnacle.example' },
        { brand: { domain: 'beta.example' }, operator: 'meridian.example' },
      ],
      ctxWith('not-registered')
    );
    assert.equal(writes.length, 0);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.errors[0].code === 'PERMISSION_DENIED'));
  });

  test('mixed batch: in-tenant entries pass, cross-tenant fail, unknown ref ACCOUNT_NOT_FOUND', async () => {
    const { store, writes } = buildWithUpsert();
    const rows = await store.upsert(
      [
        { brand: { domain: 'a.example' }, operator: 'pinnacle.example' }, // pass
        { brand: { domain: 'b.example' }, operator: 'meridian.example' }, // cross-tenant
        { brand: { domain: 'c.example' }, operator: 'unknown.example' }, // unknown
      ],
      ctxWith('buyer@pinnacle')
    );
    assert.equal(writes.length, 1, 'only the in-tenant entry should reach upsertRow');
    assert.equal(rows[0].action, 'created');
    assert.equal(rows[1].errors[0].code, 'PERMISSION_DENIED');
    assert.equal(rows[2].errors[0].code, 'ACCOUNT_NOT_FOUND');
  });
});

// ── syncGovernance — tenant-isolation gate ─────────────────────────────────

describe('createTenantStore — syncGovernance tenant-isolation gate', () => {
  function buildWithSyncGov() {
    const writes = [];
    const store = buildStore({
      syncGovernanceRow: (tenant, entry, _ctx) => {
        writes.push({ tenant: tenant.id, entry });
        return {
          account: entry.account,
          status: 'synced',
          governance_agents: entry.governance_agents.map(a => ({ url: a.url })),
        };
      },
    });
    return { store, writes };
  }

  test('passes through in-tenant entries', async () => {
    const { store, writes } = buildWithSyncGov();
    const rows = await store.syncGovernance(
      [
        {
          account: { brand: { domain: 'acme.example' }, operator: 'pinnacle.example' },
          governance_agents: [
            { url: 'https://gov.example', authentication: { schemes: ['Bearer'], credentials: 'x' } },
          ],
        },
      ],
      ctxWith('buyer@pinnacle')
    );
    assert.equal(writes.length, 1);
    assert.equal(rows[0].status, 'synced');
  });

  test('rejects cross-tenant entry with PERMISSION_DENIED', async () => {
    const { store, writes } = buildWithSyncGov();
    const rows = await store.syncGovernance(
      [
        {
          account: { brand: { domain: 'acme.example' }, operator: 'pinnacle.example' },
          governance_agents: [],
        },
      ],
      ctxWith('buyer@meridian')
    );
    assert.equal(writes.length, 0);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].errors[0].code, 'PERMISSION_DENIED');
  });
});

// ── Optional callbacks ─────────────────────────────────────────────────────

describe('createTenantStore — optional callbacks', () => {
  test('upsert is undefined when upsertRow is not provided', () => {
    const store = buildStore();
    assert.equal(store.upsert, undefined);
    assert.equal(store.syncGovernance, undefined);
  });

  test('upsert is wired when upsertRow is provided', () => {
    const store = buildStore({ upsertRow: () => ({}) });
    assert.equal(typeof store.upsert, 'function');
    assert.equal(store.syncGovernance, undefined);
  });
});

// ── Security: gate methods are non-writable ────────────────────────────────

describe('createTenantStore — gate methods locked against override', () => {
  test('cannot reassign accounts.upsert (would bypass tenant gate)', () => {
    'use strict';
    const store = buildStore({ upsertRow: () => ({}) });
    assert.throws(
      () => {
        store.upsert = async () => [];
      },
      /Cannot assign to read only property/,
      'upsert MUST be non-writable to prevent silent gate bypass'
    );
  });

  test('cannot reassign accounts.syncGovernance', () => {
    'use strict';
    const store = buildStore({ syncGovernanceRow: () => ({}) });
    assert.throws(() => {
      store.syncGovernance = async () => [];
    }, /Cannot assign to read only property/);
  });

  test('list and other extensions still work via Object.assign', () => {
    const store = Object.assign(buildStore({ upsertRow: () => ({}) }), {
      list: async () => ({ items: [] }),
    });
    assert.equal(typeof store.list, 'function');
    assert.equal(typeof store.upsert, 'function');
  });
});

// ── narrowAccountRef helper ────────────────────────────────────────────────

describe('narrowAccountRef', () => {
  test('reads operator + brand from the (brand, operator) arm', () => {
    const r = narrowAccountRef({ brand: { domain: 'acme.example' }, operator: 'pinnacle.example' });
    assert.equal(r.operator, 'pinnacle.example');
    assert.equal(r.brand.domain, 'acme.example');
    assert.equal(r.account_id, undefined);
  });

  test('reads account_id from the {account_id} arm', () => {
    const r = narrowAccountRef({ account_id: 'acct_123' });
    assert.equal(r.account_id, 'acct_123');
    assert.equal(r.operator, undefined);
  });

  test('threads sandbox flag through both arms', () => {
    const r = narrowAccountRef({ account_id: 'acct_123', sandbox: true });
    assert.equal(r.sandbox, true);
  });

  test('returns undefined for undefined input (no-account-tool path)', () => {
    assert.equal(narrowAccountRef(undefined), undefined);
  });
});

// ── Concurrency: sequential per-entry callbacks ────────────────────────────

describe('createTenantStore — sequential per-entry execution', () => {
  test('upsertRow callbacks run in input order, not in parallel', async () => {
    const observed = [];
    const store = buildStore({
      upsertRow: async (_tenant, ref, _ctx) => {
        observed.push(`start:${ref.brand.domain}`);
        await new Promise(r => setTimeout(r, 1));
        observed.push(`end:${ref.brand.domain}`);
        return { brand: ref.brand, operator: ref.operator, action: 'created', status: 'active' };
      },
    });
    await store.upsert(
      [
        { brand: { domain: 'a.example' }, operator: 'pinnacle.example' },
        { brand: { domain: 'b.example' }, operator: 'pinnacle.example' },
      ],
      ctxWith('buyer@pinnacle')
    );
    assert.deepEqual(observed, ['start:a.example', 'end:a.example', 'start:b.example', 'end:b.example']);
  });
});
