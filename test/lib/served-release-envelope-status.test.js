// Envelope `status` follows the release the caller is served, and strict response
// validation runs against that release's rules. The 3.2 `decline_proposals` sync
// arm forbids `status`; its async arm requires `{status: 'submitted', task_id}`.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
const { ADCP_VERSION } = require('../../dist/lib/index.js');
const { toReleasePrecisionVersion } = require('../../dist/lib/version.js');

// A bare '3.3' pin may be served at 3.2, so the 3.3 caller pins the served release.
const SERVED = toReleasePrecisionVersion(ADCP_VERSION);
const AUTH = { authInfo: { token: 't', clientId: 'buyer-1', scopes: [], extra: { principal: 'buyer-1' } } };

let keySeq = 0;
const idemKey = () => `idem-key-${process.pid}-${Date.now()}-${keySeq++}-abcdefgh`;

function buildServer({ declineProposals, listProducts, responses = 'strict' }) {
  return createAdcpServer({
    name: 'served-release-envelope-status',
    version: '1.0.0',
    adcpVersion: ADCP_VERSION,
    stateStore: new InMemoryStateStore(),
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
    resolveIdempotencyPrincipal: () => 'p1',
    validation: { requests: 'off', responses },
    resolveAccount: async ref => ({ id: ref?.account_id ?? 'a' }),
    mediaBuy: {
      getProducts: async () => ({ products: [] }),
      ...(listProducts ? { listProducts } : {}),
      declineProposals: declineProposals ?? (async () => ({ results: [] })),
    },
  });
}

const call = (server, name, args) =>
  server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } }, AUTH);

const decline = (server, pin) =>
  call(server, 'decline_proposals', { adcp_version: pin, proposal_ids: ['prop_1'], idempotency_key: idemKey() });

function assertNoError(res) {
  assert.notEqual(res.isError, true, `unexpected error: ${JSON.stringify(res.structuredContent)}`);
  assert.equal(res.structuredContent?.adcp_error, undefined);
}

describe('decline_proposals envelope status at the served release', () => {
  const outcomes = [
    ['declined', { proposal_id: 'prop_1', outcome: 'declined' }],
    ['unable with reason', { proposal_id: 'prop_1', outcome: 'unable', reason: 'already_accepted' }],
  ];

  for (const responses of ['strict', 'off']) {
    for (const [label, result] of outcomes) {
      it(`3.2 pin: ${label} sync arm carries no status (responses: ${responses})`, async () => {
        const server = buildServer({ responses, declineProposals: async () => ({ results: [result] }) });
        const res = await decline(server, '3.2');
        assertNoError(res);
        const sc = res.structuredContent;
        assert.equal('status' in sc, false, `3.2 sync arm must omit status: ${JSON.stringify(sc)}`);
        assert.equal(sc.adcp_version, '3.2');
        assert.deepEqual(sc.results, [result]);
        const check = validateResponse('decline_proposals', sc, '3.2');
        assert.equal(check.valid, true, JSON.stringify(check.issues));
      });
    }
  }

  it('3.3 pin: sync response keeps status completed and is valid at the served release', async () => {
    const server = buildServer({
      declineProposals: async () => ({ results: [{ proposal_id: 'prop_1', outcome: 'declined' }] }),
    });
    const res = await decline(server, SERVED);
    assertNoError(res);
    assert.equal(res.structuredContent.status, 'completed');
    const check = validateResponse('decline_proposals', res.structuredContent, ADCP_VERSION);
    assert.equal(check.valid, true, JSON.stringify(check.issues));
  });

  for (const [label, pin, release] of [
    ['3.2 pin', '3.2', '3.2'],
    ['3.3 pin', SERVED, ADCP_VERSION],
  ]) {
    it(`submitted decline keeps status and task_id (${label})`, async () => {
      const server = buildServer({ declineProposals: async () => ({ status: 'submitted', task_id: 'task_1' }) });
      const res = await decline(server, pin);
      assertNoError(res);
      const sc = res.structuredContent;
      assert.equal(sc.status, 'submitted');
      assert.equal(sc.task_id, 'task_1');
      const check = validateResponse('decline_proposals', sc, release);
      assert.equal(check.valid, true, JSON.stringify(check.issues));
    });
  }

  it('3.2 pin: submitted decline is identical with response validation off', async () => {
    const server = buildServer({
      responses: 'off',
      declineProposals: async () => ({ status: 'submitted', task_id: 'task_1' }),
    });
    const sc = (await decline(server, '3.2')).structuredContent;
    assert.equal(sc.status, 'submitted');
    assert.equal(sc.task_id, 'task_1');
  });
});

describe('list_products envelope status at the served release (regression guard)', () => {
  const body = { outcome: 'listed', products: [], feed_version: 'v1', cache_scope: 'public' };

  it('3.2 pin carries no status', async () => {
    const res = await call(buildServer({ listProducts: async () => body }), 'list_products', { adcp_version: '3.2' });
    assertNoError(res);
    assert.equal('status' in res.structuredContent, false);
  });

  it('3.3 pin carries status completed', async () => {
    const res = await call(buildServer({ listProducts: async () => body }), 'list_products', { adcp_version: SERVED });
    assertNoError(res);
    assert.equal(res.structuredContent.status, 'completed');
  });
});
