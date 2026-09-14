/**
 * Tests for the account-discovery spec-conformance gate (#1624 / adcp#4302).
 *
 * AdCP 3.0.9 §accounts/overview: every seller agent (any specialism in
 * `sales-*`, `audience-sync`, `governance-*`) MUST advertise at least one
 * of `list_accounts` or `sync_accounts`.
 *
 * The gate emits a synthetic failing StoryboardResult that flows through
 * the existing track-grouping / failure-extraction / summary pipeline.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkAccountDiscoveryGate,
  ACCOUNT_DISCOVERY_GATE_STORYBOARD_ID,
} = require('../../dist/lib/testing/compliance/spec-conformance.js');

function profile(overrides = {}) {
  return {
    name: 'Test Agent',
    tools: [],
    specialisms: [],
    ...overrides,
  };
}

describe('checkAccountDiscoveryGate (#1624)', () => {
  test('seller missing both account-discovery tools → hard fail', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['sales-guaranteed'],
        tools: ['get_adcp_capabilities', 'get_products', 'create_media_buy'],
      }),
      'https://agent.example/mcp'
    );
    assert.ok(result, 'gate should fire');
    assert.equal(result.overall_passed, false, 'gate failure must not green-light the run');
    assert.equal(result.failed_count, 1);
    assert.equal(result.skipped_count, 0);
    assert.equal(result.storyboard_id, ACCOUNT_DISCOVERY_GATE_STORYBOARD_ID);

    const step = result.phases[0].steps[0];
    assert.equal(step.passed, false);
    assert.notEqual(step.skipped, true, 'fail, not skip — distinct from missing_tool');
    assert.match(step.error, /list_accounts/);
    assert.match(step.error, /sync_accounts/);
    assert.match(step.error, /sales-guaranteed/, 'error names the triggering specialism');
    assert.match(step.error, /AdCP 3\.0\.9/, 'error cites spec version');
  });

  test('seller with list_accounts only → gate does not fire', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['sales-guaranteed'],
        tools: ['get_adcp_capabilities', 'get_products', 'list_accounts'],
      }),
      'https://agent.example/mcp'
    );
    assert.equal(result, null);
  });

  test('seller with sync_accounts only → gate does not fire', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['sales-non-guaranteed'],
        tools: ['get_adcp_capabilities', 'create_media_buy', 'sync_accounts'],
      }),
      'https://agent.example/mcp'
    );
    assert.equal(result, null);
  });

  test('audience-sync specialism without account tools → fail', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['audience-sync'],
        tools: ['get_adcp_capabilities', 'sync_audiences'],
      }),
      'https://agent.example/mcp'
    );
    assert.ok(result);
    assert.match(result.phases[0].steps[0].error, /audience-sync/);
  });

  test('governance specialism without account tools → fail', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['governance-spend-authority'],
        tools: ['get_adcp_capabilities', 'sync_governance'],
      }),
      'https://agent.example/mcp'
    );
    assert.ok(result);
    assert.match(result.phases[0].steps[0].error, /governance-spend-authority/);
  });

  test('signal-only agent (no account-bearing specialism) → gate does not fire', () => {
    // Signal agents don't operate on accounts; the spec rule doesn't apply.
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['signal-marketplace'],
        tools: ['get_adcp_capabilities', 'get_signals', 'activate_signal'],
      }),
      'https://agent.example/mcp'
    );
    assert.equal(result, null);
  });

  test('creative-only agent → gate does not fire', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['creative-template'],
        tools: ['get_adcp_capabilities', 'list_creative_formats', 'build_creative'],
      }),
      'https://agent.example/mcp'
    );
    assert.equal(result, null);
  });

  test('agent without get_adcp_capabilities (specialisms unknown) → gate is no-op', () => {
    // When the agent doesn't expose get_adcp_capabilities, profile.specialisms
    // is undefined. The gate has nothing to check against. Comply already
    // surfaces a separate observation about the missing capability — we don't
    // double-report.
    const result = checkAccountDiscoveryGate(
      profile({ specialisms: undefined, tools: ['get_products'] }),
      'https://agent.example/mcp'
    );
    assert.equal(result, null);
  });

  test('agent declares no specialisms → gate is no-op', () => {
    const result = checkAccountDiscoveryGate(profile({ specialisms: [], tools: [] }), 'https://agent.example/mcp');
    assert.equal(result, null);
  });

  test('multi-specialism seller — all account-bearing specialisms appear in error', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['sales-guaranteed', 'audience-sync', 'governance-aware-seller', 'signal-owned'],
        tools: ['get_adcp_capabilities'],
      }),
      'https://agent.example/mcp'
    );
    assert.ok(result);
    const error = result.phases[0].steps[0].error;
    assert.match(error, /sales-guaranteed/);
    assert.match(error, /audience-sync/);
    assert.match(error, /governance-aware-seller/);
    // signal-owned is NOT account-bearing — should not appear
    assert.doesNotMatch(error, /signal-owned/);
  });

  test('synthetic storyboard ID is stable for dashboard greps', () => {
    assert.equal(ACCOUNT_DISCOVERY_GATE_STORYBOARD_ID, '__spec_conformance__/account_discovery');
  });

  test('creative-generative without account tools → fail (dual-role generative seller)', () => {
    // adcp-client#1624 review (ad-tech-protocol-expert): the
    // creative-generative specialism is dual-role per CLAUDE.md skill index
    // — an adopter selling inventory AND generating creatives may claim
    // creative-generative without a sales-* specialism. The upstream
    // storyboard exercises sync_accounts directly. Treating
    // creative-generative as account-bearing closes that gap.
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['creative-generative'],
        tools: ['get_adcp_capabilities', 'build_creative'],
      }),
      'https://agent.example/mcp'
    );
    assert.ok(result);
    assert.match(result.phases[0].steps[0].error, /creative-generative/);
  });

  test('creative-template (stand-alone creative) → gate does not fire', () => {
    // Other creative specialisms are stand-alone, no account discovery needed.
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['creative-template'],
        tools: ['get_adcp_capabilities', 'list_creative_formats', 'build_creative'],
      }),
      'https://agent.example/mcp'
    );
    assert.equal(result, null);
  });
});

describe('account-discovery gate routes synthetic result to core track (#1624 review fix)', () => {
  // Code-reviewer flagged: groupByTrack drops storyboards whose IDs aren't in
  // applicableStoryboards. Without the routing fix, the gate would push a
  // failure into result.failures[] but tracks_failed would never increment,
  // computeOverallStatus would return 'passing', and the run would exit 0 —
  // exactly the silent-conformance bug the gate is supposed to close.
  // This test pins the wiring fix.

  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

  test('synthetic result routed to core via groupByTrack flips track to fail', () => {
    // We simulate the groupByTrack output by treating a one-result core group
    // as the input to mapStoryboardResultsToTrackResult — exactly what
    // comply.ts does for any track with results. The track must end up with
    // status 'fail' so computeOverallStatus sees tracks_failed > 0.
    const failure = checkAccountDiscoveryGate(
      profile({ specialisms: ['sales-guaranteed'], tools: ['get_adcp_capabilities'] }),
      'https://agent.example/mcp'
    );
    assert.ok(failure, 'gate must fire for this fixture');

    const trackResult = mapStoryboardResultsToTrackResult('core', [failure], profile());
    assert.equal(trackResult.track, 'core');
    assert.equal(
      trackResult.status,
      'fail',
      `synthetic gate result must produce a failing core track (got '${trackResult.status}')`
    );
    // Sanity: the underlying scenarios array carries the failure so downstream
    // observation collectors / failure summaries see it.
    const failedSteps = trackResult.scenarios.flatMap(s => s.steps.filter(st => !st.passed));
    assert.equal(failedSteps.length, 1, 'one failed step from the synthetic gate');
  });
});

describe('checkAccountDiscoveryGate — account-id namespaces (#1647 / adcp#5062)', () => {
  const accountIdNamespaceProfile = (tools, extra = {}) =>
    profile({
      specialisms: ['sales-guaranteed'],
      tools: ['get_adcp_capabilities', ...tools],
      raw_capabilities: { account: { require_operator_auth: true } },
      ...extra,
    });

  test('sync_accounts alone still passes for an account-id namespace (deliberate: the spec MUST is conditional)', () => {
    // adcp#5062 makes list_accounts a MUST only when a credential can reach
    // more than one account, and a SHOULD with an out-of-band escape for
    // credential-bound singletons. Neither condition is observable from a
    // static capability read, and require_operator_auth: true also covers
    // seller-defined namespaces that hand out ids out-of-band — so this gate
    // must not fail them. The stricter rule is enforced where it is knowable:
    // createAdcpServerFromPlatform requires accounts.list for a declared
    // resolution: 'derived'.
    assert.equal(
      checkAccountDiscoveryGate(accountIdNamespaceProfile(['sync_accounts']), 'https://agent.example/mcp'),
      null
    );
  });

  test('list_accounts satisfies discovery for an account-id namespace', () => {
    assert.equal(
      checkAccountDiscoveryGate(accountIdNamespaceProfile(['list_accounts']), 'https://agent.example/mcp'),
      null
    );
  });

  test('an account-id namespace advertising neither tool gets list_accounts-specific remediation', () => {
    const result = checkAccountDiscoveryGate(accountIdNamespaceProfile([]), 'https://agent.example/mcp');
    assert.ok(result, 'gate should fire — neither discovery tool is advertised');
    const step = result.phases[0].steps[0];
    assert.match(step.error, /require_operator_auth/);
    assert.match(step.error, /account_id/);
  });

  test('buyer-declared sellers advertising neither tool get the generic message', () => {
    const result = checkAccountDiscoveryGate(
      profile({
        specialisms: ['sales-guaranteed'],
        tools: ['get_adcp_capabilities'],
        raw_capabilities: { account: { require_operator_auth: false } },
      }),
      'https://agent.example/mcp'
    );
    assert.ok(result);
    assert.doesNotMatch(result.phases[0].steps[0].error, /require_operator_auth: true/);
  });

  test('unreadable capabilities never change the verdict', () => {
    for (const raw of [undefined, null, 'nope', {}, { account: null }]) {
      assert.equal(
        checkAccountDiscoveryGate(
          profile({
            specialisms: ['sales-guaranteed'],
            tools: ['get_adcp_capabilities', 'sync_accounts'],
            raw_capabilities: raw,
          }),
          'https://agent.example/mcp'
        ),
        null,
        `raw_capabilities=${JSON.stringify(raw)} must not newly fail the gate`
      );
    }
  });
});
