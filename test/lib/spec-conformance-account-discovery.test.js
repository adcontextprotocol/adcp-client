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
});
