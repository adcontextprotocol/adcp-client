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
      calls.push(Date.now());
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
});
