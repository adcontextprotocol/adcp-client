// Tests for platform.instructions thread-through on createAdcpServerFromPlatform.
// Covers #1312 (string-form: platform wins over opts) and #1347 (function-form:
// evaluated once per MCP initialize handshake).

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { getSdkServer, FUNCTION_INSTRUCTIONS } = require('../dist/lib/server/adcp-server');

function buildPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

function readInstructions(server) {
  const sdk = getSdkServer(server);
  if (!sdk) throw new Error('readInstructions: value is not an AdcpServer');
  // McpServer wraps a low-level Server which stashes instructions on
  // `_instructions` (per @modelcontextprotocol/sdk Server constructor).
  return sdk.server._instructions;
}

/**
 * Simulate an MCP `initialize` handshake in-process by invoking the
 * registered handler directly. The handler is keyed on the string
 * `'initialize'` in `sdk.server._requestHandlers`.
 */
async function simulateInitialize(server, extra = {}) {
  const sdk = getSdkServer(server);
  if (!sdk) throw new Error('simulateInitialize: value is not an AdcpServer');
  const handler = sdk.server._requestHandlers?.get('initialize');
  if (!handler) throw new Error('simulateInitialize: no initialize handler registered');
  return handler(
    {
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } },
    },
    extra
  );
}

describe('createAdcpServerFromPlatform — server instructions (#1312)', () => {
  it('threads platform.instructions to the underlying MCP server', () => {
    const platform = buildPlatform({
      instructions: 'Publisher-wide brand safety: alcohol disallowed.',
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(readInstructions(server), 'Publisher-wide brand safety: alcohol disallowed.');
  });

  it('threads opts.instructions when platform omits it (v5 escape hatch)', () => {
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      instructions: 'Decision policy: prefer renewable bidders.',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(readInstructions(server), 'Decision policy: prefer renewable bidders.');
  });

  it('platform.instructions wins over opts.instructions when both are supplied', () => {
    const platform = buildPlatform({
      instructions: 'platform-declared',
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      instructions: 'opts-supplied',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(readInstructions(server), 'platform-declared');
  });

  it('omits instructions entirely when neither is set', () => {
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(readInstructions(server), undefined);
  });
});

describe('createAdcpServerFromPlatform — function-form instructions (#1347)', () => {
  it('evaluates a sync function on initialize and sets _instructions', async () => {
    const platform = buildPlatform({
      instructions: () => 'dynamic: alcohol disallowed',
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    // Before initialize: _instructions is undefined (function not yet called).
    assert.strictEqual(readInstructions(server), undefined);
    await simulateInitialize(server);
    assert.strictEqual(readInstructions(server), 'dynamic: alcohol disallowed');
  });

  it('evaluates an async function on initialize', async () => {
    const platform = buildPlatform({
      instructions: async () => {
        // Simulate async registry fetch.
        await new Promise(resolve => setImmediate(resolve));
        return 'async: carbon-aware pricing applies';
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await simulateInitialize(server);
    assert.strictEqual(readInstructions(server), 'async: carbon-aware pricing applies');
  });

  it('passes authInfo from extra into the InstructionsContext', async () => {
    let capturedCtx;
    const platform = buildPlatform({
      instructions: ctx => {
        capturedCtx = ctx;
        return 'ok';
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const fakeAuthInfo = { clientId: 'buyer-123', kind: 'api_key', credential: { kind: 'api_key', apiKey: 'k' } };
    await simulateInitialize(server, { authInfo: fakeAuthInfo });
    assert.deepStrictEqual(capturedCtx?.authInfo, fakeAuthInfo);
  });

  it("onInstructionsError: 'skip' (default) swallows throw and omits instructions", async () => {
    const platform = buildPlatform({
      instructions: () => {
        throw new Error('registry unavailable');
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      // onInstructionsError default is 'skip'
    });
    // Should not throw — initialize proceeds without instructions.
    await assert.doesNotReject(() => simulateInitialize(server));
    assert.strictEqual(readInstructions(server), undefined);
  });

  it("onInstructionsError: 'fail' propagates the throw from initialize", async () => {
    const platform = buildPlatform({
      instructions: () => {
        throw new Error('policy-doc unavailable');
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      onInstructionsError: 'fail',
    });
    await assert.rejects(() => simulateInitialize(server), /policy-doc unavailable/);
  });

  it('undefined return from function omits instructions (same as skip)', async () => {
    const platform = buildPlatform({
      instructions: () => undefined,
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await simulateInitialize(server);
    assert.strictEqual(readInstructions(server), undefined);
  });

  it('marks server with FUNCTION_INSTRUCTIONS symbol', () => {
    const platform = buildPlatform({
      instructions: () => 'marker test',
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(server[FUNCTION_INSTRUCTIONS], true);
  });

  it('string-form instructions do NOT set FUNCTION_INSTRUCTIONS marker', () => {
    const platform = buildPlatform({ instructions: 'static string' });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(server[FUNCTION_INSTRUCTIONS], undefined);
  });
});
