/**
 * Client-side idempotency integration tests via TaskExecutor.
 *
 * Stubs `ProtocolClient.callTool` so we can assert exactly what the
 * client sends on the wire (idempotency_key value, key reuse across
 * retries, passthrough of caller-supplied keys) without standing up a
 * full MCP transport. The transport-level behavior is already covered
 * by the server-idempotency integration tests.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const protocols = require('../../dist/lib/protocols/index.js');
const { isMutatingTask } = require('../../dist/lib/utils/idempotency.js');
const { IdempotencyConflictError, IdempotencyExpiredError } = require('../../dist/lib/index.js');

function buildResponse({ replayed, adcpVersion } = {}) {
  return {
    structuredContent: {
      status: 'completed',
      ...(replayed !== undefined && { replayed }),
      ...(adcpVersion !== undefined && { adcp_version: adcpVersion }),
      payload: { media_buy_id: 'mb_42', packages: [] },
      media_buy_id: 'mb_42',
      packages: [],
    },
    content: [{ type: 'text', text: JSON.stringify({ status: 'completed', media_buy_id: 'mb_42' }) }],
  };
}

function stubProtocolClient({ response, capture }) {
  const original = protocols.ProtocolClient.callTool;
  protocols.ProtocolClient.callTool = async (agent, toolName, params, ...rest) => {
    capture.push({ toolName, params, rest });
    return typeof response === 'function' ? response(toolName, params) : response;
  };
  return () => {
    protocols.ProtocolClient.callTool = original;
  };
}

const agent = { id: 'a1', name: 'A', protocol: 'mcp', agent_uri: 'https://stub.example/mcp' };
const baseParams = {
  account: { account_id: 'acct_1' },
  brand: { domain: 'example.com' },
  start_time: 'asap',
  end_time: '2026-06-01T00:00:00Z',
  packages: [{ buyer_ref: 'p1', product_id: 'prod_1', pricing_option_id: 'cpm_1', budget: 5000 }],
};

describe('TaskExecutor idempotency_key injection', () => {
  let capture;
  let restore;

  beforeEach(() => {
    capture = [];
    restore = stubProtocolClient({ response: buildResponse(), capture });
  });

  afterEach(() => {
    restore();
  });

  it('auto-generates a UUID-v4 key for mutating tools when caller omits it', async () => {
    const executor = new TaskExecutor();
    const result = await executor.executeTask(agent, 'create_media_buy', baseParams);

    assert.equal(capture.length, 1);
    const sentKey = capture[0].params.idempotency_key;
    assert.ok(sentKey, 'params sent to transport include idempotency_key');
    assert.match(sentKey, /^[A-Za-z0-9_.:-]{16,255}$/);
    assert.equal(result.metadata.idempotency_key, sentKey, 'result surfaces the generated key');
  });

  it('respects caller-supplied key (BYOK) without overwriting', async () => {
    const myKey = 'my_persisted_key_abcdefghij1234';
    const executor = new TaskExecutor();
    const result = await executor.executeTask(agent, 'create_media_buy', {
      ...baseParams,
      idempotency_key: myKey,
    });

    assert.equal(capture[0].params.idempotency_key, myKey);
    assert.equal(result.metadata.idempotency_key, myKey);
  });

  it('does NOT inject for read-only tools', async () => {
    const executor = new TaskExecutor();
    await executor.executeTask(agent, 'get_products', { brief: 'test' });
    assert.equal(capture[0].params.idempotency_key, undefined);
  });

  it('does NOT inject for si_terminate_session (naturally idempotent)', async () => {
    const executor = new TaskExecutor();
    await executor.executeTask(agent, 'si_terminate_session', { session_id: 's_1' });
    assert.equal(capture[0].params.idempotency_key, undefined);
  });
});

describe('TaskExecutor surfaces replayed on result metadata', () => {
  it('replayed: true on envelope flows to result.metadata.replayed', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: buildResponse({ replayed: true }), capture });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams);
      assert.equal(result.metadata.replayed, true);
    } finally {
      restore();
    }
  });

  it('replayed omitted is surfaced as undefined (not false)', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: buildResponse(), capture });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams);
      assert.equal(result.metadata.replayed, undefined);
    } finally {
      restore();
    }
  });
});

describe('TaskExecutor surfaces response adcp_version on result metadata', () => {
  it('adcp_version on envelope flows to result.metadata.adcpVersion', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: buildResponse({ adcpVersion: '3.1-beta.5' }), capture });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams);
      assert.equal(result.metadata.adcpVersion, '3.1-beta.5');
    } finally {
      restore();
    }
  });

  it('tasks/get envelope adcp_version flows through submitted waitForCompletion metadata', async () => {
    const capture = [];
    const restore = stubProtocolClient({
      response: toolName => {
        if (toolName === 'tasks/get' || toolName === 'tasks_get') {
          return {
            structuredContent: {
              status: 'completed',
              task_id: 'task-polled-version',
              task_type: 'create_media_buy',
              created_at: Date.now(),
              updated_at: Date.now(),
              adcp_version: '3.1-beta.5',
              replayed: true,
              context_id: 'ctx-polled-version',
              result: {
                media_buy_id: 'mb_polled_version',
                media_buy_status: 'pending_creatives',
                packages: [],
              },
            },
          };
        }
        return {
          structuredContent: {
            status: 'submitted',
            task_id: 'task-polled-version',
          },
        };
      },
      capture,
    });
    try {
      const executor = new TaskExecutor();
      const submitted = await executor.executeTask(agent, 'create_media_buy', baseParams);
      const result = await submitted.submitted.waitForCompletion(10);
      assert.equal(result.metadata.adcpVersion, '3.1-beta.5');
      assert.equal(result.metadata.replayed, true);
      assert.equal(result.metadata.contextId, 'ctx-polled-version');
      assert.equal(result.metadata.serverTaskId, 'task-polled-version');
    } finally {
      restore();
    }
  });

  it('legacy tasks/get task wrapper adcp_version flows through submitted waitForCompletion metadata', async () => {
    const capture = [];
    const restore = stubProtocolClient({
      response: toolName => {
        if (toolName === 'tasks/get' || toolName === 'tasks_get') {
          return {
            task: {
              status: 'completed',
              taskId: 'task-polled-legacy-version',
              taskType: 'create_media_buy',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              adcp_version: '3.1-beta.5',
              result: {
                media_buy_id: 'mb_polled_legacy_version',
                media_buy_status: 'pending_creatives',
                packages: [],
              },
            },
          };
        }
        return {
          structuredContent: {
            status: 'submitted',
            task_id: 'task-polled-legacy-version',
          },
        };
      },
      capture,
    });
    try {
      const executor = new TaskExecutor();
      const submitted = await executor.executeTask(agent, 'create_media_buy', baseParams);
      const result = await submitted.submitted.waitForCompletion(10);
      assert.equal(result.metadata.adcpVersion, '3.1-beta.5');
    } finally {
      restore();
    }
  });

  it('input handler deferral preserves response adcp_version metadata', async () => {
    const capture = [];
    const restore = stubProtocolClient({
      response: {
        structuredContent: {
          status: 'input-required',
          question: 'Approve this buy?',
          field: 'approval',
          adcp_version: '3.1-beta.5',
        },
      },
      capture,
    });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams, async () => ({
        defer: true,
        token: 'deferred-token-1',
      }));
      assert.equal(result.status, 'deferred');
      assert.equal(result.metadata.adcpVersion, '3.1-beta.5');
    } finally {
      restore();
    }
  });

  it('adcp_version omitted is surfaced as undefined', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: buildResponse(), capture });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams);
      assert.equal(result.metadata.adcpVersion, undefined);
    } finally {
      restore();
    }
  });
});

describe('TaskExecutor surfaces typed error instances on IDEMPOTENCY_CONFLICT/EXPIRED', () => {
  function failedResponse(code) {
    return {
      structuredContent: {
        status: 'failed',
        adcp_error: { code, message: `seller returned ${code}` },
      },
      content: [{ type: 'text', text: JSON.stringify({ status: 'failed', adcp_error: { code } }) }],
    };
  }

  it('IDEMPOTENCY_CONFLICT response → result.errorInstance is IdempotencyConflictError with the sent key', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: failedResponse('IDEMPOTENCY_CONFLICT'), capture });
    try {
      const executor = new TaskExecutor();
      const myKey = 'my_persisted_key_abcdefghij1234';
      const result = await executor.executeTask(agent, 'create_media_buy', {
        ...baseParams,
        idempotency_key: myKey,
      });
      assert.equal(result.success, false);
      assert.equal(result.adcpError?.code, 'IDEMPOTENCY_CONFLICT');
      assert.ok(result.errorInstance instanceof IdempotencyConflictError, 'expected typed error instance');
      assert.equal(result.errorInstance.idempotencyKey, myKey);
    } finally {
      restore();
    }
  });

  it('IDEMPOTENCY_EXPIRED response → result.errorInstance is IdempotencyExpiredError', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: failedResponse('IDEMPOTENCY_EXPIRED'), capture });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams);
      assert.equal(result.success, false);
      assert.ok(result.errorInstance instanceof IdempotencyExpiredError);
    } finally {
      restore();
    }
  });

  it('non-idempotency errors leave errorInstance undefined', async () => {
    const capture = [];
    const restore = stubProtocolClient({ response: failedResponse('RATE_LIMITED'), capture });
    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(agent, 'create_media_buy', baseParams);
      assert.equal(result.success, false);
      assert.equal(result.errorInstance, undefined);
    } finally {
      restore();
    }
  });
});

describe('MUTATING_TASKS set is intact (guards against Zod internals drift)', () => {
  it('covers the canonical mutating tools', () => {
    assert.ok(isMutatingTask('create_media_buy'));
    assert.ok(isMutatingTask('update_media_buy'));
    assert.ok(isMutatingTask('sync_creatives'));
    assert.ok(isMutatingTask('activate_signal'));
    assert.ok(isMutatingTask('si_send_message'));
    assert.ok(isMutatingTask('sync_accounts'));
    assert.ok(isMutatingTask('log_event'));
  });

  it('excludes read-only tools and the naturally-idempotent terminate', () => {
    assert.ok(!isMutatingTask('get_products'));
    assert.ok(!isMutatingTask('get_media_buys'));
    assert.ok(!isMutatingTask('list_creatives'));
    assert.ok(!isMutatingTask('si_terminate_session'));
  });
});
