/**
 * Storyboard outbound-webhook conformance runner — adcontextprotocol/adcp#2431.
 *
 * Covers three layers:
 *   1. Receiver module — per-step URL routing, delivery_index tracking,
 *      retry-replay policy (5xx→2xx), filter matching.
 *   2. Runner variables — `{{runner.*}}` and `{{prior_step.*.operation_id}}`
 *      substitution against a `RunnerVariables` bag.
 *   3. runStoryboard integration — `expect_webhook`,
 *      `expect_webhook_retry_keys_stable`, and `expect_webhook_signature_valid`
 *      pseudo-tasks against a fake publisher.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { setTimeout: delay } = require('node:timers/promises');

const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');
const { injectContext, createRunnerVariables } = require('../../dist/lib/testing/storyboard/context.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

// ────────────────────────────────────────────────────────────
// Receiver module: direct tests
// ────────────────────────────────────────────────────────────

async function post(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('createWebhookReceiver', () => {
  test('per-step URL routing captures step_id + operation_id from path', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const url = `${receiver.base_url}/step/trigger_media_buy/op-123`;
      const res = await post(url, { idempotency_key: 'evt_abcdef0123456789', task_id: 'mb-1' });
      assert.strictEqual(res.status, 204);
      const captured = receiver.all();
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].step_id, 'trigger_media_buy');
      assert.strictEqual(captured[0].operation_id, 'op-123');
      assert.strictEqual(captured[0].delivery_index, 1);
      assert.strictEqual(captured[0].response_status, 204);
    } finally {
      await receiver.close();
    }
  });

  test('retry-replay policy returns 5xx for first N deliveries then 2xx', async () => {
    const receiver = await createWebhookReceiver();
    try {
      receiver.set_retry_replay({ step_id: 'trigger', operation_id: 'op-A' }, { count: 2, http_status: 503 });
      const url = `${receiver.base_url}/step/trigger/op-A`;
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        const res = await post(url, { idempotency_key: 'evt_stable0123456789' });
        statuses.push(res.status);
      }
      assert.deepStrictEqual(statuses, [503, 503, 204]);
      const captured = receiver.all();
      assert.strictEqual(captured.length, 3);
      assert.strictEqual(captured[0].delivery_index, 1);
      assert.strictEqual(captured[2].delivery_index, 3);
      assert.strictEqual(captured[0].response_status, 503);
      assert.strictEqual(captured[2].response_status, 204);
    } finally {
      await receiver.close();
    }
  });

  test('wait resolves on first match; wait_all returns every match after delay', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const url = `${receiver.base_url}/step/s1/op-x`;
      const waiter = receiver.wait({ step_id: 's1' }, 1500);
      setTimeout(() => void post(url, { idempotency_key: 'evt_x1234567890abcdef' }), 20);
      const first = await waiter;
      assert.ok(first.webhook);
      assert.strictEqual(first.webhook.step_id, 's1');

      await post(url, { idempotency_key: 'evt_x1234567890abcdef' });
      await post(url, { idempotency_key: 'evt_x1234567890abcdef' });
      const all = await receiver.wait_all({ step_id: 's1' }, 50);
      assert.strictEqual(all.length, 3);
    } finally {
      await receiver.close();
    }
  });

  test('wait times out cleanly when no match arrives', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const result = await receiver.wait({ step_id: 'nobody' }, 80);
      assert.strictEqual(result.timed_out, true);
    } finally {
      await receiver.close();
    }
  });

  test('filter scopes by step_id, operation_id, and body path', async () => {
    const receiver = await createWebhookReceiver();
    try {
      await post(`${receiver.base_url}/step/foo/op-1`, {
        idempotency_key: 'evt_x1234567890abcdef',
        task: { id: 'noise' },
      });
      await post(`${receiver.base_url}/step/foo/op-2`, {
        idempotency_key: 'evt_x1234567890abcdef',
        task: { id: 'target' },
      });
      const filtered = receiver.matching({ operation_id: 'op-2', body: { 'task.id': 'target' } });
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].operation_id, 'op-2');
    } finally {
      await receiver.close();
    }
  });

  test('rejects POSTs on unknown paths with 404', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const res = await post(`${receiver.base_url}/webhook`, { idempotency_key: 'evt_x1234567890abcdef' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(receiver.all().length, 0);
    } finally {
      await receiver.close();
    }
  });

  test('proxy_url mode requires public_url; loopback mode does not', async () => {
    await assert.rejects(() => createWebhookReceiver({ mode: 'proxy_url' }), /public_url/);
    const rec = await createWebhookReceiver({ mode: 'proxy_url', public_url: 'https://tunnel.example' });
    try {
      assert.strictEqual(rec.mode, 'proxy_url');
      assert.strictEqual(rec.base_url, 'https://tunnel.example');
    } finally {
      await rec.close();
    }
  });

  test('rejects proxy_url with bad scheme, userinfo, or CRLF', async () => {
    await assert.rejects(() => createWebhookReceiver({ mode: 'proxy_url', public_url: 'file:///etc/passwd' }), /http/);
    await assert.rejects(
      () => createWebhookReceiver({ mode: 'proxy_url', public_url: 'https://user:pw@example.com' }),
      /userinfo/
    );
    await assert.rejects(
      () => createWebhookReceiver({ mode: 'proxy_url', public_url: 'https://example.com\r\nX-Evil: 1' }),
      /CR\/LF/
    );
  });

  test('rejects 0.0.0.0 in loopback_mock mode', async () => {
    await assert.rejects(() => createWebhookReceiver({ host: '0.0.0.0' }), /not permitted/);
  });

  test('redacts sensitive headers in captured webhooks', async () => {
    const receiver = await createWebhookReceiver();
    try {
      await post(
        `${receiver.base_url}/step/s/op`,
        { idempotency_key: 'evt_x1234567890abcdef' },
        {
          authorization: 'Bearer super-secret',
          'x-api-key': 'also-secret',
        }
      );
      const [w] = receiver.all();
      assert.strictEqual(w.headers.authorization, '[redacted]');
      assert.strictEqual(w.headers['x-api-key'], '[redacted]');
      assert.strictEqual(w.headers['content-type'], 'application/json'); // unaffected
    } finally {
      await receiver.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// Runner-variable substitution
// ────────────────────────────────────────────────────────────

describe('injectContext with RunnerVariables', () => {
  test('{{runner.webhook_base}} is substituted inside a larger string', () => {
    const rv = createRunnerVariables({ webhookBase: 'https://receiver.example' });
    const out = injectContext({ url: '{{runner.webhook_base}}/hook' }, {}, rv);
    assert.strictEqual(out.url, 'https://receiver.example/hook');
  });

  test('{{runner.webhook_url:<id>}} mints operation_id once per step_id', () => {
    const rv = createRunnerVariables({ webhookBase: 'https://receiver.example' });
    const first = injectContext({ url: '{{runner.webhook_url:trigger}}' }, {}, rv);
    const second = injectContext({ url: '{{runner.webhook_url:trigger}}' }, {}, rv);
    assert.strictEqual(first.url, second.url);
    const opId = rv.stepOperationIds.get('trigger');
    assert.ok(opId, 'operation_id cached on stepOperationIds');
    assert.strictEqual(first.url, `https://receiver.example/step/trigger/${opId}`);
  });

  test('{{prior_step.<id>.operation_id}} resolves to the same id as the URL', () => {
    const rv = createRunnerVariables({ webhookBase: 'https://receiver.example' });
    const triggerUrl = injectContext({ u: '{{runner.webhook_url:trigger}}' }, {}, rv).u;
    const opId = rv.stepOperationIds.get('trigger');
    const filterResolved = injectContext({ op: '{{prior_step.trigger.operation_id}}' }, {}, rv);
    assert.strictEqual(filterResolved.op, opId);
    assert.ok(triggerUrl.endsWith(opId));
  });

  test('unresolved tokens pass through unchanged', () => {
    const rv = createRunnerVariables({}); // no webhook base
    const out = injectContext({ a: '{{runner.webhook_base}}', b: '{{prior_step.ghost.operation_id}}' }, {}, rv);
    assert.strictEqual(out.a, '{{runner.webhook_base}}');
    assert.strictEqual(out.b, '{{prior_step.ghost.operation_id}}');
  });

  test('returns quickly on nested/partial mustache inputs (ReDoS regression for CodeQL #49)', () => {
    const rv = createRunnerVariables({ webhookBase: 'https://r.example' });
    // Pathological input that the prior `[^}]+` alternation would backtrack
    // over at O(n²) — many repetitions of a `{{runner.` prefix without a
    // matching close. The new `[^{}]+` character class forbids a token from
    // straddling a nested `{{`, so no match fires and the input passes
    // through unchanged in linear time.
    const pathological = '{{runner.'.repeat(5000);
    const start = process.hrtime.bigint();
    const out = injectContext({ x: pathological }, {}, rv);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.strictEqual(out.x, pathological);
    // Bound generously — was observed ~300 ns per input char pre-fix at this
    // scale. If a future regex change re-introduces polynomial backtracking,
    // this will time out well under the assertion.
    assert.ok(elapsedMs < 100, `expected sub-100ms, got ${elapsedMs.toFixed(1)}ms`);
  });
});

// ────────────────────────────────────────────────────────────
// End-to-end: runStoryboard + webhook_receiver
// ────────────────────────────────────────────────────────────

/**
 * Fake publisher. The `__test_fire_webhook` tool POSTs a payload to the
 * push_notification_config.url — simulating a seller's webhook emission
 * path. Configurable failure modes let us exercise every expect_webhook
 * error code without standing up a real seller.
 */
async function startFakePublisher(config = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let rpc;
    try {
      rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const toolName = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};

    if (toolName === '__test_fire_webhook') {
      const url = args.push_notification_config?.url;
      const taskId = args.task_id ?? 'mb-1';
      const mode = config.mode ?? 'ok';
      const fire = async (idempotencyKey, attempt) => {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              idempotency_key: idempotencyKey,
              task: { task_id: taskId, status: 'completed', attempt },
            }),
          });
        } catch {
          // swallow — test surfaces failures via timeouts or count mismatch
        }
      };

      if (mode === 'ok') {
        await fire('evt_stable_' + '0123456789abcdef'.slice(0, 16), 1);
      } else if (mode === 'missing_key') {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ task: { task_id: taskId, status: 'completed' } }),
          });
        } catch {}
      } else if (mode === 'invalid_key_format') {
        await fire('tooShort', 1);
      } else if (mode === 'retry_stable') {
        // Retry up to N+1 times with the SAME idempotency_key. The receiver's
        // retry-replay policy decides when deliveries are accepted; this
        // publisher just keeps retrying as long as the receiver says 5xx.
        const key = 'evt_stable_' + '0123456789abcdef'.slice(0, 16);
        let attempt = 1;
        while (attempt <= 10) {
          try {
            const deliveryRes = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                idempotency_key: key,
                task: { task_id: taskId, status: attempt === 1 ? 'pending' : 'completed', attempt },
              }),
            });
            if (deliveryRes.status < 500) break;
          } catch {
            break;
          }
          attempt++;
          await delay(5);
        }
      } else if (mode === 'retry_rotated') {
        let attempt = 1;
        while (attempt <= 10) {
          const key = 'evt_rot_' + attempt.toString().padStart(12, '0');
          try {
            const deliveryRes = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                idempotency_key: key,
                task: { task_id: taskId, status: attempt === 1 ? 'pending' : 'completed', attempt },
              }),
            });
            if (deliveryRes.status < 500) break;
          } catch {
            break;
          }
          attempt++;
          await delay(5);
        }
      } else if (mode === 'duplicate_logical_event') {
        // Two webhooks with DIFFERENT idempotency_keys — simulates publisher
        // re-executing on replay and emitting a duplicate event.
        await fire('evt_first_' + '0123456789abcdef'.slice(0, 16), 1);
        await fire('evt_secon_' + '0123456789abcdef'.slice(0, 16), 2);
      }

      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { structuredContent: { fired: true, task_id: taskId } },
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { isError: true, structuredContent: { error: `unknown tool ${toolName}`, code: 'NOT_FOUND' } },
      })
    );
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  };
}

function stopPublisher(p) {
  return new Promise(r => p.server.close(r));
}

function storyboardWith(steps) {
  return {
    id: 'webhook_emission_sb',
    version: '1.0.0',
    title: 'Webhook emission test',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'compliance_runner' },
    phases: [{ id: 'p', title: 'emit', steps }],
  };
}

const AGENT_TOOLS = ['__test_fire_webhook'];
const RUN_OPTIONS_BASE = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: AGENT_TOOLS,
  _profile: { name: 'fake', tools: AGENT_TOOLS.map(name => ({ name })) },
};

describe('runStoryboard: expect_webhook step task', () => {
  let publisher;
  afterEach(async () => {
    if (publisher) await stopPublisher(publisher);
    publisher = undefined;
  });

  test('passes when publisher emits a webhook with a valid idempotency_key', async () => {
    publisher = await startFakePublisher({ mode: 'ok' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger webhook',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: {
          task_id: 'mb-1',
          push_notification_config: { url: '{{runner.webhook_url:trigger}}' },
        },
      },
      {
        id: 'assert',
        title: 'Assert webhook arrived with idempotency_key',
        task: 'expect_webhook',
        triggered_by: 'trigger',
        timeout_seconds: 2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const [triggerStep, assertStep] = result.phases[0].steps;
    assert.strictEqual(triggerStep.passed, true, triggerStep.error);
    assert.strictEqual(assertStep.passed, true, `validations: ${JSON.stringify(assertStep.validations)}`);
    assert.strictEqual(assertStep.validations[0].check, 'expect_webhook');
  });

  test('fails with no_webhook_received when publisher does not emit', async () => {
    publisher = await startFakePublisher({ mode: 'quiet' }); // unknown mode → no webhook
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert',
        title: 'Assert',
        task: 'expect_webhook',
        triggered_by: 'trigger',
        timeout_seconds: 0.2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'no_webhook_received');
  });

  test('fails with missing_idempotency_key when the key is absent', async () => {
    publisher = await startFakePublisher({ mode: 'missing_key' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert',
        title: 'Assert',
        task: 'expect_webhook',
        triggered_by: 'trigger',
        timeout_seconds: 2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'missing_idempotency_key');
  });

  test('fails with invalid_idempotency_key_format on pattern mismatch', async () => {
    publisher = await startFakePublisher({ mode: 'invalid_key_format' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert',
        title: 'Assert',
        task: 'expect_webhook',
        triggered_by: 'trigger',
        timeout_seconds: 2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'invalid_idempotency_key_format');
  });

  test('fails with duplicate_webhook_on_replay when two distinct logical events arrive under a cap of 1', async () => {
    publisher = await startFakePublisher({ mode: 'duplicate_logical_event' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert',
        title: 'Assert',
        task: 'expect_webhook',
        triggered_by: 'trigger',
        timeout_seconds: 0.3,
        expect_max_deliveries_per_logical_event: 1,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'duplicate_webhook_on_replay');
  });

  test('grades not_applicable when requires_contract is not in options.contracts', async () => {
    publisher = await startFakePublisher({ mode: 'ok' });
    const storyboard = storyboardWith([
      {
        id: 'assert',
        title: 'Gated assertion',
        task: 'expect_webhook',
        timeout_seconds: 0.2,
        requires_contract: 'webhook_receiver_runner',
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
      contracts: [], // contract NOT in scope
    });
    const assertStep = result.phases[0].steps[0];
    assert.strictEqual(assertStep.skipped, true);
    assert.strictEqual(assertStep.skip.reason, 'unsatisfied_contract');
  });

  test('grades not_applicable when webhook_receiver is not enabled', async () => {
    publisher = await startFakePublisher({ mode: 'ok' });
    const storyboard = storyboardWith([
      {
        id: 'assert',
        title: 'No receiver',
        task: 'expect_webhook',
        timeout_seconds: 0.2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, RUN_OPTIONS_BASE);
    const assertStep = result.phases[0].steps[0];
    assert.strictEqual(assertStep.skipped, true);
    assert.strictEqual(assertStep.skip.reason, 'unsatisfied_contract');
  });
});

describe('runStoryboard: expect_webhook_retry_keys_stable', () => {
  let publisher;
  afterEach(async () => {
    if (publisher) await stopPublisher(publisher);
    publisher = undefined;
  });

  test('passes when publisher retries with the same idempotency_key', async () => {
    publisher = await startFakePublisher({ mode: 'retry_stable' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert_stable',
        title: 'Retry stable',
        task: 'expect_webhook_retry_keys_stable',
        triggered_by: 'trigger',
        retry_trigger: { count: 2, http_status: 503 },
        timeout_seconds: 1,
        expect_min_deliveries: 2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, true, JSON.stringify(assertStep.validations));
    assert.strictEqual(assertStep.validations[0].check, 'expect_webhook_retry_keys_stable');
  });

  test('fails with idempotency_key_rotated when publisher changes the key across retries', async () => {
    publisher = await startFakePublisher({ mode: 'retry_rotated' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert_stable',
        title: 'Retry stable',
        task: 'expect_webhook_retry_keys_stable',
        triggered_by: 'trigger',
        retry_trigger: { count: 2, http_status: 503 },
        timeout_seconds: 1,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'idempotency_key_rotated');
  });

  test('fails with insufficient_retries when publisher does not retry', async () => {
    publisher = await startFakePublisher({ mode: 'ok' }); // single delivery, no retries
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert_stable',
        title: 'Retry stable',
        task: 'expect_webhook_retry_keys_stable',
        triggered_by: 'trigger',
        retry_trigger: { count: 2, http_status: 503 },
        timeout_seconds: 0.3,
        expect_min_deliveries: 2,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'insufficient_retries');
  });
});

describe('runStoryboard: expect_webhook_signature_valid (gating)', () => {
  let publisher;
  afterEach(async () => {
    if (publisher) await stopPublisher(publisher);
    publisher = undefined;
  });

  test('grades not_applicable when webhook_signing is not configured', async () => {
    publisher = await startFakePublisher({ mode: 'ok' });
    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: { push_notification_config: { url: '{{runner.webhook_url:trigger}}' } },
      },
      {
        id: 'assert_sig',
        title: 'Assert signature',
        task: 'expect_webhook_signature_valid',
        triggered_by: 'trigger',
        timeout_seconds: 0.3,
      },
    ]);
    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
    });
    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.skipped, true);
    assert.strictEqual(assertStep.skip.reason, 'unsatisfied_contract');
    assert.match(assertStep.skip.detail, /webhook_signing/);
  });
});
