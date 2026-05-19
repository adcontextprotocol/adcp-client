// Resilient discovery for multi-agent routing (#1367). When a tenant's
// `get_adcp_capabilities` probe fails, the default contract is hard-failure
// — correct for production multi-tenant flows. Hello-cluster CI and
// exploratory runs opt in via `discovery_resilient: true`, which:
//   - excludes failed agents from the protocol-claim index
//   - records failures on `routingContext.discoveryFailures`
//   - lets unrelated storyboards complete normally
//   - surfaces `discovery_failures[]` on `StoryboardResult`
// This test exercises the routing seam directly. End-to-end coverage of
// the runner result surface lives alongside the existing multi-agent
// runner tests once hello-cluster gains a CI flake injection point.

process.env.NODE_ENV = 'test';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const {
  buildRoutingContext,
  resolveAgentForStep,
  RoutingError,
  DiscoveryFailure,
} = require('../../dist/lib/testing/storyboard/agent-routing.js');
const { closeConnections } = require('../../dist/lib/protocols/index.js');

// Pre-existing tests in agent-routing.test.js use `buildRoutingContextFromProfiles`
// for unit-level seams that don't need live discovery. The resilient-mode
// path runs the discovery side of `buildRoutingContext`, so this test
// drives that function directly with stub agent URLs that fail discovery.

// Stub URLs: nothing is listening on this loopback port pair, so the
// agent client's discovery probe rejects fast. Each URL is unique so the
// per-agent failure-collection path can be observed.
const STUB_FAILING_URL_1 = 'http://127.0.0.1:1/mcp';
const STUB_FAILING_URL_2 = 'http://127.0.0.1:2/mcp';

function makeStoryboard(steps) {
  return {
    id: 'test_storyboard',
    title: 'Test',
    phases: [{ id: 'p1', title: 'Phase 1', steps }],
  };
}

describe('agent-routing: discovery_resilient (#1367)', () => {
  // Discovery instantiates MCP clients via `getOrCreateClient` which keep
  // transport references alive past the test body. Without an explicit
  // teardown the suite hangs until `--test-force-exit` triggers in CI.
  after(async () => {
    // MCP is the only transport this file uses today; A2A is closed too
    // for forward-compat in case a future test adds an A2A stub agent.
    await closeConnections('mcp');
    await closeConnections('a2a');
  });

  test('default mode (discovery_resilient unset): any agent failing discovery throws DiscoveryFailure', async () => {
    const storyboard = makeStoryboard([{ id: 's1', title: 'probe', task: 'get_signals' }]);
    const options = {
      agents: {
        signals: { url: STUB_FAILING_URL_1, auth_token: 't1' },
      },
      // discovery_resilient omitted (=== undefined). Hard-failure preserved.
    };

    await assert.rejects(
      () => buildRoutingContext(storyboard, options),
      err => err instanceof DiscoveryFailure
    );
  });

  test('discovery_resilient: true — failed agents excluded from protocolIndex but the context is returned', async () => {
    const storyboard = makeStoryboard([{ id: 's1', title: 'probe', task: 'get_signals' }]);
    const options = {
      agents: {
        broken_a: { url: STUB_FAILING_URL_1, auth_token: 't1' },
        broken_b: { url: STUB_FAILING_URL_2, auth_token: 't2' },
      },
      discovery_resilient: true,
    };

    const ctx = await buildRoutingContext(storyboard, options);
    // Both agents failed → none in profiles.
    assert.strictEqual(ctx.profiles.size, 0);
    // Both surface on discoveryFailures with stable agent keys.
    assert.strictEqual(ctx.discoveryFailures.length, 2);
    const keys = ctx.discoveryFailures.map(f => f.agentKey).sort();
    assert.deepStrictEqual(keys, ['broken_a', 'broken_b']);
    assert.ok(ctx.discoveryFailures.every(f => f instanceof DiscoveryFailure));
    // Each failure echoes the original URL so operators can match against
    // their topology config without correlating logs.
    const urlsByKey = Object.fromEntries(ctx.discoveryFailures.map(f => [f.agentKey, f.url]));
    assert.strictEqual(urlsByKey.broken_a, STUB_FAILING_URL_1);
    assert.strictEqual(urlsByKey.broken_b, STUB_FAILING_URL_2);
    // agentMap remains complete — failures don't remove the agent from the
    // declared topology, only from the protocol-claim index.
    assert.deepStrictEqual(Object.keys(ctx.agentMap).sort(), ['broken_a', 'broken_b']);
  });

  test('resilient mode + a step needing the failed protocol: RoutingError mentions which agent broke discovery', async () => {
    const storyboard = makeStoryboard([{ id: 's1', title: 'probe', task: 'get_signals' }]);
    const options = {
      agents: {
        signals: { url: STUB_FAILING_URL_1, auth_token: 't1' },
      },
      discovery_resilient: true,
    };

    const ctx = await buildRoutingContext(storyboard, options);
    // Routing for a step requiring `signals` protocol now fails per-step
    // (not at context-build time) — that's the whole point of the resilient
    // mode. The error must mention the failed agent so the operator sees
    // the connection without correlating logs.
    assert.throws(
      () => resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx),
      err => err instanceof RoutingError && err.message.includes('signals') && err.message.includes(STUB_FAILING_URL_1)
    );
  });

  test('resilient mode + step.agent override targeting a failed-discovery agent: RoutingError surfaces the override mistake', async () => {
    // Without this guard, the override would return verbatim and the
    // dispatcher would hand back a transport client to a broken tenant,
    // failing at the wire layer with a misleading transport error. The
    // override-time check makes the failure attributable to topology.
    const storyboard = makeStoryboard([{ id: 's1', title: 'probe', task: 'get_signals', agent: 'broken' }]);
    const options = {
      agents: {
        broken: { url: STUB_FAILING_URL_1, auth_token: 't1' },
        healthy: { url: STUB_FAILING_URL_2, auth_token: 't2' },
      },
      discovery_resilient: true,
    };

    const ctx = await buildRoutingContext(storyboard, options);
    // Both stubs fail in this test, but the assertion is about the
    // override-targeted agent specifically — even if `healthy` succeeded,
    // the failure here belongs to `broken`.
    assert.strictEqual(ctx.discoveryFailures.length, 2);
    assert.throws(
      () => resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx),
      err =>
        err instanceof RoutingError &&
        err.message.includes('step.agent') &&
        err.message.includes('broken') &&
        err.message.includes('failed')
    );
  });

  test('resilient mode + default_agent set: unrouted protocol falls back through default_agent path', async () => {
    // Sanity: resilient mode doesn't interfere with the existing
    // default_agent fallback. A step whose protocol is unclaimed (because
    // discovery failed) but has a default_agent still routes there. The
    // default_agent itself may or may not exist on profiles; routing
    // returns the key regardless and per-step dispatch surfaces the
    // problem if the agent isn't reachable.
    const storyboard = makeStoryboard([{ id: 's1', title: 'probe', task: 'get_signals' }]);
    const options = {
      agents: {
        broken: { url: STUB_FAILING_URL_1, auth_token: 't1' },
      },
      default_agent: 'broken',
      discovery_resilient: true,
    };

    const ctx = await buildRoutingContext(storyboard, options);
    assert.strictEqual(ctx.discoveryFailures.length, 1);
    // No protocols are claimed (every agent failed), so the step falls
    // through to default_agent rather than failing at routing time.
    assert.strictEqual(resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx), 'broken');
  });
});
