/**
 * Storyboard webhook receiver — slice 1 of AdCP #2426.
 *
 * Covers two layers:
 *   1. The ephemeral receiver module in isolation (binds, captures POSTs,
 *      matches filters, resolves waits, times out, closes cleanly).
 *   2. The end-to-end runner flow: the runner exposes the receiver URL as
 *      `$context.webhook_receiver_url`, a fake MCP agent POSTs to it, and
 *      the step's `expect_webhook` validation asserts idempotency_key
 *      presence on the received payload.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

// ────────────────────────────────────────────────────────────
// Receiver module: direct tests
// ────────────────────────────────────────────────────────────

async function postJson(url, body, extraHeaders) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  });
  return res;
}

describe('createWebhookReceiver', () => {
  test('binds and captures a POSTed JSON body', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const res = await postJson(receiver.url, { idempotency_key: 'abc', task_id: 'mb-1' });
      assert.strictEqual(res.status, 204);
      const captured = receiver.all();
      assert.strictEqual(captured.length, 1);
      assert.deepStrictEqual(captured[0].body, { idempotency_key: 'abc', task_id: 'mb-1' });
      assert.strictEqual(typeof captured[0].id, 'string');
      assert.ok(captured[0].received_at > 0);
    } finally {
      await receiver.close();
    }
  });

  test('wait() resolves with an already-arrived webhook', async () => {
    const receiver = await createWebhookReceiver();
    try {
      await postJson(receiver.url, { idempotency_key: 'k1', task_id: 'first' });
      const result = await receiver.wait(undefined, 500);
      assert.ok(result.webhook);
      assert.strictEqual(result.webhook.body.task_id, 'first');
    } finally {
      await receiver.close();
    }
  });

  test('wait() resolves when a webhook arrives after the call', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const waitPromise = receiver.wait(undefined, 2000);
      // Deliver after a short delay so wait() is already suspended.
      setTimeout(() => void postJson(receiver.url, { idempotency_key: 'k2', task_id: 'later' }), 20);
      const result = await waitPromise;
      assert.ok(result.webhook);
      assert.strictEqual(result.webhook.body.task_id, 'later');
    } finally {
      await receiver.close();
    }
  });

  test('wait() returns timed_out when no webhook matches', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const result = await receiver.wait({ body: { task_id: 'missing' } }, 100);
      assert.strictEqual(result.timed_out, true);
      assert.strictEqual(result.webhook, undefined);
    } finally {
      await receiver.close();
    }
  });

  test('filter matches by dotted-path equality; non-matching webhook is ignored', async () => {
    const receiver = await createWebhookReceiver();
    try {
      await postJson(receiver.url, { idempotency_key: 'k', task: { task_id: 'noise' } });
      await postJson(receiver.url, { idempotency_key: 'k', task: { task_id: 'target' } });
      const result = await receiver.wait({ body: { 'task.task_id': 'target' } }, 500);
      assert.ok(result.webhook);
      assert.strictEqual(result.webhook.body.task.task_id, 'target');
    } finally {
      await receiver.close();
    }
  });

  test('rejects non-POST methods and unknown paths with 404', async () => {
    const receiver = await createWebhookReceiver();
    try {
      const getRes = await fetch(receiver.url, { method: 'GET' });
      assert.strictEqual(getRes.status, 404);
      const wrongPath = new URL(receiver.url);
      wrongPath.pathname = '/not-webhook';
      const wrongRes = await fetch(wrongPath.toString(), { method: 'POST' });
      assert.strictEqual(wrongRes.status, 404);
      assert.strictEqual(receiver.all().length, 0);
    } finally {
      await receiver.close();
    }
  });

  test('close() wakes pending waiters with timed_out', async () => {
    const receiver = await createWebhookReceiver();
    const waitPromise = receiver.wait(undefined, 10_000);
    await receiver.close();
    const result = await waitPromise;
    assert.strictEqual(result.timed_out, true);
  });

  test('public_url override is advertised verbatim', async () => {
    const receiver = await createWebhookReceiver({ public_url: 'https://tunnel.example/wh' });
    try {
      assert.strictEqual(receiver.url, 'https://tunnel.example/wh');
    } finally {
      await receiver.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// Validation: expect_webhook
// ────────────────────────────────────────────────────────────

describe('runValidations: expect_webhook', () => {
  const baseCtx = () => ({
    taskName: 'create_media_buy',
    agentUrl: 'https://seller.example/mcp',
    contributions: new Set(),
  });

  test('passes when the matched webhook carries idempotency_key', () => {
    const match = {
      id: 'webhook-1',
      received_at: Date.now(),
      method: 'POST',
      path: '/webhook',
      headers: {},
      raw_body: '{}',
      body: { idempotency_key: 'evt-123', task: { task_id: 'mb-1' } },
    };
    const [result] = runValidations(
      [{ check: 'expect_webhook', description: 'webhook arrives with idempotency_key' }],
      { ...baseCtx(), webhookMatches: [match] }
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.json_pointer, '/idempotency_key');
  });

  test('fails with a clear error when the receiver is not configured', () => {
    const [result] = runValidations(
      [{ check: 'expect_webhook', description: 'needs receiver' }],
      { ...baseCtx(), webhookMatches: [{ error: '`expect_webhook` requires `webhook_receiver.enabled: true` on the run options. Without a receiver the runner cannot observe outbound webhooks.' }] }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /webhook_receiver\.enabled/);
  });

  test('fails when the body is missing idempotency_key', () => {
    const match = {
      id: 'webhook-2',
      received_at: Date.now(),
      method: 'POST',
      path: '/webhook',
      headers: {},
      raw_body: '{"task":{}}',
      body: { task: { task_id: 'mb-1' } },
    };
    const [result] = runValidations(
      [{ check: 'expect_webhook', description: 'idempotency_key must be present' }],
      { ...baseCtx(), webhookMatches: [match] }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /idempotency_key/);
    assert.strictEqual(result.json_pointer, '/idempotency_key');
  });

  test('fails when the match carries a timeout error', () => {
    const [result] = runValidations(
      [{ check: 'expect_webhook', description: 'expect delivery' }],
      { ...baseCtx(), webhookMatches: [{ error: 'Timed out after 100ms waiting for a matching webhook.' }] }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Timed out/);
  });
});

// ────────────────────────────────────────────────────────────
// End-to-end: runStoryboard wires receiver URL into context
// ────────────────────────────────────────────────────────────

/**
 * Fake MCP agent whose `__test_fire_webhook` tool reads
 * `push_notification_config.url` from args and POSTs a payload — so the
 * runner's receiver captures a real delivery over the loopback interface.
 */
async function startFakeAgent() {
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
      const body = {
        idempotency_key: args.idempotency_key ?? 'evt-' + Math.random().toString(36).slice(2),
        task: { task_id: args.task_id ?? 'mb-1', status: 'completed' },
      };
      if (typeof url === 'string') {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch {
          // swallow — failures surface as storyboard timeouts
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { structuredContent: { fired: true, task_id: args.task_id ?? 'mb-1' } },
        })
      );
      return;
    }
    if (toolName === '__test_quiet') {
      // Returns success but never fires a webhook — exercises the timeout path.
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { quiet: true } } }));
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
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

function stopAgent(agent) {
  return new Promise(r => agent.server.close(r));
}

function storyboardWith(steps) {
  return {
    id: 'webhook_receiver_sb',
    version: '1.0.0',
    title: 'Webhook receiver test',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [{ id: 'p', title: 'emit', steps }],
  };
}

const AGENT_TOOLS = ['__test_fire_webhook', '__test_quiet'];
const RUN_OPTIONS = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: AGENT_TOOLS,
  _profile: { name: 'fake', tools: AGENT_TOOLS.map(name => ({ name })) },
};

describe('runStoryboard + webhook_receiver', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
  });

  test('injects receiver URL and passes expect_webhook when agent emits a valid payload', async () => {
    agent = await startFakeAgent();

    const storyboard = storyboardWith([
      {
        id: 'fire',
        title: 'Trigger outbound webhook',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: {
          task_id: 'mb-integration',
          push_notification_config: { url: '$context.webhook_receiver_url' },
        },
        validations: [
          {
            check: 'expect_webhook',
            description: 'seller MUST emit a webhook with idempotency_key',
            timeout_ms: 2000,
            filter: { body: { 'task.task_id': 'mb-integration' } },
          },
        ],
      },
    ]);

    const result = await runStoryboard(agent.url, storyboard, {
      ...RUN_OPTIONS,
      webhook_receiver: { enabled: true },
    });

    const step = result.phases[0].steps[0];
    assert.strictEqual(step.passed, true, `step failed: ${step.error} | validations: ${JSON.stringify(step.validations)}`);
    assert.strictEqual(step.validations.length, 1);
    assert.strictEqual(step.validations[0].check, 'expect_webhook');
    assert.strictEqual(step.validations[0].passed, true);
  });

  test('expect_webhook fails with timeout when the agent does not emit', async () => {
    agent = await startFakeAgent();

    const storyboard = storyboardWith([
      {
        id: 'quiet',
        title: 'Step that should have emitted a webhook',
        task: '__test_quiet',
        auth: 'none',
        sample_request: { push_notification_config: { url: '$context.webhook_receiver_url' } },
        validations: [
          {
            check: 'expect_webhook',
            description: 'seller MUST emit a webhook',
            timeout_ms: 150,
          },
        ],
      },
    ]);

    const result = await runStoryboard(agent.url, storyboard, {
      ...RUN_OPTIONS,
      webhook_receiver: { enabled: true },
    });

    const step = result.phases[0].steps[0];
    assert.strictEqual(step.passed, false);
    assert.strictEqual(step.validations[0].passed, false);
    assert.match(step.validations[0].error, /Timed out/);
  });

  test('expect_webhook fails loudly when webhook_receiver is not enabled', async () => {
    agent = await startFakeAgent();

    const storyboard = storyboardWith([
      {
        id: 'no_receiver',
        title: 'No receiver configured',
        task: '__test_quiet',
        auth: 'none',
        sample_request: {},
        validations: [{ check: 'expect_webhook', description: 'expect delivery' }],
      },
    ]);

    const result = await runStoryboard(agent.url, storyboard, RUN_OPTIONS);
    const step = result.phases[0].steps[0];
    assert.strictEqual(step.validations[0].passed, false);
    assert.match(step.validations[0].error, /webhook_receiver\.enabled/);
  });
});
