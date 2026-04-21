// A2A context/task id retention across multi-turn calls.
//
// Covers the same surface area as adcp-client-python PR #251:
//  - Wire format: contextId / taskId land on the A2A Message envelope.
//  - AgentClient auto-retention: server-returned contextId survives across
//    sends; pendingTaskId survives non-terminal responses and clears on
//    terminal ones.
//  - Reset + rehydrate: resetContext() wipes state; resetContext(seed) seeds
//    contextId for resume-across-process-restart flows.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { callA2ATool, closeA2AConnections } = require('../../dist/lib/protocols/a2a.js');
const { AgentClient } = require('../../dist/lib/index.js');

/**
 * Install a stub A2AClient so every send goes through our queue of fake
 * responses. Returns a capture array + a helper to queue responses.
 */
function installA2AStub() {
  closeA2AConnections();

  const captured = [];
  const queue = [];

  const stubClient = {
    sendMessage: async payload => {
      captured.push(payload);
      const next =
        queue.shift() ??
        {
          jsonrpc: '2.0',
          id: 'test-id',
          result: {
            kind: 'task',
            id: 'task-default',
            contextId: 'ctx-default',
            status: { state: 'completed', timestamp: new Date().toISOString() },
          },
        };
      return next;
    },
  };

  const { A2AClient } = require('@a2a-js/sdk/client');
  const originalFromCardUrl = A2AClient.fromCardUrl;
  A2AClient.fromCardUrl = async () => stubClient;

  return {
    captured,
    enqueue(response) {
      queue.push(response);
    },
    restore() {
      A2AClient.fromCardUrl = originalFromCardUrl;
      closeA2AConnections();
    },
  };
}

/** Build an A2A Task-shaped response with a given status + ids. */
function taskResponse({ status, taskId = 'task-xyz', contextId = 'ctx-xyz', data = {} }) {
  return {
    jsonrpc: '2.0',
    id: 'rpc-id',
    result: {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: status,
        timestamp: new Date().toISOString(),
        message:
          status === 'input-required'
            ? {
                kind: 'message',
                role: 'agent',
                messageId: 'm1',
                parts: [{ kind: 'text', text: 'need more info' }],
              }
            : undefined,
      },
      artifacts: [
        {
          artifactId: 'a1',
          parts: [{ kind: 'data', data }],
        },
      ],
    },
  };
}

describe('A2A wire envelope carries contextId/taskId when a session is supplied', () => {
  test('omits contextId/taskId on the initial send', async () => {
    const stub = installA2AStub();
    try {
      await callA2ATool('https://agent.test', 'get_products', { brief: 'x' });

      assert.strictEqual(stub.captured.length, 1);
      const msg = stub.captured[0].message;
      assert.strictEqual(msg.contextId, undefined, 'no contextId on first send');
      assert.strictEqual(msg.taskId, undefined, 'no taskId on first send');
    } finally {
      stub.restore();
    }
  });

  test('injects contextId onto the Message when provided', async () => {
    const stub = installA2AStub();
    try {
      await callA2ATool(
        'https://agent.test',
        'get_products',
        { brief: 'x' },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { contextId: 'ctx-resume-42' }
      );

      assert.strictEqual(stub.captured.length, 1);
      assert.strictEqual(stub.captured[0].message.contextId, 'ctx-resume-42');
      assert.strictEqual(stub.captured[0].message.taskId, undefined);
    } finally {
      stub.restore();
    }
  });

  test('injects both contextId and taskId for HITL resume', async () => {
    const stub = installA2AStub();
    try {
      await callA2ATool(
        'https://agent.test',
        'create_media_buy',
        { idempotency_key: 'k1' },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { contextId: 'ctx-7', taskId: 'task-7' }
      );

      const msg = stub.captured[0].message;
      assert.strictEqual(msg.contextId, 'ctx-7');
      assert.strictEqual(msg.taskId, 'task-7');
    } finally {
      stub.restore();
    }
  });
});

describe('AgentClient auto-retains contextId/taskId across sends', () => {
  const agentConfig = {
    id: 'test-a2a',
    name: 'Test A2A',
    agent_uri: 'https://agent.test',
    protocol: 'a2a',
    auth_token_env: 'UNSET_TOKEN',
  };

  /**
   * Builds an AgentClient with feature validation turned off (so the test
   * isn't coupled to the declared `adcp_capabilities` of a real seller) and
   * uses `executeTask` with a free-form task name to bypass per-tool Zod
   * request schemas — the contract under test is the session-id retention,
   * not request-shape validation.
   */
  function newClient() {
    return new AgentClient(agentConfig, { validateFeatures: false });
  }

  test('adopts server contextId on the first completed response, sends it on the next call', async () => {
    const stub = installA2AStub();
    try {
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-server-1', taskId: 't1' }));
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-server-1', taskId: 't2' }));

      const client = newClient();
      assert.strictEqual(client.getContextId(), undefined);

      const first = await client.executeTask('probe', {});
      assert.strictEqual(first.success, true);
      assert.strictEqual(client.getContextId(), 'ctx-server-1', 'server contextId adopted');
      assert.strictEqual(client.getPendingTaskId(), undefined, 'completed is terminal — no pending task');

      await client.executeTask('probe', {});

      assert.strictEqual(stub.captured.length, 2);
      assert.strictEqual(stub.captured[0].message.contextId, undefined, 'first send has no session');
      assert.strictEqual(stub.captured[1].message.contextId, 'ctx-server-1', 'second send uses server contextId');
    } finally {
      stub.restore();
    }
  });

  test('retains pendingTaskId on input-required, sends it on resume', async () => {
    const stub = installA2AStub();
    try {
      stub.enqueue(taskResponse({ status: 'input-required', contextId: 'ctx-hitl', taskId: 'task-hitl' }));
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-hitl', taskId: 'task-hitl' }));

      const client = newClient();
      const r1 = await client.executeTask('probe', {});

      assert.strictEqual(r1.status, 'input-required');
      assert.strictEqual(client.getContextId(), 'ctx-hitl');
      assert.strictEqual(client.getPendingTaskId(), 'task-hitl', 'non-terminal retains taskId');

      await client.executeTask('probe', {});

      assert.strictEqual(stub.captured[1].message.contextId, 'ctx-hitl');
      assert.strictEqual(stub.captured[1].message.taskId, 'task-hitl', 'resume sends server taskId');
      assert.strictEqual(client.getPendingTaskId(), undefined, 'terminal response clears pending task');
    } finally {
      stub.restore();
    }
  });

  test('resetContext() clears contextId and pendingTaskId', async () => {
    const stub = installA2AStub();
    try {
      stub.enqueue(taskResponse({ status: 'input-required', contextId: 'ctx-1', taskId: 't-1' }));
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-2', taskId: 't-2' }));

      const client = newClient();
      await client.executeTask('probe', {});
      assert.strictEqual(client.getContextId(), 'ctx-1');
      assert.strictEqual(client.getPendingTaskId(), 't-1');

      client.resetContext();
      assert.strictEqual(client.getContextId(), undefined);
      assert.strictEqual(client.getPendingTaskId(), undefined);

      await client.executeTask('probe', {});
      assert.strictEqual(stub.captured[1].message.contextId, undefined, 'post-reset send opens fresh session');
      assert.strictEqual(stub.captured[1].message.taskId, undefined);
    } finally {
      stub.restore();
    }
  });

  test('resetContext(seed) rehydrates a persisted contextId for resume-across-restart', async () => {
    const stub = installA2AStub();
    try {
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-rehydrated', taskId: 'new' }));

      const client = newClient();
      client.resetContext('ctx-rehydrated');
      assert.strictEqual(client.getContextId(), 'ctx-rehydrated');
      assert.strictEqual(client.getPendingTaskId(), undefined, 'seeding never carries a stale taskId');

      await client.executeTask('probe', {});
      assert.strictEqual(stub.captured[0].message.contextId, 'ctx-rehydrated', 'seeded contextId rides the next send');
    } finally {
      stub.restore();
    }
  });

  test('caller-supplied options.contextId wins over retained state', async () => {
    const stub = installA2AStub();
    try {
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-retained', taskId: 't1' }));
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-retained', taskId: 't2' }));

      const client = newClient();
      await client.executeTask('probe', {});
      assert.strictEqual(client.getContextId(), 'ctx-retained');

      await client.executeTask('probe', {}, undefined, { contextId: 'ctx-override' });
      assert.strictEqual(stub.captured[1].message.contextId, 'ctx-override', 'explicit override wins');
    } finally {
      stub.restore();
    }
  });

  test('rejects malformed server-issued session ids (overlong / control chars)', async () => {
    // A hostile or buggy seller returns a 10KB contextId or one containing
    // CRLF / ANSI control bytes. The parser drops them and retention falls
    // back to whatever the client retained before (or undefined if this is
    // the first call).
    const stub = installA2AStub();
    try {
      const hugeId = 'x'.repeat(10_000);
      const ctrlId = 'ctx-with-\r\n-injected-newline';
      stub.enqueue(taskResponse({ status: 'completed', contextId: hugeId, taskId: ctrlId }));

      const client = newClient();
      await client.executeTask('probe', {});

      assert.strictEqual(client.getContextId(), undefined, 'overlong contextId rejected');
      assert.strictEqual(client.getPendingTaskId(), undefined, 'control-char taskId rejected (and terminal anyway)');
    } finally {
      stub.restore();
    }
  });

  test('switching contextId drops the stale pendingTaskId', async () => {
    // HITL on conversation A leaves pendingTaskId set. A later call against
    // a different conversation (explicit options.contextId override) must
    // NOT inherit that taskId — it belongs to the abandoned conversation
    // and would either resume the wrong task or confuse the server.
    const stub = installA2AStub();
    try {
      stub.enqueue(taskResponse({ status: 'input-required', contextId: 'ctx-A', taskId: 'task-A' }));
      stub.enqueue(taskResponse({ status: 'completed', contextId: 'ctx-B', taskId: 'task-B' }));

      const client = newClient();
      await client.executeTask('probe', {});
      assert.strictEqual(client.getPendingTaskId(), 'task-A');

      await client.executeTask('probe', {}, undefined, { contextId: 'ctx-B' });

      assert.strictEqual(stub.captured[1].message.contextId, 'ctx-B');
      assert.strictEqual(
        stub.captured[1].message.taskId,
        undefined,
        'stale pendingTaskId from conversation A must not leak into conversation B'
      );
    } finally {
      stub.restore();
    }
  });
});
