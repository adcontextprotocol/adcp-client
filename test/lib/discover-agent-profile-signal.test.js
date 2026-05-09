/**
 * Regression test for adcp-client#1612 (third-bug fix).
 *
 * Before this fix, `discoverAgentProfile` had no AbortSignal awareness, so
 * an unhealthy agent's `getAgentInfo()` could spin past comply()'s timeout
 * (we observed 425s of MCP retries against a non-MCP root). The fix wraps
 * the underlying calls with an internal `raceWithSignal` so the comply
 * pipeline's combined timeout/external signal bounds discovery latency.
 * The orphaned in-flight transport call still resolves in the background;
 * the fix is about unblocking the caller, not cancelling the transport.
 *
 * `discoverAgentProfile` runs the call through `runStep`, which catches
 * the AbortError and returns `{ step: { passed: false, error } }` rather
 * than re-throwing — so the assertions check that shape.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { discoverAgentProfile } = require('../../dist/lib/testing/client.js');

function slowClient(delayMs) {
  let calls = 0;
  let pendingTimers = [];
  return {
    callCount: () => calls,
    cleanup: () => {
      pendingTimers.forEach(t => clearTimeout(t));
      pendingTimers = [];
    },
    getAgentInfo: () => {
      calls += 1;
      return new Promise(resolve => {
        const t = setTimeout(() => resolve({ name: 'Slow', tools: [] }), delayMs);
        pendingTimers.push(t);
      });
    },
    getAdcpCapabilities: async () => ({ success: true, data: {} }),
  };
}

describe('discoverAgentProfile: AbortSignal honored (#1612)', () => {
  test('reports failure on pre-aborted signal without blocking on slow transport', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    const client = slowClient(60000);

    const t0 = Date.now();
    const { step } = await discoverAgentProfile(client, controller.signal);
    const elapsed = Date.now() - t0;

    client.cleanup();

    assert.strictEqual(step.passed, false, 'step should fail when signal is pre-aborted');
    assert.ok(step.error?.includes('pre-aborted'), `expected pre-aborted in error, got: ${step.error}`);
    assert.ok(elapsed < 100, `should exit fast on pre-aborted signal, took ${elapsed}ms`);
  });

  test('aborts mid-call without waiting for slow getAgentInfo to resolve', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('mid-call')), 30);
    const client = slowClient(5000);

    const t0 = Date.now();
    const { step } = await discoverAgentProfile(client, controller.signal);
    const elapsed = Date.now() - t0;

    client.cleanup();

    assert.strictEqual(step.passed, false, 'step should fail when signal aborts mid-call');
    assert.ok(step.error?.includes('mid-call'), `expected mid-call in error, got: ${step.error}`);
    // Race wrapper resolves on abort. Bound is "well below" the 5s mock delay;
    // loose to avoid CI flakes on slow runners.
    assert.ok(elapsed < 1000, `expected fast abort exit, took ${elapsed}ms`);
  });

  test('runs to completion when signal is never aborted', async () => {
    const client = slowClient(5);
    const { profile, step } = await discoverAgentProfile(client);
    assert.strictEqual(step.passed, true);
    assert.strictEqual(profile.name, 'Slow');
    client.cleanup();
  });

  test('passing no signal is a no-op (backward compat)', async () => {
    const client = slowClient(5);
    const { profile } = await discoverAgentProfile(client);
    assert.strictEqual(profile.name, 'Slow');
    client.cleanup();
  });

  // code-reviewer follow-up on #1612: the wrapper covers the second
  // `getAdcpCapabilities()` call, not just the first `getAgentInfo()`.
  // Cover that path explicitly so a future refactor that bypasses
  // `raceWithSignal` on the second call gets caught.
  test('aborts the getAdcpCapabilities call too, not just getAgentInfo', async () => {
    let capabilitiesCalls = 0;
    let pendingTimers = [];
    const cleanup = () => {
      pendingTimers.forEach(t => clearTimeout(t));
      pendingTimers = [];
    };
    const client = {
      // Fast getAgentInfo so the second call (capabilities) is the one
      // racing the abort.
      getAgentInfo: async () => ({
        name: 'Fast',
        tools: [{ name: 'get_adcp_capabilities' }],
      }),
      getAdcpCapabilities: () => {
        capabilitiesCalls += 1;
        return new Promise(resolve => {
          const t = setTimeout(() => resolve({ success: true, data: {} }), 5000);
          pendingTimers.push(t);
        });
      },
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('mid-capabilities')), 30);

    const t0 = Date.now();
    const { profile } = await discoverAgentProfile(client, controller.signal);
    const elapsed = Date.now() - t0;
    cleanup();

    assert.strictEqual(capabilitiesCalls, 1, 'capabilities should have been invoked once');
    assert.ok(elapsed < 1000, `expected fast abort exit, took ${elapsed}ms`);
    // capabilities never resolved, so capabilities-derived fields stay unset.
    assert.strictEqual(profile.adcp_version, undefined);
    assert.strictEqual(profile.specialisms, undefined);
    // The capabilities_probe_error is set in the catch path — it should
    // mention the abort, not silently succeed.
    assert.ok(
      profile.capabilities_probe_error?.includes('mid-capabilities'),
      `expected capabilities_probe_error to mention abort, got: ${profile.capabilities_probe_error}`
    );
  });
});
