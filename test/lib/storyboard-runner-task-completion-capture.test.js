/**
 * Runner coverage for `task_completion.<path>` `context_outputs` resolution
 * (adcp-client#1417). When a step's immediate response is a submitted-arm
 * envelope and the storyboard captures from `task_completion.media_buy_id`,
 * the runner polls `tasks/get` until terminal and resolves the rest of the
 * path against the artifact data — instead of failing with
 * `capture_path_not_resolvable` for a value the seller correctly produces
 * on the completion artifact.
 *
 * Pinned behaviors:
 *   - submitted envelope + polled completion → capture succeeds
 *   - submitted envelope + poll timeout → `capture_poll_timeout` failure
 *     (not the recycled `capture_path_not_resolvable`)
 *   - sync-arm response on a `task_completion.` path → falls through to
 *     plain path resolution against immediate data (path stripped)
 *   - invalid `task_id` (control chars / oversize) → no poll attempted
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');

function buildHitlClient({ immediateData, pollResult, pollDelay = 0, recordPollCall, omitExecutor = false }) {
  const calls = [];
  const agent = { id: 'stub', agent_uri: 'https://stub.example/mcp' };
  const executor = omitExecutor
    ? undefined
    : {
        pollTaskCompletion: async (agentArg, taskId, _pollInterval) => {
          calls.push({ kind: 'poll', taskId, agentId: agentArg?.id });
          if (recordPollCall) recordPollCall(taskId);
          if (pollDelay > 0) await new Promise(r => setTimeout(r, pollDelay));
          return pollResult ?? { success: false, error: 'no poll result configured' };
        },
      };
  const client = {
    agent,
    ...(executor && { executor }),
    getAgentInfo: async () => ({ name: 'stub', tools: ['create_media_buy'] }),
    executeTask: async (name, _params) => {
      calls.push({ kind: 'execute', name });
      if (name === 'create_media_buy') return { success: true, data: immediateData };
      return { success: false, error: `no handler for ${name}` };
    },
  };
  return { client, calls };
}

/**
 * Stub WebhookReceiver matching the runtime contract — only `wait` is
 * exercised by `resolveTaskCompletionOutputs`. Resolves with the configured
 * payload after `deliverAfterMs` (default: synchronous resolve), or
 * `{ timed_out: true }` if `timeout_ms` elapses first.
 */
function buildWebhookReceiver({ payload, deliverAfterMs = 0, deliverStatus = 'completed' }) {
  const calls = [];
  return {
    base_url: 'http://stub-webhook.example',
    mode: 'loopback_mock',
    all: () => [],
    matching: () => [],
    set_retry_replay: () => {},
    wait: async (filter, timeout_ms) => {
      calls.push({ filter, timeout_ms });
      if (payload === undefined) {
        // Simulate "webhook never arrives" — resolve as timed_out after timeout.
        await new Promise(r => setTimeout(r, timeout_ms));
        return { timed_out: true };
      }
      if (deliverAfterMs >= timeout_ms) {
        await new Promise(r => setTimeout(r, timeout_ms));
        return { timed_out: true };
      }
      if (deliverAfterMs > 0) {
        await new Promise(r => setTimeout(r, deliverAfterMs));
      }
      return {
        webhook: {
          id: 'wh1',
          step_id: 'create',
          operation_id: 'op1',
          delivery_index: 1,
          received_at: Date.now(),
          method: 'POST',
          path: '/',
          headers: {},
          raw_body: JSON.stringify(payload),
          body: { ...payload, status: deliverStatus },
          response_status: 200,
        },
      };
    },
    wait_all: async () => [],
    close: async () => {},
    _calls: calls,
  };
}

const stubProfile = { name: 'stub', tools: ['create_media_buy'] };

const baseStoryboard = {
  id: 'task_completion_sb',
  version: '1.0',
  title: 'task_completion capture',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'p1',
      title: 'phase 1',
      steps: [
        {
          id: 'create',
          title: 'Create a guaranteed media buy',
          task: 'create_media_buy',
          sample_request: { idempotency_key: 'idem_test_1' },
          context_outputs: [{ key: 'media_buy_id', path: 'task_completion.media_buy_id' }],
        },
      ],
    },
  ],
};

describe('runStoryboardStep — task_completion. context_outputs', () => {
  test('captures media_buy_id from polled artifact when immediate response is a submitted envelope', async () => {
    const { client, calls } = buildHitlClient({
      immediateData: { status: 'submitted', task_id: 'task_async_signed_io_q2', message: 'awaiting IO' },
      pollResult: {
        success: true,
        data: {
          media_buy_id: 'mb_42',
          status: 'pending_creatives',
          packages: [{ package_id: 'pkg_1' }],
        },
      },
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(
      calls.filter(c => c.kind === 'poll').length,
      1,
      'executor.pollTaskCompletion called exactly once for the task_completion. capture'
    );
    assert.equal(result.context.media_buy_id, 'mb_42');
    const captureFailures = result.validations.filter(
      v => v.check === 'capture_path_not_resolvable' || v.check === 'capture_poll_timeout'
    );
    assert.equal(captureFailures.length, 0, 'no capture failures synthesized when polled artifact has the field');
  });

  test('emits capture_poll_timeout (not capture_path_not_resolvable) when polling exceeds the timeout', async () => {
    process.env.STORYBOARD_TASK_POLL_TIMEOUT_MS = '50';
    try {
      const { client } = buildHitlClient({
        immediateData: { status: 'submitted', task_id: 'task_will_never_complete', message: 'stuck' },
        pollResult: { success: true, data: { media_buy_id: 'mb_too_late' } },
        pollDelay: 500,
      });

      const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
        protocol: 'mcp',
        _client: client,
        _profile: stubProfile,
      });

      const pollTimeout = result.validations.find(v => v.check === 'capture_poll_timeout');
      assert.ok(pollTimeout, 'capture_poll_timeout failure synthesized');
      assert.equal(pollTimeout.passed, false);
      assert.match(pollTimeout.description, /tasks\/get poll timed out/);
      assert.equal(
        result.validations.filter(v => v.check === 'capture_path_not_resolvable').length,
        0,
        'capture_path_not_resolvable not used when the failure was a poll timeout'
      );
      assert.equal(result.context.media_buy_id, undefined, 'no fabricated media_buy_id captured on timeout');
    } finally {
      delete process.env.STORYBOARD_TASK_POLL_TIMEOUT_MS;
    }
  });

  test('falls through to plain path resolution when immediate response is the sync arm (no poll)', async () => {
    const { client, calls } = buildHitlClient({
      // Sync-arm response — `media_buy_id` already on immediate data, no submitted envelope.
      immediateData: { media_buy_id: 'mb_sync_immediate', status: 'pending_creatives' },
      pollResult: { success: true, data: { media_buy_id: 'should_not_be_used' } },
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(
      calls.filter(c => c.kind === 'poll').length,
      0,
      'no poll attempted when immediate response is not a submitted envelope'
    );
    assert.equal(result.context.media_buy_id, 'mb_sync_immediate');
  });

  test('rejects task_id with control characters before polling', async () => {
    let pollAttempted = false;
    const { client } = buildHitlClient({
      immediateData: { status: 'submitted', task_id: 'task\x00injected', message: 'malformed' },
      pollResult: { success: true, data: { media_buy_id: 'should_not_be_used' } },
      recordPollCall: () => {
        pollAttempted = true;
      },
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(pollAttempted, false, 'pollTaskCompletion not called for invalid task_id');
    const captureFailure = result.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.ok(captureFailure, 'capture_path_not_resolvable when poll path is unreachable');
  });

  test('emits capture_task_failed when polled task reaches terminal failed/canceled/rejected', async () => {
    const { client } = buildHitlClient({
      immediateData: { status: 'submitted', task_id: 'task_will_fail' },
      pollResult: {
        success: false,
        status: 'failed',
        error: 'IO review rejected the buy',
        data: { error: { code: 'INVALID_REQUEST', message: 'rejected' } },
      },
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    const taskFailed = result.validations.find(v => v.check === 'capture_task_failed');
    assert.ok(taskFailed, 'capture_task_failed validation synthesized');
    assert.equal(taskFailed.passed, false);
    assert.match(taskFailed.description, /terminal failed\/canceled\/rejected state/);
    assert.equal(
      result.validations.filter(v => v.check === 'capture_path_not_resolvable').length,
      0,
      'capture_path_not_resolvable not used when the task itself terminally failed'
    );
    assert.equal(result.context.media_buy_id, undefined);
  });

  test('also polls when immediate response is `working` (non-terminal status with task_id)', async () => {
    const { client, calls } = buildHitlClient({
      immediateData: { status: 'working', task_id: 'task_running', message: 'in flight' },
      pollResult: { success: true, data: { media_buy_id: 'mb_from_working' } },
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(calls.filter(c => c.kind === 'poll').length, 1, 'poll fires for working status with task_id');
    assert.equal(result.context.media_buy_id, 'mb_from_working');
  });

  test('webhook receiver wins the race when payload arrives before poll terminal', async () => {
    const { client, calls } = buildHitlClient({
      immediateData: { status: 'submitted', task_id: 'task_webhook_first' },
      pollResult: { success: true, data: { media_buy_id: 'mb_from_poll' } },
      pollDelay: 500, // poll resolves slowly
    });
    const webhookReceiver = buildWebhookReceiver({
      payload: { task_id: 'task_webhook_first', result: { media_buy_id: 'mb_from_webhook' } },
      deliverAfterMs: 10, // webhook beats the poll
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _webhookReceiver: webhookReceiver,
    });

    assert.equal(result.context.media_buy_id, 'mb_from_webhook', 'webhook payload result.media_buy_id captured');
    assert.equal(webhookReceiver._calls.length, 1, 'webhookReceiver.wait was called');
    assert.deepEqual(
      webhookReceiver._calls[0].filter,
      { body: { task_id: 'task_webhook_first' } },
      'wait filter targeted task_id'
    );
    void calls;
  });

  test('webhook fallback works when executor.pollTaskCompletion is unavailable', async () => {
    const { client } = buildHitlClient({
      immediateData: { status: 'submitted', task_id: 'task_webhook_only' },
      omitExecutor: true,
    });
    const webhookReceiver = buildWebhookReceiver({
      payload: { task_id: 'task_webhook_only', result: { media_buy_id: 'mb_webhook_only' } },
      deliverAfterMs: 5,
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _webhookReceiver: webhookReceiver,
    });

    assert.equal(result.context.media_buy_id, 'mb_webhook_only');
  });

  test('emits capture_task_failed when webhook delivers a non-completed terminal status', async () => {
    const { client } = buildHitlClient({
      immediateData: { status: 'submitted', task_id: 'task_webhook_failed' },
      pollResult: { success: true, data: { media_buy_id: 'mb_should_not_be_used' } },
      pollDelay: 500,
    });
    const webhookReceiver = buildWebhookReceiver({
      payload: { task_id: 'task_webhook_failed', result: { error: { code: 'INVALID_REQUEST' } } },
      deliverAfterMs: 5,
      deliverStatus: 'failed',
    });

    const result = await runStoryboardStep('https://stub.example/mcp', baseStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _webhookReceiver: webhookReceiver,
    });

    const taskFailed = result.validations.find(v => v.check === 'capture_task_failed');
    assert.ok(taskFailed, 'capture_task_failed when webhook payload status is non-completed');
    assert.equal(result.context.media_buy_id, undefined);
  });

  test('plain path captures still work without prefix (no regression)', async () => {
    const plainStoryboard = {
      ...baseStoryboard,
      phases: [
        {
          ...baseStoryboard.phases[0],
          steps: [
            {
              ...baseStoryboard.phases[0].steps[0],
              context_outputs: [{ key: 'media_buy_id', path: 'media_buy_id' }],
            },
          ],
        },
      ],
    };

    const { client, calls } = buildHitlClient({
      immediateData: { media_buy_id: 'mb_plain' },
      pollResult: undefined,
    });

    const result = await runStoryboardStep('https://stub.example/mcp', plainStoryboard, 'create', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(calls.filter(c => c.kind === 'poll').length, 0);
    assert.equal(result.context.media_buy_id, 'mb_plain');
  });
});
