// Framework-side visibility and sandbox-authority gate for
// `comply_test_controller` in `createAdcpServerFromPlatform`.
// Covers Path B discovery hiding, direct-call method-not-found, target-account
// PERMISSION_DENIED, BuyerAgentRegistry context, legacy `sandbox: true`, and
// the ADCP_SANDBOX env bridge/fail-closed guard.

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { __resetObservedAccountModes } = require('../dist/lib/server/decisioning/runtime/observed-modes');
const { getSdkServer } = require('../dist/lib/server/adcp-server');
const { BuyerAgentRegistry } = require('../dist/lib/server/decisioning/buyer-agent');

function makePlatform(resolveAccount, overrides = {}) {
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
    ...(overrides.agentRegistry !== undefined && { agentRegistry: overrides.agentRegistry }),
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

function buildServer(resolveAccount, overrides = {}) {
  return createAdcpServerFromPlatform(makePlatform(resolveAccount, overrides), {
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

async function callForceCreative(server, args = {}, extras) {
  return server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: {
          scenario: 'force_creative_status',
          params: { creative_id: 'cr_1', status: 'approved' },
          ...args,
        },
      },
    },
    extras
  );
}

async function callListScenarios(server, extras) {
  return server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: { scenario: 'list_scenarios' },
      },
    },
    extras
  );
}

async function callCapabilities(server, extras) {
  return server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_adcp_capabilities',
        arguments: {},
      },
    },
    extras
  );
}

async function listTools(server, extras) {
  return server.dispatchTestRequest(
    {
      method: 'tools/list',
    },
    extras
  );
}

function assertPermissionDenied(result) {
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent?.adcp_error?.code, 'PERMISSION_DENIED');
}

async function callMcpToolsCallHandler(server, args = {}, extra = {}) {
  const sdk = getSdkServer(server);
  const handler = sdk?.server?._requestHandlers?.get('tools/call');
  if (!handler) throw new Error('tools/call request handler not found');
  return handler(
    {
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: {
          scenario: 'force_creative_status',
          params: { creative_id: 'cr_1', status: 'approved' },
          ...args,
        },
      },
    },
    { signal: new AbortController().signal, ...extra }
  );
}

describe('createAdcpServerFromPlatform — sandbox-authority gate (resolver path)', () => {
  beforeEach(() => {
    delete process.env.ADCP_SANDBOX;
    __resetObservedAccountModes();
  });

  it("hides the comply controller when the principal resolves to mode: 'live'", async () => {
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'live_acc',
      mode: 'live',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const caps = await callCapabilities(server);
    assert.strictEqual(caps.structuredContent.compliance_testing, undefined);

    const listed = await listTools(server);
    assert.ok(!listed.tools.some(tool => tool.name === 'comply_test_controller'));

    await assert.rejects(
      () => callForceCreative(server, { account: { account_id: 'live_acc' } }),
      err => err?.code === -32601
    );

    await assert.rejects(
      () => callMcpToolsCallHandler(server, { account: { account_id: 'live_acc' } }),
      err => err?.code === -32601
    );
  });

  it("admits when resolver returns mode: 'sandbox'", async () => {
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'sb_acc',
      mode: 'sandbox',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const caps = await callCapabilities(server);
    assert.ok(caps.structuredContent.compliance_testing);

    const listed = await listTools(server);
    assert.ok(listed.tools.some(tool => tool.name === 'comply_test_controller'));

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

    const listed = await listTools(server);
    assert.ok(listed.tools.some(tool => tool.name === 'comply_test_controller'));

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

    const caps = await callCapabilities(server);
    assert.ok(caps.structuredContent.compliance_testing);

    const listed = await listTools(server);
    assert.ok(listed.tools.some(tool => tool.name === 'comply_test_controller'));

    const result = await callForceCreative(server, { account: { account_id: 'legacy_sb' } });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('returns PERMISSION_DENIED when a sandbox principal targets a live account', async () => {
    const server = buildServer(async ref => {
      if (ref?.account_id === 'live_acc') {
        return {
          id: 'live_acc',
          mode: 'live',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        };
      }
      return {
        id: ref?.account_id ?? 'principal_sb',
        mode: 'sandbox',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      };
    });

    const result = await callForceCreative(server, {
      account: { account_id: 'live_acc' },
      context: { correlation_id: 'corr_1' },
      ext: { probe: true },
    });

    assertPermissionDenied(result);
    assert.deepStrictEqual(result.structuredContent.context, { correlation_id: 'corr_1' });
    assert.deepStrictEqual(result.structuredContent.ext, { probe: true });
    const textPayload = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(textPayload.context, result.structuredContent.context);
    assert.deepStrictEqual(textPayload.ext, result.structuredContent.ext);
  });

  it('ignores caller-supplied account.sandbox claim when a sandbox principal targets a live account', async () => {
    // Trust boundary: resolver is authoritative, NOT the wire. Buyer cannot
    // self-promote by stuffing sandbox: true into the account ref.
    const server = buildServer(async ref => {
      if (ref?.account_id === 'spoof') {
        return {
          id: 'spoof',
          mode: 'live',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        };
      }
      return {
        id: ref?.account_id ?? 'principal_sb',
        mode: 'sandbox',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      };
    });

    const result = await callForceCreative(server, {
      account: { account_id: 'spoof', sandbox: true },
    });

    assertPermissionDenied(result);
  });

  it('passes actual discovery context to accounts.resolve when checking visibility', async () => {
    const calls = [];
    const server = buildServer(async (ref, ctx) => {
      calls.push({ ref, toolName: ctx?.toolName });
      return {
        id: ref?.account_id ?? 'principal_sb',
        mode: 'sandbox',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      };
    });

    await callCapabilities(server);
    await listTools(server);
    await callListScenarios(server);

    assert.deepStrictEqual(
      calls.map(c => c.toolName),
      ['get_adcp_capabilities', undefined, 'comply_test_controller']
    );
    assert.deepStrictEqual(
      calls.map(c => c.ref),
      [undefined, undefined, undefined]
    );
  });

  it('threads resolved BuyerAgent into comply visibility and target account resolution', async () => {
    const registryAgent = {
      agent_url: 'https://buyer.example/agent',
      display_name: 'Buyer',
      status: 'active',
      billing_capabilities: new Set(['operator']),
      sandbox_only: true,
    };
    const seen = [];
    const server = buildServer(
      async (ref, ctx) => {
        seen.push({ ref, agent: ctx?.agent, inputScenario: ctx?.input?.scenario });
        return {
          id: ref?.account_id ?? 'principal_sb',
          mode: ctx?.agent === registryAgent ? 'sandbox' : 'live',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        };
      },
      {
        agentRegistry: {
          async resolve() {
            return registryAgent;
          },
        },
      }
    );

    const result = await callForceCreative(server, { account: { account_id: 'target_sb' } });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
    assert.ok(seen.length >= 2, 'visibility and target resolution should both run');
    assert.ok(seen.every(call => call.agent === registryAgent));
    assert.ok(seen.some(call => call.ref === undefined));
    assert.ok(seen.some(call => call.ref?.account_id === 'target_sb'));
    assert.ok(seen.some(call => call.inputScenario === 'force_creative_status'));
  });

  it('threads serve-style authInfo.extra.credential into bearerOnly registry for visibility', async () => {
    const registryAgent = {
      agent_url: 'https://buyer.example/agent',
      display_name: 'Buyer',
      status: 'active',
      billing_capabilities: new Set(['operator']),
    };
    const seenCredentials = [];
    const server = buildServer(
      async (ref, ctx) => ({
        id: ref?.account_id ?? 'principal_from_agent',
        mode: ctx?.agent === registryAgent ? 'sandbox' : 'live',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      }),
      {
        agentRegistry: BuyerAgentRegistry.bearerOnly({
          async resolveByCredential(credential, extra, input) {
            seenCredentials.push({ credential, extra, input });
            return credential?.kind === 'api_key' && credential.key_id === 'sandbox-key' ? registryAgent : null;
          },
        }),
      }
    );
    const extra = {
      authInfo: {
        clientId: 'buyer_1',
        extra: {
          credential: { kind: 'api_key', key_id: 'sandbox-key' },
          tenant: 'tenant_1',
        },
      },
    };

    const caps = await callCapabilities(server, extra);
    assert.ok(caps.structuredContent.compliance_testing);

    const listed = await listTools(server, extra);
    assert.ok(listed.tools.some(tool => tool.name === 'comply_test_controller'));

    const result = await callMcpToolsCallHandler(server, { account: { account_id: 'target_sb' } }, extra);
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
    assert.ok(seenCredentials.length >= 3, 'capabilities, tools/list, and controller dispatch resolve agent');
    assert.ok(seenCredentials.every(call => call.credential?.key_id === 'sandbox-key'));
    assert.ok(seenCredentials.every(call => call.extra?.tenant === 'tenant_1'));
    assert.ok(seenCredentials.some(call => call.input?.scenario === 'force_creative_status'));
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

  it('hides the controller when no principal resolves and no sandbox deployment flag is set', async () => {
    const server = buildServer(async () => null);

    const caps = await callCapabilities(server);
    assert.strictEqual(caps.structuredContent.compliance_testing, undefined);

    const listed = await listTools(server);
    assert.ok(!listed.tools.some(tool => tool.name === 'comply_test_controller'));

    await assert.rejects(
      () => callForceCreative(server, { account: { sandbox: true } }),
      err => err?.code === -32601
    );
  });

  it('exposes discovery and admits accountRef.sandbox === true in an explicitly sandboxed deployment', async () => {
    process.env.ADCP_SANDBOX = '1';
    const server = buildServer(async () => null);

    const caps = await callCapabilities(server);
    assert.ok(caps.structuredContent.compliance_testing);

    const listed = await listTools(server);
    assert.ok(listed.tools.some(tool => tool.name === 'comply_test_controller'));

    const result = await callForceCreative(server, { account: { sandbox: true } });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('admits via deployment-scoped ADCP_SANDBOX=1 when no account resolves and accountRef.sandbox is absent', async () => {
    process.env.ADCP_SANDBOX = '1';
    const server = buildServer(async () => null);

    const result = await callForceCreative(server);

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('returns PERMISSION_DENIED when a sandbox principal targets an unresolved non-sandbox account', async () => {
    const server = buildServer(async ref => {
      if (ref == null) {
        return {
          id: 'principal_sb',
          mode: 'sandbox',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        };
      }
      return null;
    });

    const result = await callForceCreative(server, { account: { account_id: 'missing_live' } });

    assertPermissionDenied(result);
  });

  it('does NOT admit on accountRef.sandbox when the resolver names a live account', async () => {
    // The wire flag is a fallback for the *unresolved* path. Once the
    // resolver names the account, the resolver wins and the buyer's wire
    // claim is ignored.
    const server = buildServer(async ref => {
      if (ref?.account_id === 'live_acc') {
        return {
          id: 'live_acc',
          mode: 'live',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        };
      }
      return {
        id: ref?.account_id ?? 'principal_sb',
        mode: 'sandbox',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      };
    });

    const result = await callForceCreative(server, {
      account: { account_id: 'live_acc', sandbox: true },
    });

    assertPermissionDenied(result);
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
    // loudly so operators notice in their logs — a PERMISSION_DENIED
    // response would be too quiet for what is fundamentally a deployment-level misconfig.
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

  it('list_scenarios is exempt from the target-account gate once the sandbox principal can see the controller', async () => {
    // A sandbox principal can use list_scenarios without a target account.
    // A live principal cannot see the controller at all.
    const server = buildServer(async ref => ({
      id: ref?.account_id ?? 'principal_sb',
      mode: 'sandbox',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    }));

    const probe = await callListScenarios(server);

    assert.notStrictEqual(probe.isError, true);
    assert.ok(Array.isArray(probe.structuredContent.scenarios));
    assert.ok(probe.structuredContent.scenarios.includes('force_creative_status'));
  });
});
