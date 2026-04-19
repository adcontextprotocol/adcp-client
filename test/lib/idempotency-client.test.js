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

function buildResponse({ replayed } = {}) {
  return {
    structuredContent: {
      status: 'completed',
      ...(replayed !== undefined && { replayed }),
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
