// Regression tests for ProtocolResponseParser — issue #973.
//
// For A2A wrapped Task responses (`result.kind === 'task'`), the parser
// must prefer the AdCP work-layer fields surfaced via the artifact
// (`artifact.parts[0].data.status`, `artifact.metadata.adcp_task_id`)
// over the transport-layer fields (`result.status.state`, `result.id`).
// Per adcp-client#899's two-lifecycle contract:
//
//   - `Task.state` reflects the HTTP-call lifecycle — always
//     `'completed'` for AdCP submitted arms (the call returned, the
//     work is queued).
//   - `data.status` reflects the AdCP work lifecycle — `'submitted'`,
//     `'working'`, `'completed'`, etc.
//
//   - `Task.id` is the A2A SDK-generated transport handle (pinned to
//     one HTTP call).
//   - `artifact.metadata.adcp_task_id` is the AdCP work handle (the
//     thing the buyer polls with).
//
// Pre-fix: `getStatus` returned `'completed'` for every A2A submitted
// arm (read from `result.status.state`), preventing
// `TaskExecutor.handleAsyncResponse` from ever entering the SUBMITTED
// branch. `getTaskId` returned the A2A Task.id (which the seller's
// AdCP `tasks/get` tool would not recognize).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { ProtocolResponseParser, ADCP_STATUS } = require('../../dist/lib/index.js');

const parser = new ProtocolResponseParser();

function a2aWrappedSubmittedResponse({ adcpTaskId = 'tk_X', a2aTaskId = 'a2a-uuid', adcpStatus = 'submitted' } = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      kind: 'task',
      id: a2aTaskId,
      contextId: 'ctx-uuid',
      // Per #899: A2A Task.state is 'completed' for AdCP submitted arms.
      // Pre-fix the parser read this and called the response 'completed'.
      status: { state: 'completed', timestamp: '2026-04-25T00:00:00Z' },
      artifacts: [
        {
          artifactId: 'art-uuid',
          name: 'submitted',
          parts: [
            {
              kind: 'data',
              data: { status: adcpStatus, task_id: adcpTaskId },
            },
          ],
          metadata: { adcp_task_id: adcpTaskId },
        },
      ],
    },
  };
}

describe('ProtocolResponseParser.getStatus — A2A submitted arm (#973)', () => {
  test('reads AdCP `data.status` from the artifact for submitted arms (NOT transport `Task.state`)', () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'submitted' });
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });

  test('handles AdCP `working` status from the artifact', () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'working' });
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.WORKING);
  });

  test('handles AdCP `failed` status from the artifact', () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'failed' });
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.FAILED);
  });

  test('falls back to transport `Task.state` for non-AdCP A2A responses (no artifact)', () => {
    // Pure A2A Task with no artifact-borne AdCP payload — return the
    // transport-layer state. This is the pre-fix behavior preserved
    // for non-AdCP A2A responses.
    const response = {
      result: {
        kind: 'task',
        id: 'a2a-uuid',
        contextId: 'ctx-uuid',
        status: { state: 'completed', timestamp: '2026-04-25T00:00:00Z' },
        artifacts: [],
      },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('falls back when artifact has no DataPart', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].parts = [{ kind: 'text', text: 'hi' }];
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('falls back when DataPart `data.status` is not an ADCP_STATUS value', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].parts[0].data.status = 'pending_approval'; // not an AdCP task status
    // The artifact extractor returns undefined → fall through to the
    // transport-layer state.
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('AdCP completed surfaces from artifact even when transport says completed (idempotent)', () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'completed' });
    // Both layers say completed; either path returns COMPLETED. Test
    // pins that the AdCP-layer extractor doesn't error on the happy
    // path.
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('does not touch non-A2A responses (MCP structuredContent unaffected)', () => {
    const response = {
      structuredContent: { status: 'submitted', task_id: 'tk_X' },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });
});

describe('ProtocolResponseParser.getTaskId — A2A submitted arm (#973)', () => {
  test('reads `artifact.metadata.adcp_task_id` for AdCP submitted arms (NOT A2A `result.id`)', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_seller', a2aTaskId: 'a2a-transport-id' });
    assert.strictEqual(parser.getTaskId(response), 'tk_seller');
  });

  test('falls back to transport `result.id` for A2A responses without metadata', () => {
    const response = a2aWrappedSubmittedResponse();
    delete response.result.artifacts[0].metadata;
    assert.strictEqual(parser.getTaskId(response), 'a2a-uuid');
  });

  test('falls back when artifact metadata has no `adcp_task_id`', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].metadata = { other_extension: 'value' };
    assert.strictEqual(parser.getTaskId(response), 'a2a-uuid');
  });

  test('falls back when artifacts array is empty', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts = [];
    assert.strictEqual(parser.getTaskId(response), 'a2a-uuid');
  });

  test('rejects malformed `adcp_task_id` (control chars, overlong) and falls back', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].metadata.adcp_task_id = 'tk\x00with-null';
    // Malformed value rejected by `firstSafeSessionId` (control chars
    // banned). Falls through to `result.id`.
    assert.strictEqual(parser.getTaskId(response), 'a2a-uuid');
  });

  test('does not touch MCP responses', () => {
    const response = { structuredContent: { task_id: 'mcp-tk-1' } };
    assert.strictEqual(parser.getTaskId(response), 'mcp-tk-1');
  });

  test('flat AdCP envelope (no result wrapping) reads response.task_id directly', () => {
    const response = { task_id: 'flat-tk-2' };
    assert.strictEqual(parser.getTaskId(response), 'flat-tk-2');
  });
});
