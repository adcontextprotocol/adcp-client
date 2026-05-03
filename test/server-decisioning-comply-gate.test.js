// Framework-side sandbox-authority gate for `comply_test_controller`.
// Phase 2 of #1435 — auto-wires the gate inside `createAdcpServerFromPlatform`
// so the controller refuses live-mode accounts regardless of what the caller
// claims on the wire. See docs/proposals/lifecycle-state-and-sandbox-authority.md.
//
// 5 admit/deny combinations × 3 modes = 15 assertions covering:
//   - resolver returns mode 'live' / 'sandbox' / 'mock'
//   - context.sandbox === true when no account resolves
//   - process.env.ADCP_SANDBOX === '1' fallback (and its fail-closed guard)

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { __resetObservedAccountModes } = require('../dist/lib/server/decisioning/runtime/observed-modes');

function makePlatform(resolveAccount) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
      compliance_testing: {},
    },
    statusMappers: {},
    accounts: {
      resolve: resolveAccount,
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

function buildServer(resolveAccount) {
  return createAdcpServerFromPlatform(makePlatform(resolveAccount), {
    name: 'gate-host',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    complyTest: {
      force: {
        creative_status: async params => ({
          success: true,
          transition: 'forced',
          resource_type: 'creative',
          resource_id: params.creative_id,
          previous_state: 'pending_review',
          current_state: params.status,
        }),
      },
    },
  });
}

async function callForceCreative(server, args = {}) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'comply_test_controller',
      arguments: {
        scenario: 'force_creative_status',
        params: { creative_id: 'cr_1', status: 'approved' },
        ...args,
      },
    },
  });
}

async function callListScenarios(server) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'comply_test_controller',
      arguments: { scenario: 'list_scenarios' },
    },
  });
}

describe('createAdcpServerFromPlatform — sandbox-authority gate (resolver path)', () => {
  beforeEach(() => {
    delete process.env.ADCP_SANDBOX;
    __resetObservedAccountModes();
  });

  it("denies when resolver returns mode: 'live'", async () => {
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'live_acc',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, { account: { account_id: 'live_acc' } });

    assert.strictEqual(result.isError, true, 'live-mode account must be denied');
    assert.strictEqual(result.structuredContent.error, 'FORBIDDEN');
  });

  it("admits when resolver returns mode: 'sandbox'", async () => {
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'sb_acc',
      mode: 'sandbox',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, { account: { account_id: 'sb_acc' } });

    assert.notStrictEqual(result.isError, true, 'sandbox-mode account must be admitted');
    assert.strictEqual(result.structuredContent.success, true);
  });

  it("admits when resolver returns mode: 'mock'", async () => {
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'mock_acc',
      mode: 'mock',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, { account: { account_id: 'mock_acc' } });

    assert.notStrictEqual(result.isError, true, 'mock-mode account must be admitted');
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('admits via legacy sandbox: true back-compat shape', async () => {
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'legacy_sb',
      sandbox: true,
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, { account: { account_id: 'legacy_sb' } });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('ignores caller-supplied account.sandbox claim when resolver says live', async () => {
    // Trust boundary: resolver is authoritative, NOT the wire. Buyer cannot
    // self-promote by stuffing sandbox: true into the account ref.
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'spoof',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, {
      account: { account_id: 'spoof', sandbox: true },
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.error, 'FORBIDDEN');
  });
});

describe('createAdcpServerFromPlatform — sandbox-authority gate (accountRef.sandbox path)', () => {
  // Spec-defined fallback at the AdCP wire layer: AccountReference.sandbox
  // (per schemas/cache/3.0.5/core/account-ref.json). Only honored when the
  // resolver returns `null` — never overrides a resolved live account.
  beforeEach(() => {
    delete process.env.ADCP_SANDBOX;
    __resetObservedAccountModes();
  });

  it('admits when no account resolves and accountRef.sandbox === true', async () => {
    const server = buildServer(async () => null);

    const result = await callForceCreative(server, { account: { sandbox: true } });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('denies when no account resolves and accountRef.sandbox is absent', async () => {
    const server = buildServer(async () => null);

    const result = await callForceCreative(server);

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.error, 'FORBIDDEN');
  });

  it('does NOT admit on accountRef.sandbox when the resolver names a live account', async () => {
    // The wire flag is a fallback for the *unresolved* path. Once the
    // resolver names the account, the resolver wins and the buyer's wire
    // claim is ignored.
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'live_acc',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, {
      account: { account_id: 'live_acc', sandbox: true },
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.error, 'FORBIDDEN');
  });
});

describe('createAdcpServerFromPlatform — sandbox-authority gate (env fallback)', () => {
  beforeEach(() => {
    delete process.env.ADCP_SANDBOX;
    __resetObservedAccountModes();
  });

  after(() => {
    delete process.env.ADCP_SANDBOX;
    __resetObservedAccountModes();
  });

  it('admits via ADCP_SANDBOX=1 when resolver returns no mode-bearing account (legacy)', async () => {
    process.env.ADCP_SANDBOX = '1';
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'legacy_acc',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const result = await callForceCreative(server, { account: { account_id: 'legacy_acc' } });

    assert.notStrictEqual(result.isError, true, 'legacy env-fallback path must continue to admit');
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('FAILS CLOSED on a live-mode resolve when ADCP_SANDBOX=1 (catches the misconfig immediately)', async () => {
    // The env-fallback was never meant to coexist with a resolver that names
    // live accounts. As soon as such a pairing is observed, the gate throws
    // loudly so operators notice in their logs — a FORBIDDEN response would
    // be too quiet for what is fundamentally a deployment-level misconfig.
    process.env.ADCP_SANDBOX = '1';
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'live_1',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    await assert.rejects(
      () => callForceCreative(server, { account: { account_id: 'live_1' } }),
      err => /ADCP_SANDBOX=1 is set but this process has resolved at least one live-mode account/.test(err.message)
    );
  });

  it('FAILS CLOSED even when the buyer also sets accountRef.sandbox=true alongside ADCP_SANDBOX=1 (no bypass)', async () => {
    // Regression for the code-reviewer-flagged bypass: with env=1, resolver
    // returning mode='live', and the buyer adding `account.sandbox: true` on
    // the wire, an earlier guard predicate that checked `!contextSandbox` (or
    // any wire-claim suppression) would have admitted the live account via
    // the env-only signal. The fixed predicate (`wouldAdmitOnlyViaEnv`)
    // ignores the wire claim because the resolver's live answer pins
    // `resolvedAccount != null`, so the unresolved-path admit is impossible.
    process.env.ADCP_SANDBOX = '1';
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'live_1',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    await assert.rejects(
      () => callForceCreative(server, { account: { account_id: 'live_1', sandbox: true } }),
      err => /ADCP_SANDBOX=1 is set but this process has resolved at least one live-mode account/.test(err.message)
    );
  });

  it('FAILS CLOSED on subsequent env-fallback calls once any live-mode account has been observed', async () => {
    // Even if a later call's resolver omits the mode field (legacy adopter
    // shape), the previously-observed live account locks the env fallback.
    process.env.ADCP_SANDBOX = '1';

    // Step 1: observe a live account via a separate server. The guard fires
    // on this call too — we drain it (assert.rejects) so the observation
    // sticks for step 2.
    const liveServer = buildServer(async ref => ({
      id: ref?.account_id ?? 'live_1',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));
    await assert.rejects(() => callForceCreative(liveServer, { account: { account_id: 'live_1' } }));

    // Step 2: a server with a legacy resolver (no mode) — would normally hit
    // env fallback. Guard refuses because the process has observed live.
    const envServer = buildServer(async ref => ({
      id: ref?.account_id ?? 'legacy_acc',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    await assert.rejects(
      () => callForceCreative(envServer, { account: { account_id: 'legacy_acc' } }),
      err => /ADCP_SANDBOX=1 is set but this process has resolved at least one live-mode account/.test(err.message)
    );
  });

  it('list_scenarios is exempt from the gate (probe always answers)', async () => {
    // No env, no context.sandbox, resolver returns null. force_creative_status
    // would deny — list_scenarios admits as a discovery probe.
    const server = buildServer(async () => null);

    const probe = await callListScenarios(server);

    assert.notStrictEqual(probe.isError, true);
    assert.ok(Array.isArray(probe.structuredContent.scenarios));
    assert.ok(probe.structuredContent.scenarios.includes('force_creative_status'));
  });
});
