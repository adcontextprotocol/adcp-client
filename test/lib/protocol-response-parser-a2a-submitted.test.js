// Regression tests for ProtocolResponseParser — issue #973.
//
// For A2A wrapped Task responses (`result.kind === 'task'`), the parser
// must prefer the AdCP work-layer fields surfaced via the artifact
// (`artifact.parts[0].data.status`, `artifact.parts[0].data.task_id`,
// `artifact.metadata.adcp_task_id`)
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

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const { ProtocolResponseParser, ADCP_STATUS, TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');

const parser = new ProtocolResponseParser();

function a2aWrappedSubmittedResponse({
  adcpTaskId = 'tk_X',
  a2aTaskId = 'a2a-uuid',
  adcpStatus = 'submitted',
  adcpVersion,
} = {}) {
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
              data: { status: adcpStatus, task_id: adcpTaskId, ...(adcpVersion && { adcp_version: adcpVersion }) },
            },
          ],
          metadata: { adcp_task_id: adcpTaskId },
        },
      ],
    },
  };
}

function a2aWrappedCompletedArtifactData(data) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      kind: 'task',
      id: 'a2a-uuid',
      contextId: 'ctx-uuid',
      status: { state: 'completed', timestamp: '2026-05-26T00:00:00Z' },
      artifacts: [
        {
          artifactId: 'art-uuid',
          parts: [{ kind: 'data', data }],
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

describe('ProtocolResponseParser.getStatus — A2A artifact domain status collision (#2009)', () => {
  test('domain payload status="canceled" falls back to completed transport state', () => {
    const response = a2aWrappedCompletedArtifactData({
      media_buy_id: 'mb_canceled',
      status: 'canceled',
      affected_packages: [],
      context: { correlation_id: 'corr-1' },
    });
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  for (const status of ['failed', 'rejected']) {
    test(`domain payload status="${status}" falls back to completed transport state`, () => {
      const response = a2aWrappedCompletedArtifactData({
        creative_id: `cr_${status}`,
        status,
        review_feedback: 'Domain object status, not task lifecycle status',
      });

      assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    });
  }

  test('envelope-only artifact status="canceled" remains a task cancellation', () => {
    const response = a2aWrappedCompletedArtifactData({
      status: 'canceled',
      message: 'Task canceled by caller',
      task_id: 'tk_canceled',
    });
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.CANCELED);
  });

  test('exclusive task status wins even when other fields are present', () => {
    const response = a2aWrappedCompletedArtifactData({
      status: 'submitted',
      media_buy_id: 'mb_async',
      task_id: 'tk_submitted',
    });
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });

  test('uses latest artifact status, not stale first artifact status', () => {
    const response = a2aWrappedCompletedArtifactData({
      status: 'submitted',
      task_id: 'tk_stale',
    });
    response.result.artifacts.push({
      artifactId: 'art-final',
      parts: [
        {
          kind: 'data',
          data: {
            media_buy_id: 'mb_canceled',
            status: 'canceled',
            affected_packages: [],
          },
        },
      ],
    });

    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('ignores trailing text-only artifact when reading task status', () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'submitted', adcpTaskId: 'tk_submitted' });
    response.result.artifacts.push({
      artifactId: 'art-progress-text',
      metadata: { adcp_task_id: 'tk_latest_text' },
      parts: [{ kind: 'text', text: 'Submitted for async processing' }],
    });

    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });
});

describe('ProtocolResponseParser.getTaskId — A2A submitted arm (#973)', () => {
  test('reads `artifact.metadata.adcp_task_id` for AdCP submitted arms (NOT A2A `result.id`)', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_seller', a2aTaskId: 'a2a-transport-id' });
    assert.strictEqual(parser.getTaskId(response), 'tk_seller');
  });

  test('reads AdCP DataPart `task_id` for A2A responses without metadata', () => {
    const response = a2aWrappedSubmittedResponse();
    delete response.result.artifacts[0].metadata;
    assert.strictEqual(parser.getTaskId(response), 'tk_X');
  });

  test('reads AdCP DataPart `task_id` when artifact metadata has no task handle', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].metadata = { other_extension: 'value' };
    assert.strictEqual(parser.getTaskId(response), 'tk_X');
  });

  test('falls back when artifacts array is empty', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts = [];
    assert.strictEqual(parser.getTaskId(response), 'a2a-uuid');
  });

  test('reads adcp_task_id from the latest artifact metadata', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_stale' });
    response.result.artifacts.push({
      artifactId: 'art-final',
      metadata: { adcp_task_id: 'tk_latest' },
      parts: [{ kind: 'data', data: { status: 'submitted', task_id: 'tk_latest' } }],
    });

    assert.strictEqual(parser.getTaskId(response), 'tk_latest');
  });

  test('reads adcp_task_id from trailing text-only artifact metadata when DataPart omits task_id', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_stale' });
    delete response.result.artifacts[0].parts[0].data.task_id;
    response.result.artifacts.push({
      artifactId: 'art-progress-text',
      metadata: { adcp_task_id: 'tk_latest_text' },
      parts: [{ kind: 'text', text: 'Submitted for async processing' }],
    });

    assert.strictEqual(parser.getTaskId(response), 'tk_latest_text');
  });

  test('reads serverTaskId compatibility alias from artifact metadata', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_data' });
    delete response.result.artifacts[0].parts[0].data.task_id;
    response.result.artifacts[0].metadata = { serverTaskId: 'tk_server_meta' };
    assert.strictEqual(parser.getTaskId(response), 'tk_server_meta');
  });

  test('prefers DataPart task_id when artifact metadata serverTaskId conflicts', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_data' });
    response.result.artifacts[0].metadata = { serverTaskId: 'tk_server_meta' };
    assert.strictEqual(parser.getTaskId(response), 'tk_data');
  });

  test('prefers DataPart task_id when artifact metadata adcp_task_id conflicts', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_data' });
    response.result.artifacts[0].metadata = { adcp_task_id: 'tk_meta' };
    assert.strictEqual(parser.getTaskId(response), 'tk_data');
  });

  test('ignores generic artifact metadata taskId when DataPart has AdCP task_id', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_data' });
    response.result.artifacts[0].metadata = { taskId: 'a2a-local-task' };
    assert.strictEqual(parser.getTaskId(response), 'tk_data');
  });

  test('reads serverTaskId compatibility alias from A2A result metadata', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_data' });
    delete response.result.artifacts;
    response.result.metadata = { serverTaskId: 'tk_result_meta' };
    assert.strictEqual(parser.getTaskId(response), 'tk_result_meta');
  });

  test('rejects malformed `adcp_task_id` (control chars, overlong) and falls back', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].metadata.adcp_task_id = 'tk\x00with-null';
    // Malformed value rejected by `firstSafeSessionId` (control chars
    // banned). Falls through to the AdCP DataPart handle.
    assert.strictEqual(parser.getTaskId(response), 'tk_X');
  });

  test('does not touch MCP responses', () => {
    const response = { structuredContent: { task_id: 'mcp-tk-1' } };
    assert.strictEqual(parser.getTaskId(response), 'mcp-tk-1');
  });

  test('flat AdCP envelope (no result wrapping) reads response.task_id directly', () => {
    const response = { task_id: 'flat-tk-2' };
    assert.strictEqual(parser.getTaskId(response), 'flat-tk-2');
  });

  test('flat AdCP task_id wins over raw MCP data wrapper task_id', () => {
    const response = { status: 'submitted', task_id: 'flat-tk-3', data: { task_id: 'mcp-data-tk-shadow' } };
    assert.strictEqual(parser.getTaskId(response), 'flat-tk-3');
  });

  test('raw MCP data wrapper reads data.task_id', () => {
    const response = { status: 'submitted', data: { task_id: 'mcp-data-tk-1' } };
    assert.strictEqual(parser.getTaskId(response), 'mcp-data-tk-1');
  });

  test('raw MCP data wrapper exposes data.status as task status', () => {
    const response = { data: { status: 'submitted', task_id: 'mcp-data-tk-2' } };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });

  test('raw MCP data task status preempts wrapper-level completed status', () => {
    const response = { status: 'completed', data: { status: 'submitted', task_id: 'mcp-data-tk-3' } };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
  });

  test('raw MCP data terminal task status preempts wrapper-level completed status', () => {
    const response = {
      status: 'completed',
      data: { status: 'failed', task_id: 'mcp-data-tk-4', errors: [{ code: 'E_BAD', message: 'bad' }] },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.FAILED);
  });

  test('raw MCP data domain status does not preempt wrapper-level completed status', () => {
    const response = {
      status: 'completed',
      data: { status: 'canceled', media_buy: { media_buy_id: 'mb_1', status: 'canceled' } },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
  });

  test('raw MCP data wrapper cannot override official structuredContent status or task_id', () => {
    const response = {
      structuredContent: { status: 'completed', task_id: 'mcp-official-tk' },
      data: { status: 'submitted', task_id: 'mcp-data-tk-5' },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    assert.strictEqual(parser.getTaskId(response), 'mcp-official-tk');
  });

  test('raw MCP data wrapper cannot override official content response', () => {
    const response = {
      content: [{ type: 'text', text: 'ok' }],
      data: { status: 'submitted', task_id: 'mcp-data-tk-6' },
    };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.COMPLETED);
    assert.strictEqual(parser.getTaskId(response), undefined);
  });

  test('raw MCP data wrapper cannot override official A2A result response', () => {
    const response = a2aWrappedSubmittedResponse({ adcpTaskId: 'tk_a2a_official' });
    response.data = { status: 'submitted', task_id: 'mcp-data-tk-7' };
    assert.strictEqual(parser.getStatus(response), ADCP_STATUS.SUBMITTED);
    assert.strictEqual(parser.getTaskId(response), 'tk_a2a_official');
  });
});

describe('ProtocolResponseParser.getAdcpVersion', () => {
  test('reads adcp_version from MCP structuredContent', () => {
    assert.strictEqual(parser.getAdcpVersion({ structuredContent: { adcp_version: '3.1-beta.5' } }), '3.1-beta.5');
  });

  test('reads adcp_version from flat AdCP envelope', () => {
    assert.strictEqual(parser.getAdcpVersion({ adcp_version: '3.0' }), '3.0');
  });

  test('reads adcp_version from A2A task DataPart', () => {
    const response = a2aWrappedSubmittedResponse({ adcpVersion: '3.1' });
    assert.strictEqual(parser.getAdcpVersion(response), '3.1');
  });

  test('reads adcp_version from nested A2A task DataPart response wrapper', () => {
    const response = a2aWrappedSubmittedResponse();
    response.result.artifacts[0].parts[0].data = {
      response: {
        status: 'completed',
        adcp_version: '3.1-beta.2',
      },
    };
    assert.strictEqual(parser.getAdcpVersion(response), '3.1-beta.2');
  });

  test('reads adcp_version from latest A2A message DataPart', () => {
    assert.strictEqual(
      parser.getAdcpVersion({
        result: {
          kind: 'message',
          parts: [
            {
              kind: 'data',
              data: { adcp_version: '3.0' },
            },
            {
              kind: 'data',
              data: { adcp_version: '3.1' },
            },
          ],
        },
      }),
      '3.1'
    );
  });

  test('reads adcp_version from MCP JSON text fallback', () => {
    assert.strictEqual(
      parser.getAdcpVersion({
        content: [{ type: 'text', text: JSON.stringify({ status: 'completed', adcp_version: '3.1-beta.5' }) }],
      }),
      '3.1-beta.5'
    );
  });

  test('reads adcp_version from legacy tasks/get task wrapper', () => {
    assert.strictEqual(
      parser.getAdcpVersion({
        task: {
          status: 'completed',
          adcp_version: '3.1-beta.5',
        },
      }),
      '3.1-beta.5'
    );
  });

  test('reads adcp_version from nested legacy tasks/get task response wrapper', () => {
    assert.strictEqual(
      parser.getAdcpVersion({
        task: {
          response: {
            status: 'completed',
            adcp_version: '3.1-beta.5',
          },
        },
      }),
      '3.1-beta.5'
    );
  });

  test('ignores response.adcp_version when response is domain payload data', () => {
    assert.strictEqual(
      parser.getAdcpVersion({
        result: {
          kind: 'task',
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    session_id: 'si_session_1',
                    session_status: 'active',
                    response: {
                      text: 'Business payload, not an AdCP envelope',
                      adcp_version: 'domain-data-not-envelope',
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
      undefined
    );

    assert.strictEqual(
      parser.getAdcpVersion({
        result: {
          kind: 'task',
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    session_id: 'si_session_2',
                    session_status: 'active',
                    response: {
                      status: 'active',
                      adcp_version: 'domain-status-not-envelope',
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
      undefined
    );
  });

  test('reads nested response.adcp_version when nested response is envelope-like', () => {
    assert.strictEqual(
      parser.getAdcpVersion({
        task: {
          response: {
            status: 'completed',
            errors: [],
            adcp_version: '3.1-beta.5',
          },
        },
      }),
      '3.1-beta.5'
    );
  });

  test('returns undefined when adcp_version is absent or non-string', () => {
    assert.strictEqual(parser.getAdcpVersion({ structuredContent: { adcp_version: 3.1 } }), undefined);
    assert.strictEqual(parser.getAdcpVersion({ content: [{ type: 'text', text: 'not json' }] }), undefined);
    assert.strictEqual(parser.getAdcpVersion({}), undefined);
  });
});

describe('TaskExecutor — A2A update_media_buy canceled domain payload (#2009)', () => {
  const mockAgent = {
    id: 'test-a2a-seller',
    name: 'Test A2A Seller',
    agent_uri: 'https://seller.test',
    protocol: 'a2a',
  };
  let originalCallTool;

  beforeEach(() => {
    originalCallTool = ProtocolClient.callTool;
  });

  afterEach(() => {
    if (originalCallTool) ProtocolClient.callTool = originalCallTool;
  });

  test('returns success when completed A2A task artifact has domain status="canceled"', async () => {
    const payload = {
      media_buy_id: 'mb_canceled',
      status: 'canceled',
      revision: 2,
      affected_packages: [],
      context: { correlation_id: 'corr-1' },
      _message: 'Completed update_media_buy',
    };
    ProtocolClient.callTool = mock.fn(async () => a2aWrappedCompletedArtifactData(payload));

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'update_media_buy', {
      media_buy_id: 'mb_canceled',
      canceled: true,
      cancellation_reason: 'buyer_cancel',
    });

    assert.strictEqual(result.success, true, 'should succeed, not terminal-fail');
    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(result.data, { ...payload, media_buy_status: 'canceled' });
    assert.notStrictEqual(result.error, 'Task canceled');
  });

  test('keeps submitted continuation when a text-only artifact follows the submitted DataPart', async () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'submitted', adcpTaskId: 'tk_submitted' });
    response.result.artifacts.push({
      artifactId: 'art-progress-text',
      metadata: { adcp_task_id: 'tk_latest_text' },
      parts: [{ kind: 'text', text: 'Submitted for async processing' }],
    });
    ProtocolClient.callTool = mock.fn(async () => response);

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'submitted');
    assert.strictEqual(result.submitted.taskId, 'tk_submitted');
  });

  test('surfaces A2A DataPart adcp_version on result metadata', async () => {
    ProtocolClient.callTool = mock.fn(async () =>
      a2aWrappedCompletedArtifactData({
        adcp_version: '3.1-beta.5',
        media_buy_id: 'mb_a2a_version',
        media_buy_status: 'pending_creatives',
        packages: [],
      })
    );

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.metadata.adcpVersion, '3.1-beta.5');
  });

  test('normalizes A2A metadata.serverTaskId into submitted.taskId', async () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'submitted', adcpTaskId: 'tk_data' });
    delete response.result.artifacts[0].parts[0].data.task_id;
    response.result.artifacts[0].metadata = { serverTaskId: 'tk_server_meta' };
    ProtocolClient.callTool = mock.fn(async () => response);

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'submitted');
    assert.strictEqual(result.submitted.taskId, 'tk_server_meta');
    assert.strictEqual(result.metadata.serverTaskId, 'tk_server_meta');
  });

  test('normalizes A2A result.metadata.serverTaskId into submitted.taskId', async () => {
    const response = a2aWrappedSubmittedResponse({ adcpStatus: 'submitted', adcpTaskId: 'tk_data' });
    delete response.result.artifacts[0].metadata;
    delete response.result.artifacts[0].parts[0].data.task_id;
    response.result.metadata = { serverTaskId: 'tk_result_meta' };
    ProtocolClient.callTool = mock.fn(async () => response);

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'submitted');
    assert.strictEqual(result.submitted.taskId, 'tk_result_meta');
    assert.strictEqual(result.metadata.serverTaskId, 'tk_result_meta');
  });

  test('A2A wrapped tasks/get adcp_version flows through submitted waitForCompletion metadata', async () => {
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get' || taskName === 'tasks_get') {
        return a2aWrappedCompletedArtifactData({
          status: 'completed',
          task_id: 'tk_poll_a2a',
          task_type: 'create_media_buy',
          adcp_version: '3.1-beta.5',
          result: {
            media_buy_id: 'mb_poll_a2a',
            media_buy_status: 'pending_creatives',
            packages: [],
          },
        });
      }
      return a2aWrappedSubmittedResponse({ adcpStatus: 'submitted', adcpTaskId: 'tk_poll_a2a' });
    });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const submitted = await executor.executeTask(mockAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });
    const result = await submitted.submitted.waitForCompletion(10);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.metadata.adcpVersion, '3.1-beta.5');
  });

  test('A2A wrapped tasks/get DataPart wins over sibling raw data in waitForCompletion', async () => {
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get' || taskName === 'tasks_get') {
        const response = a2aWrappedCompletedArtifactData({
          status: 'completed',
          task_id: 'tk_poll_a2a_official',
          task_type: 'create_media_buy',
          result: {
            media_buy_id: 'mb_poll_a2a_official',
            media_buy_status: 'pending_creatives',
            packages: [],
          },
        });
        response.data = {
          status: 'completed',
          task_id: 'tk_poll_a2a_raw',
          task_type: 'create_media_buy',
          result: {
            media_buy_id: 'mb_poll_a2a_raw',
            media_buy_status: 'rejected',
            packages: [],
          },
        };
        return response;
      }
      return a2aWrappedSubmittedResponse({ adcpStatus: 'submitted', adcpTaskId: 'tk_poll_a2a_official' });
    });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const submitted = await executor.executeTask(mockAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });
    const result = await submitted.submitted.waitForCompletion(10);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.metadata.serverTaskId, 'tk_poll_a2a_official');
    assert.deepStrictEqual(result.data, {
      media_buy_id: 'mb_poll_a2a_official',
      media_buy_status: 'pending_creatives',
      packages: [],
    });
  });
});

describe('TaskExecutor — submitted task handle normalization', () => {
  const mockMcpAgent = {
    id: 'test-mcp-seller',
    name: 'Test MCP Seller',
    agent_uri: 'https://seller.test/mcp',
    protocol: 'mcp',
  };
  let originalCallTool;

  beforeEach(() => {
    originalCallTool = ProtocolClient.callTool;
  });

  afterEach(() => {
    if (originalCallTool) ProtocolClient.callTool = originalCallTool;
  });

  test('normalizes raw MCP data.task_id into submitted.taskId', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({
      data: {
        status: 'submitted',
        task_id: 'mcp_raw_task_1',
      },
    }));

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockMcpAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'submitted');
    assert.strictEqual(result.submitted.taskId, 'mcp_raw_task_1');
    assert.strictEqual(result.metadata.serverTaskId, 'mcp_raw_task_1');
  });

  test('waitForCompletion unwraps raw MCP data-wrapped tasks_get completion', async () => {
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks_get') {
        return {
          data: {
            status: 'completed',
            task_id: 'mcp_raw_task_2',
            task_type: 'create_media_buy',
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:01Z',
            result: {
              media_buy_id: 'mb_raw_task_2',
              media_buy_status: 'pending_creatives',
              packages: [],
            },
          },
        };
      }

      return {
        data: {
          status: 'submitted',
          task_id: 'mcp_raw_task_2',
        },
      };
    });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const submitted = await executor.executeTask(mockMcpAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });
    const result = await submitted.submitted.waitForCompletion(10);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.metadata.serverTaskId, 'mcp_raw_task_2');
    assert.deepStrictEqual(result.data, {
      media_buy_id: 'mb_raw_task_2',
      media_buy_status: 'pending_creatives',
      packages: [],
    });
  });

  test('waitForCompletion prefers MCP structuredContent over sibling raw data in tasks_get', async () => {
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks_get') {
        return {
          structuredContent: {
            status: 'completed',
            task_id: 'mcp_official_task_3',
            task_type: 'create_media_buy',
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:01Z',
            result: {
              media_buy_id: 'mb_official_task_3',
              media_buy_status: 'pending_creatives',
              packages: [],
            },
          },
          data: {
            status: 'completed',
            task_id: 'mcp_raw_task_3',
            task_type: 'create_media_buy',
            result: {
              media_buy_id: 'mb_raw_task_3',
              media_buy_status: 'rejected',
              packages: [],
            },
          },
        };
      }

      return {
        data: {
          status: 'submitted',
          task_id: 'mcp_official_task_3',
        },
      };
    });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const submitted = await executor.executeTask(mockMcpAgent, 'create_media_buy', {
      buyer_ref: 'buyer-ref',
      packages: [],
    });
    const result = await submitted.submitted.waitForCompletion(10);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.metadata.serverTaskId, 'mcp_official_task_3');
    assert.deepStrictEqual(result.data, {
      media_buy_id: 'mb_official_task_3',
      media_buy_status: 'pending_creatives',
      packages: [],
    });
  });
});
