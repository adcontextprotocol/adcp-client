const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');

const AGENT = {
  id: 'dispatch-boundary-seller',
  name: 'Dispatch boundary seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

const originalCallTool = ProtocolClient.callTool;

afterEach(() => {
  ProtocolClient.callTool = originalCallTool;
});

describe('TaskExecutor pre-dispatch boundary', () => {
  test('terminalizes and compacts task state when the claim hook rejects', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'completed', data: { ok: true } }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });

    await assert.rejects(
      executor.executeTask(
        AGENT,
        'create_media_buy',
        { idempotency_key: 'rejected-claim', sensitive_payload: 'must-not-be-retained' },
        undefined,
        {},
        'v3',
        undefined,
        async () => {
          throw new Error('claim rejected');
        }
      ),
      /pre-dispatch hook failed/i
    );

    const retained = executor.getActiveTasks();
    assert.equal(
      retained.some(task => task.status === 'pending'),
      false
    );
    assert.equal(retained.length, 1);
    assert.equal(retained[0].status, 'failed');
    assert.equal(retained[0].params, undefined);
    assert.deepEqual(retained[0].options, {});
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
  });

  test('does not run the durable claim hook when aborting during awaited preflight', async () => {
    let releaseActivity;
    const activityStarted = new Promise(resolve => {
      releaseActivity = resolve;
    });
    let markActivityStarted;
    const activityEntered = new Promise(resolve => {
      markActivityStarted = resolve;
    });
    let hookCalled = false;
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'completed', data: { ok: true } }));
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      onActivity: async activity => {
        if (activity.type !== 'protocol_request') return;
        markActivityStarted();
        await activityStarted;
      },
    });
    const controller = new AbortController();

    const execution = executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'preflight-abort' },
      undefined,
      { signal: controller.signal },
      'v3',
      undefined,
      async () => {
        hookCalled = true;
        return { action: 'dispatch_committed' };
      }
    );
    await activityEntered;
    controller.abort(new Error('abort during preflight'));
    releaseActivity();

    await assert.rejects(execution, /abort during preflight/);
    assert.equal(hookCalled, false);
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
  });

  test('dispatches without the aborted caller signal when abort races a committed claim', async () => {
    let releaseClaim;
    const claimRelease = new Promise(resolve => {
      releaseClaim = resolve;
    });
    let markClaimStarted;
    const claimStarted = new Promise(resolve => {
      markClaimStarted = resolve;
    });
    let sellerDispatched;
    const sellerDispatch = new Promise(resolve => {
      sellerDispatched = resolve;
    });
    ProtocolClient.callTool = mock.fn(async (_agent, _taskName, _params, options) => {
      assert.equal(options.signal, undefined);
      sellerDispatched();
      return { status: 'completed', data: { media_buy_id: 'buy-committed' } };
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const controller = new AbortController();

    const execution = executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'claim-abort' },
      undefined,
      { signal: controller.signal },
      'v3',
      undefined,
      async () => {
        markClaimStarted();
        await claimRelease;
        return { action: 'dispatch_committed' };
      }
    );
    await claimStarted;
    controller.abort(new Error('abort while claim is pending'));
    releaseClaim();

    await assert.rejects(execution, /abort while claim is pending/);
    await sellerDispatch;
    assert.equal(ProtocolClient.callTool.mock.callCount(), 1);
  });
});
