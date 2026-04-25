const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../dist/lib/testing/storyboard/validations.js');

const VALIDATION = {
  check: 'a2a_submitted_artifact',
  description: 'A2A submitted arm matches adcp-client#899 wire shape',
};

function ctx(envelope) {
  return {
    taskName: 'create_media_buy',
    agentUrl: 'https://example.com/a2a',
    contributions: new Set(),
    ...(envelope !== undefined && { a2aEnvelope: envelope }),
  };
}

function conformantEnvelope({ adcpTaskId = 'tk_async_1' } = {}) {
  return {
    result: {
      kind: 'task',
      id: 'a2a-task-uuid',
      contextId: 'a2a-context-uuid',
      status: { state: 'completed', timestamp: '2026-04-25T00:00:00Z' },
      artifacts: [
        {
          artifactId: 'artifact-uuid',
          name: 'submitted',
          parts: [{ kind: 'data', data: { status: 'submitted', task_id: adcpTaskId } }],
          metadata: { adcp_task_id: adcpTaskId },
        },
      ],
    },
    envelope: { jsonrpc: '2.0', id: 1, result: {} },
    http_status: 200,
  };
}

describe('a2a_submitted_artifact', () => {
  it('passes on the post-#899 conformant shape', () => {
    const [result] = runValidations([VALIDATION], ctx(conformantEnvelope()));
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.check, 'a2a_submitted_artifact');
  });

  it('passes with not_applicable observation when transport is non-A2A (no envelope)', () => {
    const [result] = runValidations([VALIDATION], ctx(undefined));
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('a2a_envelope_not_captured'));
  });

  it('fails when Task.state is "submitted" (pre-#899 regression: terminal state misuse)', () => {
    const env = conformantEnvelope();
    env.result.status.state = 'submitted';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/result/status/state');
    assert.strictEqual(result.expected, 'completed');
    assert.strictEqual(result.actual.failures[0].actual, 'submitted');
    assert.match(result.error, /A2A 0\.3\.0 forbids 'submitted' as a terminal state/);
  });

  it('fails when adcp_task_id is missing from artifact.metadata', () => {
    const env = conformantEnvelope();
    delete env.result.artifacts[0].metadata;
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.actual.failures.some(f => f.pointer === '/result/artifacts/0/metadata/adcp_task_id'),
      'failure names the metadata path'
    );
  });

  it('fails when data.adcp_task_id diverges from artifact.metadata.adcp_task_id (dual-write regression)', () => {
    const env = conformantEnvelope({ adcpTaskId: 'tk_async_meta' });
    // Divergent dual-write: data carries a different value than metadata
    env.result.artifacts[0].parts[0].data.adcp_task_id = 'tk_async_data_DIFFERENT';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.actual.failures.some(
        f =>
          f.pointer === '/result/artifacts/0/parts/0/data/adcp_task_id' && /Pre-#899 dual-write detected/.test(f.detail)
      ),
      `flags the divergent dual-write regression: ${JSON.stringify(result.actual.failures)}`
    );
  });

  it('fails when data.adcp_task_id is present but metadata.adcp_task_id is missing (pre-#899 solo-payload write)', () => {
    const env = conformantEnvelope();
    delete env.result.artifacts[0].metadata;
    env.result.artifacts[0].parts[0].data.adcp_task_id = 'tk_async_solo';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.actual.failures.some(
        f => f.pointer === '/result/artifacts/0/parts/0/data/adcp_task_id' && /Pre-#899 shape detected/.test(f.detail)
      ),
      'flags the solo-payload write (no matching metadata)'
    );
  });

  it('passes when data.adcp_task_id is present and equals metadata.adcp_task_id (allowed payload duplicate)', () => {
    const env = conformantEnvelope({ adcpTaskId: 'tk_dup' });
    env.result.artifacts[0].parts[0].data.adcp_task_id = 'tk_dup';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, true, `equal-key dual-write should pass: ${JSON.stringify(result)}`);
  });

  it('fails when artifact.parts[0].data.status !== "submitted"', () => {
    const env = conformantEnvelope();
    env.result.artifacts[0].parts[0].data.status = 'completed';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(result.actual.failures.some(f => f.pointer === '/result/artifacts/0/parts/0/data/status'));
  });

  it('reports the full pre-#899 regression class in one validation result', () => {
    const env = {
      result: {
        kind: 'task',
        id: 'a2a-task-uuid',
        contextId: 'a2a-context-uuid',
        status: { state: 'submitted', timestamp: '2026-04-25T00:00:00Z' },
        artifacts: [
          {
            artifactId: 'artifact-uuid',
            name: 'submitted',
            parts: [
              {
                kind: 'data',
                data: {
                  status: 'submitted',
                  task_id: 'tk_async_1',
                  adcp_task_id: 'tk_async_1',
                },
              },
            ],
          },
        ],
      },
      envelope: { jsonrpc: '2.0', id: 1, result: {} },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    const pointers = result.actual.failures.map(f => f.pointer);
    assert.ok(pointers.includes('/result/status/state'));
    assert.ok(pointers.includes('/result/artifacts/0/metadata/adcp_task_id'));
    assert.ok(pointers.includes('/result/artifacts/0/parts/0/data/adcp_task_id'));
    assert.match(result.error, /A2A wire-shape invariants failed/);
  });

  it('fails when JSON-RPC envelope carried an error instead of result', () => {
    const env = {
      result: null,
      envelope: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/error');
    assert.match(result.error, /Expected a JSON-RPC success envelope/);
  });

  it('fails when result is not an object (Task expected)', () => {
    const env = {
      result: 'not-a-task',
      envelope: { jsonrpc: '2.0', id: 1, result: 'not-a-task' },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/result');
  });

  it('fails when artifacts array is empty', () => {
    const env = conformantEnvelope();
    env.result.artifacts = [];
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(result.actual.failures.some(f => f.pointer === '/result/artifacts'));
  });

  it('fails when the first part is not a DataPart', () => {
    const env = conformantEnvelope();
    env.result.artifacts[0].parts[0] = { kind: 'text', text: 'whatever' };
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(result.actual.failures.some(f => f.pointer === '/result/artifacts/0/parts/0/kind'));
  });

  it('fails when Task.id is missing (buyers cannot address tasks/get without it)', () => {
    const env = conformantEnvelope();
    delete env.result.id;
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(result.actual.failures.some(f => f.pointer === '/result/id'));
  });

  it('fails when Task.contextId is empty (A2A 0.3.0 requires it for follow-up correlation)', () => {
    const env = conformantEnvelope();
    env.result.contextId = '';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(result.actual.failures.some(f => f.pointer === '/result/contextId'));
  });

  it('fails when artifact.artifactId is missing (chunked-artifact resumption breaks)', () => {
    const env = conformantEnvelope();
    delete env.result.artifacts[0].artifactId;
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(result.actual.failures.some(f => f.pointer === '/result/artifacts/0/artifactId'));
  });

  it('fails when Task.status is a bare string instead of an object (no /result/status/state to read)', () => {
    const env = conformantEnvelope();
    env.result.status = 'completed';
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.actual.failures.some(f => f.pointer === '/result/status/state'),
      'flags a bare-string status as a missing state field'
    );
  });

  it('JSON-RPC error envelope failure carries error_code: a2a_jsonrpc_error_envelope (distinct from shape drift)', () => {
    const env = {
      result: null,
      envelope: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx(env));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.actual.error_code, 'a2a_jsonrpc_error_envelope');
  });
});
