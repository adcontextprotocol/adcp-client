// Tests for #1312 — `instructions` thread-through on createAdcpServerFromPlatform.
// Adopters set `platform.instructions` (preferred v6 surface) or pass
// `opts.instructions` (v5 escape hatch); platform wins when both supplied.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { getSdkServer } = require('../dist/lib/server/adcp-server');

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
