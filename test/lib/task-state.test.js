const { test, describe } = require('node:test');
const assert = require('node:assert');

const { resolveTaskState } = require('../../dist/lib/index.js');

function stubResult(status, overrides = {}) {
  return {
    success: status !== 'failed' && status !== 'governance-denied',
    status,
    metadata: {
      taskId: 'client-task-1',
      taskName: 'create_media_buy',
      agent: { id: 'agent-1', name: 'Test Agent', protocol: 'mcp' },
      responseTimeMs: 10,
      timestamp: '2026-06-13T00:00:00Z',
      clarificationRounds: 0,
      status,
    },
    ...overrides,
  };
}

describe('resolveTaskState()', () => {
  test('wrapper completed with no payload status stays completed', () => {
    const result = stubResult('completed', {
      data: { media_buy_id: 'mb_1', packages: [] },
    });

    assert.deepStrictEqual(resolveTaskState(result, { toolName: 'create_media_buy' }), {
      wrapperStatus: 'completed',
      effectiveState: 'completed',
      data: { media_buy_id: 'mb_1', packages: [] },
    });
  });

  test('wrapper completed with task-envelope submitted status resolves to submitted', () => {
    const result = stubResult('completed', {
      data: { status: 'submitted', task_id: 'task_1', message: 'Queued' },
    });

    assert.deepStrictEqual(resolveTaskState(result, { toolName: 'create_media_buy' }), {
      wrapperStatus: 'completed',
      payloadStatus: 'submitted',
      effectiveState: 'submitted',
      data: { status: 'submitted', task_id: 'task_1', message: 'Queued' },
    });
  });

  test('wrapper completed with domain-level canceled status stays completed', () => {
    const result = stubResult('completed', {
      data: {
        media_buy_id: 'mb_canceled',
        status: 'canceled',
        affected_packages: [],
      },
    });

    assert.deepStrictEqual(resolveTaskState(result, { toolName: 'update_media_buy' }), {
      wrapperStatus: 'completed',
      payloadStatus: 'canceled',
      effectiveState: 'completed',
      data: {
        media_buy_id: 'mb_canceled',
        status: 'canceled',
        affected_packages: [],
      },
    });
  });

  test('wrapper working with absent data does not throw', () => {
    const result = stubResult('working');

    assert.deepStrictEqual(resolveTaskState(result, { toolName: 'create_media_buy' }), {
      wrapperStatus: 'working',
      effectiveState: 'working',
      data: undefined,
    });
  });

  test('wrapper failed wins over payload task status', () => {
    const result = stubResult('failed', {
      success: false,
      error: 'Transport failed',
      data: { status: 'completed', task_id: 'task_1' },
    });

    assert.deepStrictEqual(resolveTaskState(result, { toolName: 'create_media_buy' }), {
      wrapperStatus: 'failed',
      payloadStatus: 'completed',
      effectiveState: 'failed',
      data: { status: 'completed', task_id: 'task_1' },
    });
  });

  test('surfaces hint when toolName is absent', () => {
    const resolved = resolveTaskState(stubResult('completed', { data: { status: 'submitted', task_id: 'task_1' } }));

    assert.strictEqual(resolved.effectiveState, 'submitted');
    assert.match(resolved.hint, /toolName/);
  });
});
