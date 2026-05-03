'use strict';

// Issue #1347 / #1393 — `instructions` accepts a function form (lazy / per-session),
// including async functions whose Promise is awaited at MCP `initialize` time.
// Covers static/string regression, sync function evaluation, throw semantics
// (skip/fail), async happy-path, async rejection, and the
// reuseAgent + function refusal in serve().

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { getSdkServer } = require('../dist/lib/server/adcp-server');
const { ADCP_INSTRUCTIONS_FN } = require('../dist/lib/server/create-adcp-server');

/**
 * Build a minimal AdcpServer directly (no platform layer). Used for testing
 * createAdcpServer's instructions handling without the platform intermediary.
 */
function makeDirectServer(opts = {}) {
  return createAdcpServer({
    name: 'test',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    ...opts,
  });
}

/**
 * Simulate an MCP `initialize` handshake in-process by invoking the
 * registered handler directly. Required for async instructions tests —
 * async resolution happens inside the initialize handler, not at construction.
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

function makeServer(platform, opts = {}) {
  return createAdcpServerFromPlatform(platform, {
    name: 'gap-1347',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    ...opts,
  });
}

function readInstructions(server) {
  const sdk = getSdkServer(server);
  if (!sdk) throw new Error('readInstructions: not an AdcpServer');
  return sdk.server._instructions;
}

describe('instructions — static string (regression)', () => {
  it('threads a string through unchanged', () => {
    const server = makeServer(buildPlatform({ instructions: 'static prose' }));
    assert.equal(readInstructions(server), 'static prose');
    assert.equal(server[ADCP_INSTRUCTIONS_FN], undefined, 'string form must NOT mark INSTRUCTIONS_FN');
  });

  it('omits instructions when neither form is set', () => {
    const server = makeServer(buildPlatform());
    assert.equal(readInstructions(server), undefined);
    assert.equal(server[ADCP_INSTRUCTIONS_FN], undefined);
  });
});

describe('instructions — function form', () => {
  it('evaluates the function at construction and uses the returned string', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return `prose-${calls}`;
    };
    const a = makeServer(buildPlatform({ instructions: fn }));
    assert.equal(readInstructions(a), 'prose-1');
    assert.equal(calls, 1);

    // A second createAdcpServer call (which is what `serve({ reuseAgent: false })`
    // does per request) re-evaluates the function — that is the per-session
    // re-evaluation contract.
    const b = makeServer(buildPlatform({ instructions: fn }));
    assert.equal(readInstructions(b), 'prose-2');
    assert.equal(calls, 2);
  });

  it('marks the server with ADCP_INSTRUCTIONS_FN when function form is used', () => {
    const server = makeServer(buildPlatform({ instructions: () => 'x' }));
    assert.equal(server[ADCP_INSTRUCTIONS_FN], true);
  });

  it('treats a function returning undefined as no instructions', () => {
    const server = makeServer(buildPlatform({ instructions: () => undefined }));
    assert.equal(readInstructions(server), undefined);
    assert.equal(server[ADCP_INSTRUCTIONS_FN], true, 'still marked — adopter chose the function form');
  });

  it('passes a SessionContext object to the callback (currently empty, future-compatible)', () => {
    let received;
    makeServer(
      buildPlatform({
        instructions: ctx => {
          received = ctx;
          return 'ok';
        },
      })
    );
    assert.ok(received, 'function must receive a ctx argument');
    // Forward-compatible: authInfo / agent are reserved fields, currently undefined.
    assert.equal(received.authInfo, undefined);
    assert.equal(received.agent, undefined);
  });
});

describe('instructions — onInstructionsError', () => {
  it("default 'skip' — function throw resolves to undefined and does NOT propagate", () => {
    const server = makeServer(
      buildPlatform({
        instructions: () => {
          throw new Error('registry fetch failed');
        },
      })
    );
    assert.equal(readInstructions(server), undefined);
  });

  it("'fail' — function throw rethrows so the caller can surface session failure", () => {
    assert.throws(
      () =>
        makeServer(
          buildPlatform({
            instructions: () => {
              throw new Error('load-bearing policy unreachable');
            },
            onInstructionsError: 'fail',
          })
        ),
      /load-bearing policy unreachable/
    );
  });

  it("'skip' is also the explicit choice — same behavior as default", () => {
    const server = makeServer(
      buildPlatform({
        instructions: () => {
          throw new Error('boom');
        },
        onInstructionsError: 'skip',
      })
    );
    assert.equal(readInstructions(server), undefined);
  });
});

describe('instructions — null safety (Promise probe)', () => {
  it('a function returning null does NOT crash on the Promise probe', () => {
    // Regression: the Promise detection used to read
    // `(result as { then?: unknown }).then` which throws TypeError on null.
    const server = makeServer(
      buildPlatform({
        instructions: () => null,
      })
    );
    // null is a non-string non-undefined sync return — rejected at construction
    // and surfaced through the 'skip' default as undefined.
    assert.equal(readInstructions(server), undefined);
  });
});

describe('instructions — non-string return type', () => {
  it('a function returning a number is rejected (with onInstructionsError: fail surfaces ConfigurationError)', () => {
    assert.throws(
      () =>
        makeServer(
          buildPlatform({
            instructions: () => /** @type {any} */ (42),
            onInstructionsError: 'fail',
          })
        ),
      /must return string \| undefined, got number/
    );
  });

  it('a function returning an object is rejected (no silent "[object Object]" coercion)', () => {
    assert.throws(
      () =>
        makeServer(
          buildPlatform({
            instructions: () => /** @type {any} */ ({ prose: 'oops' }),
            onInstructionsError: 'fail',
          })
        ),
      /must return string \| undefined, got object/
    );
  });

  it("default 'skip' catches bad-type returns and resolves to undefined", () => {
    const server = makeServer(
      buildPlatform({
        instructions: () => /** @type {any} */ (42),
      })
    );
    assert.equal(readInstructions(server), undefined);
  });
});

// ---------------------------------------------------------------------------
// Async instructions (#1393) — createAdcpServer direct tests
// ---------------------------------------------------------------------------

describe('instructions — async function form (createAdcpServer)', () => {
  it('happy path: async function resolves and sets instructions at initialize', async () => {
    const server = makeDirectServer({
      instructions: async () => {
        await new Promise(resolve => setImmediate(resolve));
        return 'async-prose';
      },
    });
    // Before initialize: _instructions is undefined (async not yet resolved).
    assert.equal(readInstructions(server), undefined);
    const result = await simulateInitialize(server);
    // Resolved value appears both on the internal field and in the wire response.
    assert.equal(readInstructions(server), 'async-prose');
    assert.equal(result?.instructions, 'async-prose');
  });

  it('async function returning undefined → no instructions after initialize', async () => {
    const server = makeDirectServer({ instructions: async () => undefined });
    await simulateInitialize(server);
    assert.equal(readInstructions(server), undefined);
    // ADCP_INSTRUCTIONS_FN marker must still be set — adopter chose the function form.
    assert.equal(server[ADCP_INSTRUCTIONS_FN], true);
  });

  it("onInstructionsError 'skip' (default) swallows async rejection", async () => {
    const server = makeDirectServer({
      instructions: async () => { throw new Error('registry down'); },
    });
    await assert.doesNotReject(() => simulateInitialize(server));
    assert.equal(readInstructions(server), undefined);
  });

  it("onInstructionsError 'fail' propagates async rejection to initialize", async () => {
    const server = makeDirectServer({
      instructions: async () => { throw new Error('load-bearing policy unreachable'); },
      onInstructionsError: 'fail',
    });
    await assert.rejects(() => simulateInitialize(server), /load-bearing policy unreachable/);
  });

  it("onInstructionsError 'skip' swallows async non-string resolution", async () => {
    const server = makeDirectServer({
      instructions: async () => /** @type {any} */ (42),
    });
    await assert.doesNotReject(() => simulateInitialize(server));
    assert.equal(readInstructions(server), undefined);
  });

  it("onInstructionsError 'fail' propagates async non-string resolution as error", async () => {
    const server = makeDirectServer({
      instructions: async () => /** @type {any} */ (42),
      onInstructionsError: 'fail',
    });
    await assert.rejects(() => simulateInitialize(server), /resolved to number/);
  });

  it('ADCP_INSTRUCTIONS_FN marker is set for async function form', () => {
    const server = makeDirectServer({
      instructions: async () => 'marker-test',
    });
    assert.equal(server[ADCP_INSTRUCTIONS_FN], true);
  });

  it('each createAdcpServer call starts a fresh async fetch (per-session semantic)', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return `prose-${calls}`;
    };
    const a = makeDirectServer({ instructions: fn });
    const b = makeDirectServer({ instructions: fn });
    await simulateInitialize(a);
    await simulateInitialize(b);
    assert.equal(readInstructions(a), 'prose-1');
    assert.equal(readInstructions(b), 'prose-2');
    assert.equal(calls, 2);
  });
});
