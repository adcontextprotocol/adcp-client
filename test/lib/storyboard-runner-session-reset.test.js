/**
 * Regression test for adcp-client#1585.
 *
 * `comply()` shares a single `AgentClient` across every storyboard for
 * transport reuse. The client retains `pendingTaskId` (and `contextId`) from
 * non-terminal responses (`submitted`/`working`/`input-required`) and
 * auto-threads them into every subsequent A2A `message/send`. Without a
 * per-storyboard reset, a stale `task_id` from a prior storyboard's HITL or
 * working step rides into the next storyboard's first call (typically
 * `get_products`); A2A sellers then correctly return "Task <uuid> not found"
 * because the buyer is referencing a task it never opened against this seller.
 *
 * The runner now calls `client.resetContext()` on every shared client at the
 * start of `executeStoryboardPass`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const FAKE_AGENT_URL = 'http://127.0.0.1:1/mcp'; // never reached — empty phases
const FAKE_PROFILE = { name: 'Test', tools: [] };

function emptyStoryboard() {
  return {
    id: 'session_reset_sb',
    version: '1.0.0',
    title: 'Session reset',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [],
  };
}

function spyClient() {
  const calls = [];
  return {
    calls,
    getAgentInfo: async () => ({ name: 'Test', tools: [] }),
    resetContext: function () {
      calls.push(true);
    },
  };
}

function controllerClient(response = { success: true }) {
  const calls = [];
  return {
    calls,
    getAgentInfo: async () => ({ name: 'Test', tools: ['comply_test_controller'] }),
    resetContext() {},
    async executeTask(name, params) {
      calls.push({ name, params });
      return {
        success: true,
        data: { content: [{ type: 'text', text: JSON.stringify(response) }] },
      };
    },
  };
}

describe('runStoryboard: per-storyboard session reset (regression for #1585)', () => {
  it('clears retained A2A session state on the shared `_client` before any step runs', async () => {
    const client = spyClient();

    await runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: client,
      _profile: FAKE_PROFILE,
    });

    assert.strictEqual(
      client.calls.length,
      1,
      'shared `_client` must have its session reset exactly once per storyboard run'
    );
  });

  it('tolerates a client that does not expose `resetContext()` (duck-typed accessor)', async () => {
    // Adapter-built clients in older tests/integration paths may not subclass
    // AgentClient. The reset helper must not throw on those.
    const clientNoReset = {
      getAgentInfo: async () => ({ name: 'Test', tools: [] }),
    };
    await assert.doesNotReject(() =>
      runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
        protocol: 'mcp',
        allow_http: true,
        _client: clientNoReset,
        _profile: FAKE_PROFILE,
      })
    );
  });

  it('requests seller-side state reset before a storyboard when the controller is advertised', async () => {
    const client = controllerClient();

    await runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: client,
      _profile: { name: 'Test', tools: ['comply_test_controller'] },
      agentTools: ['comply_test_controller'],
      _controllerCapabilities: { detected: true, scenarios: ['reset_state'] },
    });

    assert.deepStrictEqual(client.calls, [
      {
        name: 'comply_test_controller',
        params: {
          account: {
            brand: { domain: 'test.example' },
            operator: 'test.example',
            sandbox: true,
          },
          scenario: 'reset_state',
          context: { correlation_id: 'session_reset_sb--__reset_state__' },
        },
      },
    ]);
  });

  it('keeps older controllers compatible when reset_state is unknown', async () => {
    const client = controllerClient({ success: false, error: 'UNKNOWN_SCENARIO' });
    const result = await runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: client,
      _profile: { name: 'Test', tools: ['comply_test_controller'] },
      agentTools: ['comply_test_controller'],
      _controllerCapabilities: { detected: true, scenarios: ['reset_state'] },
    });

    assert.strictEqual(result.overall_passed, true);
  });

  it('does not call reset_state when an older controller does not advertise it', async () => {
    const client = controllerClient();
    const result = await runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: client,
      _profile: { name: 'Test', tools: ['comply_test_controller'] },
      agentTools: ['comply_test_controller'],
      _controllerCapabilities: { detected: true, scenarios: ['seed_product'] },
    });

    assert.strictEqual(result.overall_passed, true);
    assert.deepStrictEqual(client.calls, []);
  });

  it('fails the storyboard when seller-side state cannot be reset', async () => {
    const client = controllerClient({
      success: false,
      error: 'RESET_FAILED',
      error_detail: 'fixture store unavailable',
    });
    const result = await runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: client,
      _profile: { name: 'Test', tools: ['comply_test_controller'] },
      agentTools: ['comply_test_controller'],
      _controllerCapabilities: { detected: true, scenarios: ['reset_state'] },
    });

    assert.strictEqual(result.overall_passed, false);
    assert.strictEqual(result.phases[0].phase_id, 'discovery_failed');
    assert.match(result.phases[0].steps[0].error, /fixture store unavailable/);
  });
});
