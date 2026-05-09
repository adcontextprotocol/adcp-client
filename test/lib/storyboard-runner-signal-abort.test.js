/**
 * Regression test for adcp-client#1612 (MCP side).
 *
 * Before the fix, `complyImpl`'s `for (const sb of applicableStoryboards)`
 * loop checked `signal.throwIfAborted()` only between storyboards. Inside a
 * single storyboard, `executeStoryboardPass` had no signal awareness, so a
 * single storyboard with many sequential per-step calls would burn the full
 * comply() budget regardless of when the abort fired.
 *
 * The fix threads `signal` through `StoryboardRunOptions` and calls
 * `signal.throwIfAborted()` at the start of every phase iteration AND
 * every step iteration inside `executeStoryboardPass`. These tests verify
 * the runner honors the signal at both boundaries.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const FAKE_AGENT_URL = 'http://127.0.0.1:1/mcp';
const FAKE_PROFILE = { name: 'Test', tools: ['get_products'] };

function multiStepStoryboard() {
  // Two phases, two steps each — exercises both the per-phase and the
  // per-step abort gate. Sample requests are minimal so the runner doesn't
  // need real fixture data.
  return {
    id: 'signal_abort_sb',
    version: '1.0.0',
    title: 'Signal abort',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'phase_one',
        title: 'Phase 1',
        steps: [
          { id: 'p1_s1', title: '', task: 'get_products', sample_request: { brief: '' } },
          { id: 'p1_s2', title: '', task: 'get_products', sample_request: { brief: '' } },
        ],
      },
      {
        id: 'phase_two',
        title: 'Phase 2',
        steps: [
          { id: 'p2_s1', title: '', task: 'get_products', sample_request: { brief: '' } },
          { id: 'p2_s2', title: '', task: 'get_products', sample_request: { brief: '' } },
        ],
      },
    ],
  };
}

function slowClient(delayMs = 50) {
  let calls = 0;
  return {
    callCount: () => calls,
    getAgentInfo: async () => ({ name: 'Test', tools: ['get_products'] }),
    resetContext: () => {},
    getProducts: async () => {
      calls += 1;
      await new Promise(r => setTimeout(r, delayMs));
      return { success: true, data: { products: [] } };
    },
  };
}

describe('runStoryboard: AbortSignal honored at phase/step boundaries (#1612)', () => {
  it('throws AbortError when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before run'));

    await assert.rejects(
      () =>
        runStoryboard(FAKE_AGENT_URL, multiStepStoryboard(), {
          protocol: 'mcp',
          allow_http: true,
          _client: slowClient(),
          _profile: FAKE_PROFILE,
          signal: controller.signal,
        }),
      err => {
        assert.ok(
          err.message?.includes('cancelled before run') || err.name === 'AbortError',
          `Expected AbortError-like, got: ${err.name} - ${err.message}`
        );
        return true;
      }
    );
  });

  it('aborts mid-storyboard, not only between storyboards', async () => {
    const controller = new AbortController();
    const client = slowClient(40);

    // Fire abort after the first step has had time to start but before all
    // four steps complete. With per-step throwIfAborted, the run must stop
    // well before issuing all four calls.
    setTimeout(() => controller.abort(new Error('mid-run')), 30);

    await assert.rejects(
      () =>
        runStoryboard(FAKE_AGENT_URL, multiStepStoryboard(), {
          protocol: 'mcp',
          allow_http: true,
          _client: client,
          _profile: FAKE_PROFILE,
          signal: controller.signal,
        }),
      err => {
        assert.ok(err.message?.includes('mid-run') || err.name === 'AbortError');
        return true;
      }
    );

    // 4 steps × 40ms = 160ms total if no abort. We aborted at 30ms, so we
    // expect 1-2 calls to have been issued, not all 4. Loose bound to avoid
    // CI flakes on slow runners.
    assert.ok(
      client.callCount() < 4,
      `Expected fewer than 4 calls when abort fires mid-run, got ${client.callCount()}`
    );
  });

  it('runs to completion when signal is never aborted', async () => {
    const controller = new AbortController();
    const client = slowClient(5);

    const result = await runStoryboard(FAKE_AGENT_URL, multiStepStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: client,
      _profile: FAKE_PROFILE,
      signal: controller.signal,
    });

    assert.ok(result, 'Should return a result when signal never aborts');
    assert.strictEqual(client.callCount(), 4, 'All four steps should have run');
  });
});
