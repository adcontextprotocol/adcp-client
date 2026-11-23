// AdCP 3.1 renamed each task's decision off top-level `status`. A response
// converted down to a 3.0 caller must carry the decision in `status`
// (adcp-client#3743).

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { downgradeResponse } = require('../../dist/lib/adapters/version/index.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
const { ADCP_VERSION, adcpError } = require('../../dist/lib/index.js');
const { toReleasePrecisionVersion } = require('../../dist/lib/version.js');

// A bare '3.3' pin may be served at 3.2, so the 3.3 caller pins the served release.
const SERVED = toReleasePrecisionVersion(ADCP_VERSION);
const AUTH = { authInfo: { token: 't', clientId: 'buyer-1', scopes: [], extra: { principal: 'buyer-1' } } };

let keySeq = 0;
const newKey = () => `idem-key-${String(++keySeq).padStart(8, '0')}-abcdef`;

function buildServer(adcpVersion, handlers) {
  return createAdcpServer({
    stateStore: new InMemoryStateStore(),
    name: 'decision status 3.0',
    version: '1.0.0',
    adcpVersion,
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
    validation: { requests: 'off', responses: 'strict' },
    resolveIdempotencyPrincipal: () => 'principal-1',
    resolveAccount: async ref => ({ id: ref?.account_id ?? 'a' }),
    ...handlers,
  });
}

const call = (server, name, args) =>
  server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } }, AUTH);

const FINDING = { category_id: 'budget_compliance', severity: 'critical', explanation: 'Over budget.' };
const EXPIRES = '2030-01-01T00:00:00Z';

const CHECK_BODIES = {
  approved: { expires_at: EXPIRES },
  denied: { findings: [FINDING] },
  conditions: {
    conditions: [{ field: 'payload.total_budget.amount', required_value: 100, reason: 'Lower the budget.' }],
    expires_at: EXPIRES,
  },
};

const checkBody = verdict => ({
  check_id: 'chk_1',
  plan_id: 'plan_1',
  verdict,
  explanation: `Governance says ${verdict}.`,
  ...CHECK_BODIES[verdict],
});

const checkGovernanceServer = (adcpVersion, verdict) =>
  buildServer(adcpVersion, { governance: { checkGovernance: async () => checkBody(verdict) } });

const checkArgs = version => ({
  adcp_version: version,
  plan_id: 'plan_1',
  caller: 'https://buyer.example.com',
  tool: 'create_media_buy',
  idempotency_key: newKey(),
});

describe('check_governance verdict through createAdcpServer', () => {
  const ceilings = [
    ['3.3 preview ceiling', ADCP_VERSION],
    ['3.2 stable ceiling', '3.2'],
  ];

  for (const [label, ceiling] of ceilings) {
    for (const verdict of ['approved', 'denied', 'conditions']) {
      it(`${verdict}: a 3.0 caller reads it from status (${label})`, async () => {
        const res = await call(checkGovernanceServer(ceiling, verdict), 'check_governance', checkArgs('3.0'));
        assert.ok(!res.isError, JSON.stringify(res.structuredContent));
        const sc = res.structuredContent;
        assert.equal(sc.status, verdict);
        assert.equal('verdict' in sc, false);
        const result = validateResponse('check_governance', sc, '3.0');
        assert.equal(result.valid, true, JSON.stringify(result.issues));
      });
    }
  }

  const callers = [
    ['3.1', '3.1'],
    ['3.2', '3.2'],
    ['3.3', SERVED],
  ];
  for (const [label, pin] of callers) {
    for (const verdict of ['approved', 'denied', 'conditions']) {
      it(`${verdict}: a ${label} caller keeps verdict and task status completed`, async () => {
        const res = await call(checkGovernanceServer(ADCP_VERSION, verdict), 'check_governance', checkArgs(pin));
        assert.ok(!res.isError, JSON.stringify(res.structuredContent));
        const sc = res.structuredContent;
        assert.equal(sc.verdict, verdict);
        assert.equal(sc.status, 'completed');
        const release = label === '3.3' ? ADCP_VERSION : label;
        const result = validateResponse('check_governance', sc, release);
        assert.equal(result.valid, true, JSON.stringify(result.issues));
      });
    }
  }
});

describe('other decision tasks through createAdcpServer', () => {
  const outcomeServer = (state, extra = {}) =>
    buildServer(ADCP_VERSION, {
      governance: { reportPlanOutcome: async () => ({ outcome_id: 'out_1', outcome_state: state, ...extra }) },
    });
  const outcomeArgs = version => ({
    adcp_version: version,
    plan_id: 'plan_1',
    check_id: 'chk_1',
    outcome: 'completed',
    idempotency_key: newKey(),
  });

  for (const state of ['accepted', 'findings']) {
    const extra = state === 'findings' ? { findings: [FINDING] } : {};
    it(`report_plan_outcome ${state}: 3.0 reads status, ${SERVED} keeps outcome_state`, async () => {
      const at30 = await call(outcomeServer(state, extra), 'report_plan_outcome', outcomeArgs('3.0'));
      assert.ok(!at30.isError, JSON.stringify(at30.structuredContent));
      assert.equal(at30.structuredContent.status, state);
      assert.equal('outcome_state' in at30.structuredContent, false);
      const valid = validateResponse('report_plan_outcome', at30.structuredContent, '3.0');
      assert.equal(valid.valid, true, JSON.stringify(valid.issues));

      const at33 = await call(outcomeServer(state, extra), 'report_plan_outcome', outcomeArgs(SERVED));
      assert.equal(at33.structuredContent.outcome_state, state);
      assert.equal(at33.structuredContent.status, 'completed');
    });
  }

  const RIGHTS = {
    pending_approval: { detail: 'Needs talent sign-off.', estimated_response_time: '48h' },
    rejected: { reason: 'Not available.', suggestions: ['Try another market.'] },
  };
  const rightsServer = rightsStatus =>
    buildServer(ADCP_VERSION, {
      brandRights: {
        acquireRights: async () => ({
          rights_id: 'rt_1',
          rights_status: rightsStatus,
          brand_id: 'brand_1',
          ...RIGHTS[rightsStatus],
        }),
      },
    });
  const rightsArgs = version => ({
    adcp_version: version,
    rights_id: 'rt_1',
    buyer: { domain: 'buyer.example.com' },
    campaign: { description: 'x', uses: ['likeness'] },
    revocation_webhook: { url: 'https://buyer.example.com/hook', authentication: { schemes: ['HMAC-SHA256'] } },
    idempotency_key: newKey(),
  });

  for (const rightsStatus of ['pending_approval', 'rejected']) {
    it(`acquire_rights ${rightsStatus}: 3.0 reads status, ${SERVED} keeps rights_status`, async () => {
      const at30 = await call(rightsServer(rightsStatus), 'acquire_rights', rightsArgs('3.0'));
      const sc = at30.structuredContent;
      assert.equal(sc.status, rightsStatus, JSON.stringify(sc));
      assert.equal('rights_status' in sc, false);
      assert.ok(!at30.isError, JSON.stringify(sc));
      const valid = validateResponse('acquire_rights', sc, '3.0');
      assert.equal(valid.valid, true, JSON.stringify(valid.issues));

      const at33 = await call(rightsServer(rightsStatus), 'acquire_rights', rightsArgs(SERVED));
      assert.equal(at33.structuredContent.rights_status, rightsStatus);
      assert.equal(at33.structuredContent.status, 'completed');
    });
  }

  const auditPlans = () => [
    {
      plan_id: 'plan_1',
      plan_version: 1,
      status: 'active',
      budget: { authorized: 100 },
      governed_actions: [],
      summary: { checks_performed: 2, outcomes_reported: 0 },
      entries: [
        { id: 'e1', type: 'check', timestamp: '2030-01-01T00:00:00Z', verdict: 'approved' },
        { id: 'e2', type: 'check', timestamp: '2030-01-01T00:01:00Z', verdict: 'denied' },
        { id: 'e3', type: 'outcome', timestamp: '2030-01-01T00:02:00Z' },
      ],
    },
  ];
  const auditServer = () =>
    buildServer(ADCP_VERSION, { governance: { getPlanAuditLogs: async () => ({ plans: auditPlans() }) } });
  const auditArgs = version => ({ adcp_version: version, plan_ids: ['plan_1'], include_entries: true });

  it(`get_plan_audit_logs: 3.0 entries read status, ${SERVED} keeps verdict`, async () => {
    const at30 = await call(auditServer(), 'get_plan_audit_logs', auditArgs('3.0'));
    assert.ok(!at30.isError, JSON.stringify(at30.structuredContent));
    const [plan] = at30.structuredContent.plans;
    assert.equal(plan.status, 'active');
    assert.deepEqual(
      plan.entries.map(e => e.status),
      ['approved', 'denied', undefined]
    );
    assert.equal(
      plan.entries.some(e => 'verdict' in e),
      false
    );
    const valid = validateResponse('get_plan_audit_logs', at30.structuredContent, '3.0');
    assert.equal(valid.valid, true, JSON.stringify(valid.issues));

    const at33 = await call(auditServer(), 'get_plan_audit_logs', auditArgs(SERVED));
    assert.deepEqual(
      at33.structuredContent.plans[0].entries.map(e => e.verdict),
      ['approved', 'denied', undefined]
    );
  });
});

describe('3.0 decision-status adapters', () => {
  const down = (tool, data) => downgradeResponse(tool, data, { fromVersion: ADCP_VERSION, toVersion: '3.0' });
  const DECISIONS = [
    ['check_governance', 'verdict', 'denied'],
    ['report_plan_outcome', 'outcome_state', 'findings'],
    ['acquire_rights', 'rights_status', 'acquired'],
  ];

  for (const [tool, field, value] of DECISIONS) {
    it(`${tool}: moves ${field} into status and reports drift`, () => {
      const input = { [field]: value, status: 'completed', other: 1 };
      const { data, drifts } = down(tool, input);
      assert.equal(data.status, value);
      assert.equal(field in data, false);
      assert.equal(data.other, 1);
      const drift = drifts.find(d => d.type === 'pre31_decision_status_moved');
      assert.ok(drift, JSON.stringify(drifts));
      assert.deepEqual(drift.movedFields, [{ from: field, to: 'status' }]);
    });

    it(`${tool}: moves the decision when status is absent`, () => {
      const { data } = down(tool, { [field]: value });
      assert.equal(data.status, value);
    });

    it(`${tool}: strips a completed status when there is no decision`, () => {
      const { data, drifts } = down(tool, { status: 'completed', other: 1 });
      assert.equal('status' in data, false);
      assert.equal(data.other, 1);
      const drift = drifts.find(d => d.type === 'pre31_task_status_stripped');
      assert.ok(drift, JSON.stringify(drifts));
      assert.deepEqual(drift.strippedFields, ['status']);
    });

    for (const status of ['submitted', 'failed']) {
      it(`${tool}: leaves status ${status} alone`, () => {
        const input = { status, [field]: value };
        const { data, drifts } = down(tool, input);
        // Projection onto the 3.0 schema still drops the undeclared 3.1 field.
        assert.equal(data.status, status);
        assert.equal(
          drifts.some(d => d.type === 'pre31_decision_status_moved' || d.type === 'pre31_task_status_stripped'),
          false
        );
      });
    }

    it(`${tool}: does not mutate its input`, () => {
      const input = { [field]: value, status: 'completed' };
      const snapshot = structuredClone(input);
      down(tool, input);
      assert.deepEqual(input, snapshot);
    });
  }

  it('get_plan_audit_logs: reports each moved entry verdict and leaves other statuses', () => {
    const input = {
      plans: [
        {
          plan_id: 'p',
          status: 'active',
          entries: [
            { id: 'a', verdict: 'approved' },
            { id: 'b', verdict: 'denied', status: 'failed' },
            { id: 'c', verdict: 'conditions', status: 'completed' },
          ],
        },
      ],
    };
    const snapshot = structuredClone(input);
    const { data, drifts } = down('get_plan_audit_logs', input);
    assert.deepEqual(input, snapshot);
    const [a, b, c] = data.plans[0].entries;
    assert.equal(a.status, 'approved');
    assert.equal(c.status, 'conditions');
    assert.equal(b.status, 'failed');
    assert.equal(data.plans[0].status, 'active');
    const drift = drifts.find(d => d.type === 'pre31_decision_status_moved');
    assert.deepEqual(drift.movedFields, [
      { from: 'plans[0].entries[0].verdict', to: 'plans[0].entries[0].status' },
      { from: 'plans[0].entries[2].verdict', to: 'plans[0].entries[2].status' },
    ]);
  });

  it('get_plan_audit_logs: returns the same reference when no entry has a verdict', () => {
    const input = { plans: [{ plan_id: 'p', status: 'active', entries: [{ id: 'o', type: 'outcome' }] }] };
    const { data } = down('get_plan_audit_logs', input);
    assert.equal(data, input);
  });
});

describe('a 3.0 decision status is a result, not a failed task', () => {
  const REJECTED = { rights_id: 'rt_1', brand_id: 'brand_1', rights_status: 'rejected', reason: 'Not available.' };
  const rightsArgs = (version, key) => ({
    adcp_version: version,
    rights_id: 'rt_1',
    buyer: { domain: 'buyer.example.com' },
    campaign: { description: 'x', uses: ['likeness'] },
    revocation_webhook: { url: 'https://buyer.example.com/hook', authentication: { schemes: ['HMAC-SHA256'] } },
    idempotency_key: key,
  });
  const rejectedRightsServer = (calls, body = REJECTED) =>
    buildServer(ADCP_VERSION, {
      brandRights: {
        acquireRights: async () => {
          calls.n++;
          return body;
        },
      },
    });

  for (const [label, pin, field] of [
    ['3.0', '3.0', 'status'],
    [SERVED, SERVED, 'rights_status'],
  ]) {
    it(`acquire_rights rejected at ${label}: a same-key retry replays without re-running the handler`, async () => {
      const calls = { n: 0 };
      const server = rejectedRightsServer(calls);
      const args = rightsArgs(pin, newKey());
      const first = await call(server, 'acquire_rights', args);
      const second = await call(server, 'acquire_rights', args);
      assert.equal(calls.n, 1);
      assert.notEqual(first.structuredContent.replayed, true);
      assert.equal(second.structuredContent.replayed, true, JSON.stringify(second.structuredContent));
      assert.equal(first.structuredContent[field], 'rejected');
      assert.equal(second.structuredContent[field], 'rejected');
    });
  }

  for (const [label, pin] of [
    ['3.0', '3.0'],
    [SERVED, SERVED],
  ]) {
    it(`acquire_rights rejected without reason is a VALIDATION_ERROR at ${label}`, async () => {
      const { reason: _reason, ...noReason } = REJECTED;
      const res = await call(rejectedRightsServer({ n: 0 }, noReason), 'acquire_rights', rightsArgs(pin, newKey()));
      assert.equal(res.isError, true, JSON.stringify(res.structuredContent));
      assert.equal(res.structuredContent.adcp_error?.code, 'VALIDATION_ERROR', JSON.stringify(res.structuredContent));
    });
  }

  const mediaBuyServer = (calls, create) =>
    buildServer(ADCP_VERSION, {
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => {
          calls.n++;
          return create();
        },
      },
    });
  const createArgs = (version, key) => ({
    adcp_version: version,
    account: { account_id: 'acc_1' },
    promoted_offering: 'x',
    packages: [],
    idempotency_key: key,
  });

  it('create_media_buy rejected at 3.0: wire status is rejected and a same-key retry replays', async () => {
    const calls = { n: 0 };
    const server = mediaBuyServer(calls, () => ({
      media_buy_id: 'mb_1',
      media_buy_status: 'rejected',
      confirmed_at: '2026-04-29T00:00:00Z',
      revision: 1,
      packages: [],
    }));
    const args = createArgs('3.0', newKey());
    const first = await call(server, 'create_media_buy', args);
    const second = await call(server, 'create_media_buy', args);
    assert.equal(first.structuredContent.status, 'rejected', JSON.stringify(first.structuredContent));
    assert.equal(second.structuredContent.status, 'rejected');
    assert.equal(calls.n, 1);
    assert.equal(second.structuredContent.replayed, true, JSON.stringify(second.structuredContent));
  });

  it('a real error at 3.0 is not cached: a same-key retry runs the handler again', async () => {
    const calls = { n: 0 };
    const server = buildServer(ADCP_VERSION, {
      brandRights: {
        acquireRights: async () => {
          calls.n++;
          return adcpError('POLICY_VIOLATION', { message: 'no', recovery: 'terminal' });
        },
      },
    });
    const args = rightsArgs('3.0', newKey());
    const first = await call(server, 'acquire_rights', args);
    const second = await call(server, 'acquire_rights', args);
    assert.equal(first.isError, true);
    assert.equal(second.isError, true);
    assert.equal(first.structuredContent.adcp_error.code, 'POLICY_VIOLATION');
    assert.equal(calls.n, 2);
    assert.notEqual(second.structuredContent.replayed, true);
  });
});

describe('an error is never cached as an idempotent result', () => {
  const TRANSIENT = {
    content: [{ type: 'text', text: 'Upstream is offline.' }],
    structuredContent: {
      errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Upstream is offline.', recovery: 'transient' }],
    },
  };
  const createArgs = (version, key) => ({
    adcp_version: version,
    account: { account_id: 'acc_1' },
    promoted_offering: 'x',
    packages: [],
    idempotency_key: key,
  });
  const serverWith = (calls, create, extra = {}) =>
    buildServer(ADCP_VERSION, {
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => {
          calls.n++;
          return create();
        },
      },
      ...extra,
    });

  for (const [label, pin] of [
    ['3.0', '3.0'],
    [SERVED, SERVED],
  ]) {
    it(`create_media_buy at ${label}: a formatted payload-only Error arm runs again on a same-key retry`, async () => {
      const calls = { n: 0 };
      const server = serverWith(calls, () => TRANSIENT);
      const args = createArgs(pin, newKey());
      const first = await call(server, 'create_media_buy', args);
      const second = await call(server, 'create_media_buy', args);
      assert.equal(calls.n, 2, JSON.stringify(second.structuredContent));
      assert.notEqual(first.structuredContent.replayed, true);
      assert.notEqual(second.structuredContent.replayed, true);
    });
  }

  it('a responseEnhancer that sets isError on a success is not cached', async () => {
    const calls = { n: 0 };
    const server = serverWith(
      calls,
      () => ({
        media_buy_id: 'mb_1',
        media_buy_status: 'pending_creatives',
        confirmed_at: '2026-04-29T00:00:00Z',
        revision: 1,
        packages: [],
      }),
      {
        responseEnhancer: response => {
          response.isError = true;
        },
      }
    );
    const args = createArgs('3.0', newKey());
    const first = await call(server, 'create_media_buy', args);
    const second = await call(server, 'create_media_buy', args);
    assert.equal(calls.n, 2, JSON.stringify(second.structuredContent));
    assert.notEqual(first.structuredContent.replayed, true);
    assert.notEqual(second.structuredContent.replayed, true);
  });
});
