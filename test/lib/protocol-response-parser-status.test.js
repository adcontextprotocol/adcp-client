// Regression tests for ProtocolResponseParser.getStatus() — issue #646.
//
// Shared ADCP_STATUS literals (completed/canceled/failed/rejected) collide
// with AdCP v3 domain status enums such as MediaBuyStatus. When a seller
// returns a spec-compliant domain envelope via MCP `structuredContent`, the
// parser must NOT misclassify it as an MCP task-status envelope — otherwise
// TaskExecutor terminal-fails with `data: undefined`.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const { ProtocolResponseParser, ADCP_STATUS, TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');

const parser = new ProtocolResponseParser();

describe('ProtocolResponseParser.getStatus — enum collision (issue #646)', () => {
  describe('shared-literal status + domain payload → falls through to COMPLETED', () => {
    test('cancel_media_buy envelope with status="canceled" + media_buy payload', () => {
      const response = {
        structuredContent: {
          status: 'canceled',
          media_buy: { media_buy_id: 'mb_abc', status: 'canceled' },
          adcp_version: '3.0.0',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('create_media_buy envelope with status="completed" + media_buy payload', () => {
      const response = {
        structuredContent: {
          status: 'completed',
          media_buy: { media_buy_id: 'mb_abc', status: 'active' },
          adcp_version: '3.0.0',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('creative envelope with status="rejected" + creative payload', () => {
      const response = {
        structuredContent: {
          status: 'rejected',
          creative: { creative_id: 'c_123', status: 'rejected', reason: 'policy' },
          adcp_version: '3.0.0',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('sync_accounts envelope with status="failed" + accounts payload', () => {
      const response = {
        structuredContent: {
          status: 'failed',
          accounts: [{ account_id: 'acc_1' }],
          adcp_version: '3.0.0',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });
  });

  describe('bare task envelope with shared-literal status → task status (backward compat)', () => {
    test('status="canceled" with only envelope fields', () => {
      const response = {
        structuredContent: {
          status: 'canceled',
          message: 'Task canceled by caller',
          task_id: 't_123',
          context_id: 'ctx_1',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.CANCELED);
    });

    test('status="completed" with only envelope fields', () => {
      const response = {
        structuredContent: {
          status: 'completed',
          task_id: 't_123',
          adcp_version: '3.0.0',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('status="failed" with errors array only', () => {
      const response = {
        structuredContent: {
          status: 'failed',
          errors: [{ code: 'E_BAD', message: 'bad' }],
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.FAILED);
    });

    test('status="rejected" with only envelope fields', () => {
      const response = {
        structuredContent: {
          status: 'rejected',
          message: 'Policy violation',
          task_id: 't_rej',
          context_id: 'ctx_1',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.REJECTED);
    });

    test('envelope with context and ext fields only', () => {
      const response = {
        structuredContent: {
          status: 'completed',
          task_id: 't_1',
          context: { correlation_id: 'c_1' },
          ext: { custom: true },
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('envelope with push_notification_config and governance_context', () => {
      const response = {
        structuredContent: {
          status: 'completed',
          task_id: 't_1',
          push_notification_config: { url: 'https://cb.test/x', token: 'tok' },
          governance_context: 'eyJ...jws',
          timestamp: '2026-04-20T00:00:00Z',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });
  });

  describe('exclusive-to-task statuses trusted unconditionally', () => {
    test('status="working" with domain payload alongside', () => {
      const response = {
        structuredContent: {
          status: 'working',
          media_buy: { media_buy_id: 'mb_abc' },
          task_id: 't_123',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.WORKING);
    });

    test('status="submitted"', () => {
      const response = {
        structuredContent: { status: 'submitted', task_id: 't_123' },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
    });

    test('status="input-required"', () => {
      const response = {
        structuredContent: { status: 'input-required', message: 'need more info' },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.INPUT_REQUIRED);
    });

    test('status="auth-required"', () => {
      const response = {
        structuredContent: { status: 'auth-required', message: 'auth required' },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.AUTH_REQUIRED);
    });
  });

  describe('unchanged branches — no regression', () => {
    test('A2A JSON-RPC wrapped status.state="canceled" → CANCELED', () => {
      const response = { result: { status: { state: 'canceled' } } };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.CANCELED);
    });

    test('A2A JSON-RPC wrapped status.state="working" → WORKING', () => {
      const response = { result: { status: { state: 'working' } } };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.WORKING);
    });

    test('top-level status="submitted" → SUBMITTED', () => {
      const response = { status: 'submitted', task_id: 't_1' };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
    });

    test('MCP isError=true → FAILED', () => {
      const response = { isError: true, content: [{ type: 'text', text: 'boom' }] };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.FAILED);
    });

    test('structuredContent without status → COMPLETED fallback', () => {
      const response = {
        structuredContent: { products: [{ product_id: 'p1' }] },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('response with content only → COMPLETED', () => {
      const response = { content: [{ type: 'text', text: 'ok' }] };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('empty response → null', () => {
      assert.strictEqual(parser.getStatus({}), null);
    });
  });

  describe('edge cases', () => {
    test('unknown status string on structuredContent → fallback COMPLETED', () => {
      const response = {
        structuredContent: { status: 'weird-status', media_buy: { media_buy_id: 'x' } },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('replayed envelope field does not count as domain key', () => {
      const response = {
        structuredContent: {
          status: 'completed',
          replayed: true,
          task_id: 't_1',
          adcp_version: '3.0.0',
        },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });

    test('status="unknown" bare envelope returns UNKNOWN (documents intent)', () => {
      const response = {
        structuredContent: { status: 'unknown', task_id: 't_1' },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.UNKNOWN);
    });

    test('status="unknown" with domain payload falls through to COMPLETED', () => {
      const response = {
        structuredContent: { status: 'unknown', media_buy: { media_buy_id: 'x' } },
      };
      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });
  });
});

describe('TaskExecutor — cancel_media_buy end-to-end (issue #646)', () => {
  const mockAgent = {
    id: 'test-seller',
    name: 'Test Seller',
    agent_uri: 'https://seller.test',
    protocol: 'mcp',
  };
  let originalCallTool;

  beforeEach(() => {
    originalCallTool = ProtocolClient.callTool;
  });
  afterEach(() => {
    if (originalCallTool) ProtocolClient.callTool = originalCallTool;
  });

  test('returns success=true with media_buy data when seller returns canceled domain envelope', async () => {
    const mediaBuy = {
      media_buy_id: 'mb_abc',
      status: 'canceled',
      buyer_ref: 'ref-1',
      packages: [],
    };
    ProtocolClient.callTool = mock.fn(async () => ({
      structuredContent: {
        status: 'canceled',
        media_buy: mediaBuy,
        adcp_version: '3.0.0',
      },
    }));

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'cancel_media_buy', {
      media_buy_id: 'mb_abc',
      reason: 'buyer_cancel',
    });

    assert.strictEqual(result.success, true, 'should succeed, not terminal-fail');
    assert.strictEqual(result.status, 'completed');
    assert.ok(result.data, 'data should be populated, not undefined');
    assert.deepStrictEqual(result.data.media_buy, mediaBuy);
    assert.notStrictEqual(result.error, 'Task canceled');
  });
});
