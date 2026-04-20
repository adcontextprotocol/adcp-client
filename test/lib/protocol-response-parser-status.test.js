// Regression tests for ProtocolResponseParser.getStatus() — see issue #646.
//
// ADCP_STATUS (MCP task lifecycle) shares literals with AdCP v3 domain status
// enums (e.g. MediaBuyStatus: "completed", "canceled"). The parser must NOT
// misclassify a domain response whose `status` happens to be a shared literal
// as an MCP task state, because TaskExecutor's terminal-state branches skip
// Zod validation and return data:undefined.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { ProtocolResponseParser, ADCP_STATUS } = require('../../dist/lib/core/ProtocolResponseParser.js');

describe('ProtocolResponseParser.getStatus — domain vs task status collision (#646)', () => {
  const parser = new ProtocolResponseParser();

  test('domain response with status:"canceled" and domain payload → COMPLETED', () => {
    // Simulates a spec-compliant cancel_media_buy envelope.
    const response = {
      structuredContent: {
        status: 'canceled',
        media_buy: { media_buy_id: 'mb_abc', status: 'canceled' },
        adcp_version: '3.0.0',
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('domain response with status:"completed" and domain payload → COMPLETED', () => {
    const response = {
      structuredContent: {
        status: 'completed',
        media_buy: { media_buy_id: 'mb_abc' },
        adcp_version: '3.0.0',
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('domain response with status:"rejected" and domain payload → COMPLETED (payload drives validation)', () => {
    const response = {
      structuredContent: {
        status: 'rejected',
        media_buy: { media_buy_id: 'mb_abc', status: 'rejected' },
        adcp_version: '3.0.0',
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('bare task envelope with status:"canceled" (no domain payload) → CANCELED', () => {
    // True MCP task envelope: only envelope-level keys.
    const response = {
      structuredContent: {
        status: 'canceled',
        message: 'Task canceled by user',
        adcp_version: '3.0.0',
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.CANCELED);
  });

  test('bare task envelope with status:"completed" (no domain payload) → COMPLETED', () => {
    const response = {
      structuredContent: {
        status: 'completed',
        adcp_version: '3.0.0',
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('task-only state "working" with domain payload still classifies as WORKING', () => {
    // Server returning partial data while still processing.
    const response = {
      structuredContent: {
        status: 'working',
        media_buy: { media_buy_id: 'mb_abc' },
        adcp_version: '3.0.0',
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.WORKING);
  });

  test('task-only state "submitted" with domain payload still classifies as SUBMITTED', () => {
    const response = {
      structuredContent: {
        status: 'submitted',
        task_id: 'tsk_123',
        media_buy: { media_buy_id: 'mb_abc' },
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });

  test('input-required with domain payload still classifies as INPUT_REQUIRED', () => {
    const response = {
      structuredContent: {
        status: 'input-required',
        question: 'Confirm?',
        media_buy: { media_buy_id: 'mb_abc' },
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.INPUT_REQUIRED);
  });

  test('top-level status still honored (A2A / direct responses unchanged)', () => {
    assert.strictEqual(parser.getStatus({ status: 'canceled' }), ADCP_STATUS.CANCELED);
    assert.strictEqual(parser.getStatus({ status: 'completed' }), ADCP_STATUS.COMPLETED);
  });

  test('A2A wrapped status still honored', () => {
    const response = { result: { status: { state: 'canceled' } } };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.CANCELED);
  });

  test('isError=true still returns FAILED', () => {
    assert.strictEqual(parser.getStatus({ isError: true }), ADCP_STATUS.FAILED);
  });

  test('response with only content (no status) → COMPLETED', () => {
    assert.strictEqual(
      parser.getStatus({ content: [{ type: 'text', text: 'ok' }] }),
      ADCP_STATUS.COMPLETED,
    );
  });

  test('null/undefined/empty response → null', () => {
    assert.strictEqual(parser.getStatus(null), null);
    assert.strictEqual(parser.getStatus(undefined), null);
    assert.strictEqual(parser.getStatus({}), null);
  });
});
