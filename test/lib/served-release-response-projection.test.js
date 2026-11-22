// DR-0024: a framework-built response conforms to the AdCP release it serves.
// Errors (`adcp_error`, `errors[]`), task-poll results and from-platform task
// webhooks are projected from the server's release to the caller's pinned one.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform');
const { AdcpError } = require('../../dist/lib/server/decisioning/index.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { projectErrorsForRelease } = require('../../dist/lib/server/error-release-projection.js');
const { projectToolPayload } = require('../../dist/lib/adapters/version/index.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
const { ADCP_VERSION, adcpError } = require('../../dist/lib/index.js');
const { toReleasePrecisionVersion } = require('../../dist/lib/version.js');

// A bare '3.3' pin is served at 3.2, so the 3.3 caller pins the served release.
const SERVED = toReleasePrecisionVersion(ADCP_VERSION);
const BUYER_REASON = { code: 'X', message: 'y' };

/** Payload conforms to `release`: nothing the release lacks, and schema-valid. */
function assertConformsToRelease(tool, payload, release) {
  const { dropped } = projectToolPayload(tool, 'sync', payload, ADCP_VERSION, release);
  assert.deepEqual(dropped, [], `${tool} payload carries fields ${release} does not declare`);
  const result = validateResponse(tool, payload, release);
  assert.equal(result.valid, true, `${tool} payload invalid at ${release}: ${JSON.stringify(result.issues)}`);
}

const flush = async () => {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function platformWith(createMediaBuy) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'acc_1',
        name: 'Acme',
        status: 'active',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy,
      updateMediaBuy: async () => ({ media_buy_id: 'mb_42', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

function buildPlatformServer(createMediaBuy) {
  const calls = [];
  const events = [];
  const server = createAdcpServerFromPlatform(platformWith(createMediaBuy), {
    name: 'served-release-projection',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    taskWebhookEmitter: {
      emit: async p => (calls.push(p), { delivered: true }),
      unsigned: true,
    },
    allowPrivateWebhookUrls: true,
    onVersionTranslation: e => events.push(e),
  });
  return { server, calls, events };
}

let keySeq = 0;
const newKey = () => `idem-key-${String(++keySeq).padStart(8, '0')}-abcdef`;

function createArgs(version, extra = {}) {
  return {
    adcp_version: version,
    account: { account_id: 'acc_1' },
    promoted_offering: 'x',
    packages: [],
    idempotency_key: newKey(),
    ...extra,
  };
}

const call = (server, name, args) =>
  server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } });

const PUSH = { url: 'https://buyer.example.com/wh', operation_id: 'op_1' };

const COMPLETED = {
  media_buy_id: 'mb_1',
  media_buy_status: 'pending_creatives',
  confirmed_at: '2026-04-29T00:00:00Z',
  revision: 1,
  packages: [
    {
      package_id: 'pk',
      targeting_overlay: { collection_lists: [{ agent_url: 'https://g.example', list_id: 'l' }] },
    },
  ],
};

const REJECT_ERRORS = [
  {
    code: 'POLICY_VIOLATION',
    message: 'no',
    mutation_outcome: 'not_applied',
    buyer_reason: BUYER_REASON,
  },
];

const withTaskResult = settle => (p, ctx) => ctx.handoffToTask(async taskCtx => settle(taskCtx));

describe('task completion webhook', () => {
  for (const version of ['3.2', '3.1']) {
    it(`a ${version} receiver gets a result without 3.3-only fields`, async () => {
      const { server, calls } = buildPlatformServer(withTaskResult(async () => COMPLETED));
      const res = await call(server, 'create_media_buy', createArgs(version, { push_notification_config: PUSH }));
      assert.notEqual(res.isError, true, JSON.stringify(res.structuredContent));
      await flush();
      assert.equal(calls.length, 1);
      const payload = calls[0].payload ?? calls[0];
      const result = payload.result;
      assert.ok(result, JSON.stringify(payload));
      assert.equal(result.packages[0].targeting_overlay?.collection_lists, undefined);
      assertConformsToRelease('create_media_buy', result, version);
      assert.equal(COMPLETED.packages[0].targeting_overlay.collection_lists.length, 1, 'input not mutated');
    });
  }

  it('a served-release receiver keeps 3.3-only fields', async () => {
    const { server, calls } = buildPlatformServer(withTaskResult(async () => COMPLETED));
    await call(server, 'create_media_buy', createArgs(SERVED, { push_notification_config: PUSH }));
    await flush();
    assert.equal(calls.length, 1);
    const payload = calls[0].payload ?? calls[0];
    assert.equal(payload.result.packages[0].targeting_overlay.collection_lists.length, 1);
  });
});

describe('task rejection and failure webhooks', () => {
  const rejecting = withTaskResult(async taskCtx => taskCtx.reject({ errors: REJECT_ERRORS }, 'no'));
  const failing = withTaskResult(async () => {
    throw new AdcpError('POLICY_VIOLATION', {
      message: 'no',
      recovery: 'terminal',
      buyer_reason: BUYER_REASON,
    });
  });

  async function webhookErrors(createMediaBuy, version) {
    const { server, calls } = buildPlatformServer(createMediaBuy);
    await call(server, 'create_media_buy', createArgs(version, { push_notification_config: PUSH }));
    await flush();
    assert.equal(calls.length, 1);
    const payload = calls[0].payload ?? calls[0];
    assert.ok(payload.result?.errors, JSON.stringify(payload));
    return payload.result.errors;
  }

  it('rejection at 3.2 drops mutation_outcome and keeps buyer_reason', async () => {
    const [error] = await webhookErrors(rejecting, '3.2');
    assert.equal(error.mutation_outcome, undefined);
    assert.deepEqual(error.buyer_reason, BUYER_REASON);
  });

  it('rejection at 3.1 drops mutation_outcome and buyer_reason', async () => {
    const [error] = await webhookErrors(rejecting, '3.1');
    assert.equal(error.mutation_outcome, undefined);
    assert.equal(error.buyer_reason, undefined);
    assert.equal(error.code, 'POLICY_VIOLATION');
  });

  it('rejection at the served release keeps both', async () => {
    const [error] = await webhookErrors(rejecting, SERVED);
    assert.equal(error.mutation_outcome, 'not_applied');
    assert.deepEqual(error.buyer_reason, BUYER_REASON);
  });

  it('thrown AdcpError failure keeps buyer_reason at 3.2 and drops it at 3.1', async () => {
    const [at32] = await webhookErrors(failing, '3.2');
    assert.deepEqual(at32.buyer_reason, BUYER_REASON);
    const [at31] = await webhookErrors(failing, '3.1');
    assert.equal(at31.buyer_reason, undefined);
    assert.equal(at31.code, 'POLICY_VIOLATION');
  });
});

describe('task polls for failed and rejected tasks', () => {
  async function settledTask(createMediaBuy, version) {
    const { server, events } = buildPlatformServer(createMediaBuy);
    const created = await call(server, 'create_media_buy', createArgs(version));
    const taskId = created.structuredContent?.task_id;
    assert.ok(taskId, JSON.stringify(created.structuredContent));
    await flush();
    const poll = async tool => {
      const args = { adcp_version: version, task_id: taskId, account: { account_id: 'acc_1' }, include_result: true };
      for (let i = 0; i < 20; i++) {
        const res = await call(server, tool, args);
        const body = res.structuredContent;
        if (body && (body.status === 'failed' || body.status === 'rejected')) return body;
        await sleep(10);
      }
      assert.fail(`${tool} never reached a terminal status`);
    };
    return { poll, events };
  }

  const rejecting = withTaskResult(async taskCtx => taskCtx.reject({ errors: REJECT_ERRORS }, 'no'));
  const failing = withTaskResult(async () => {
    throw new AdcpError('POLICY_VIOLATION', { message: 'no', recovery: 'terminal', buyer_reason: BUYER_REASON });
  });

  for (const tool of ['get_task_status', 'tasks_get']) {
    for (const [label, handler] of [
      ['rejected', rejecting],
      ['failed', failing],
    ]) {
      it(`${tool} at 3.2 on a ${label} task drops mutation_outcome and keeps buyer_reason`, async () => {
        const { poll } = await settledTask(handler, '3.2');
        const body = await poll(tool);
        const errors = body.result?.errors;
        assert.ok(errors?.length, JSON.stringify(body));
        assert.equal(errors[0].mutation_outcome, undefined);
        if (label === 'rejected') assert.deepEqual(errors[0].buyer_reason, BUYER_REASON);
      });

      it(`${tool} at 3.1 on a ${label} task drops buyer_reason too`, async () => {
        const { poll } = await settledTask(handler, '3.1');
        const body = await poll(tool);
        const errors = body.result?.errors;
        assert.ok(errors?.length, JSON.stringify(body));
        assert.equal(errors[0].mutation_outcome, undefined);
        assert.equal(errors[0].buyer_reason, undefined);
        assert.equal(body.error?.buyer_reason, undefined);
      });

      it(`${tool} at the served release on a ${label} task is unchanged`, async () => {
        const { poll, events } = await settledTask(handler, SERVED);
        const body = await poll(tool);
        const errors = body.result?.errors;
        assert.ok(errors?.length, JSON.stringify(body));
        if (label === 'rejected') {
          assert.equal(errors[0].mutation_outcome, 'not_applied');
          assert.deepEqual(errors[0].buyer_reason, BUYER_REASON);
        }
        assert.equal(events.length, 0);
      });
    }
  }

  it('get_task_status top-level error keeps buyer_reason at 3.2 and loses it at 3.1', async () => {
    const at32 = await (await settledTask(failing, '3.2')).poll('get_task_status');
    const at31 = await (await settledTask(failing, '3.1')).poll('get_task_status');
    if (at32.error?.buyer_reason !== undefined) assert.deepEqual(at32.error.buyer_reason, BUYER_REASON);
    assert.equal(at31.error?.buyer_reason, undefined);
    assert.equal(at31.error?.mutation_outcome, undefined);
  });
});

describe('error payloads through createAdcpServer', () => {
  function buildSeller(events, { createMediaBuy } = {}) {
    return createAdcpServer({
      stateStore: new InMemoryStateStore(),
      name: 'error projection',
      idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
      version: '1.0.0',
      adcpVersion: ADCP_VERSION,
      validation: { requests: 'off', responses: 'off' },
      onVersionTranslation: e => events.push(e),
      resolveIdempotencyPrincipal: () => 'principal-1',
      resolveAccount: async ref => ({ id: ref?.account_id ?? 'a' }),
      mediaBuy: {
        getProducts: async () =>
          adcpError('UNSUPPORTED_FEATURE', {
            message: 'nope',
            recovery: 'correctable',
            buyer_reason: BUYER_REASON,
            mutation_outcome: 'not_applied',
          }),
        ...(createMediaBuy ? { createMediaBuy } : {}),
      },
    });
  }

  const getProducts = (seller, version) =>
    call(seller, 'get_products', { adcp_version: version, buying_mode: 'brief', brief: 'x' });

  it('3.2 drops mutation_outcome from adcp_error and reports one drift event', async () => {
    const events = [];
    const res = await getProducts(buildSeller(events), '3.2');
    const err = res.structuredContent.adcp_error;
    assert.equal(err.code, 'UNSUPPORTED_FEATURE');
    assert.equal(err.mutation_outcome, undefined);
    assert.deepEqual(err.buyer_reason, BUYER_REASON);
    assert.equal(events.length, 1);
    assert.equal(events[0].fromVersion, ADCP_VERSION);
    assert.equal(events[0].toVersion, '3.2');
    assert.ok(events[0].drifts.every(d => d.type === 'version_downgrade_fields_dropped'));
    assert.ok(events[0].drifts.some(d => d.strippedFields.some(p => p.includes('mutation_outcome'))));
  });

  it('3.1 drops buyer_reason as well', async () => {
    const events = [];
    const res = await getProducts(buildSeller(events), '3.1');
    const err = res.structuredContent.adcp_error;
    assert.equal(err.mutation_outcome, undefined);
    assert.equal(err.buyer_reason, undefined);
    assert.equal(err.code, 'UNSUPPORTED_FEATURE');
    const stripped = events.flatMap(e => e.drifts).flatMap(d => d.strippedFields);
    assert.ok(stripped.some(p => p.includes('buyer_reason')));
  });

  it('a served-release caller keeps everything and gets no translation event', async () => {
    const events = [];
    const res = await getProducts(buildSeller(events), SERVED);
    const err = res.structuredContent.adcp_error;
    assert.equal(err.mutation_outcome, 'not_applied');
    assert.deepEqual(err.buyer_reason, BUYER_REASON);
    assert.equal(events.length, 0);
  });

  describe('create_media_buy with a standard-code error', () => {
    const create = (seller, version) =>
      call(seller, 'create_media_buy', {
        adcp_version: version,
        account: { account_id: 'a' },
        idempotency_key: newKey(),
        packages: [],
      });

    const errorsArm = async () => ({
      errors: [{ code: 'POLICY_VIOLATION', message: 'no', mutation_outcome: 'not_applied' }],
    });
    const envelopeOnly = async () => adcpError('POLICY_VIOLATION', { message: 'no', mutation_outcome: 'not_applied' });

    const droppedFields = events => events.flatMap(e => e.drifts).flatMap(d => d.strippedFields);

    for (const [label, createMediaBuy] of [
      ['errors[] arm', errorsArm],
      ['adcpError envelope', envelopeOnly],
    ]) {
      it(`${label}: a served-release caller keeps mutation_outcome on both layers`, async () => {
        const events = [];
        const res = await create(buildSeller(events, { createMediaBuy }), SERVED);
        const body = res.structuredContent;
        assert.equal(body.errors[0].code, 'POLICY_VIOLATION');
        assert.equal(body.errors[0].mutation_outcome, 'not_applied');
        assert.equal(body.adcp_error.mutation_outcome, 'not_applied');
        assert.equal(events.length, 0);
      });

      it(`${label}: 3.2 drops mutation_outcome from both layers and reports drift`, async () => {
        const events = [];
        const res = await create(buildSeller(events, { createMediaBuy }), '3.2');
        const body = res.structuredContent;
        assert.equal(body.errors[0].code, 'POLICY_VIOLATION');
        assert.equal(body.errors[0].mutation_outcome, undefined);
        assert.equal(body.adcp_error.mutation_outcome, undefined);
        assert.ok(droppedFields(events).some(p => p.includes('mutation_outcome')));
      });
    }
  });
});

describe('projectErrorsForRelease', () => {
  const options = { toolName: 'create_media_buy', fromVersion: ADCP_VERSION, toVersion: '3.2' };
  const newer = () => ({
    adcp_error: { code: 'X_CODE', message: 'm', mutation_outcome: 'not_applied', buyer_reason: BUYER_REASON },
    errors: [{ code: 'X_CODE', message: 'm', mutation_outcome: 'not_applied' }],
  });

  it('never mutates its input', () => {
    const body = newer();
    const snapshot = structuredClone(body);
    const { data, drifts } = projectErrorsForRelease(body, options);
    assert.deepEqual(body, snapshot);
    assert.notEqual(data, body);
    assert.equal(data.adcp_error.mutation_outcome, undefined);
    assert.equal(data.errors[0].mutation_outcome, undefined);
    assert.ok(drifts.length > 0);
  });

  it('returns the same reference and no drift when nothing is dropped', () => {
    const body = { adcp_error: { code: 'X_CODE', message: 'm' }, errors: [{ code: 'X_CODE', message: 'm' }] };
    const { data, drifts } = projectErrorsForRelease(body, options);
    assert.equal(data, body);
    assert.deepEqual(drifts, []);
    const plain = { media_buy_id: 'mb' };
    assert.equal(projectErrorsForRelease(plain, options).data, plain);
  });

  it('returns the same reference when from and to are the same release', () => {
    const body = newer();
    const { data, drifts } = projectErrorsForRelease(body, { ...options, toVersion: ADCP_VERSION });
    assert.equal(data, body);
    assert.deepEqual(drifts, []);
  });

  it('passes non-object bodies through', () => {
    for (const value of [null, undefined, 'text', 42, true, [newer()]]) {
      const { data, drifts } = projectErrorsForRelease(value, options);
      assert.equal(data, value);
      assert.deepEqual(drifts, []);
    }
  });
});
