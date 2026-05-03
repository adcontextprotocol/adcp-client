'use strict';

// Issue #1347 — `instructions` accepts a function form (lazy / per-session).
// Covers static/string regression, function evaluation, throw semantics
// (skip/fail), the async-not-yet-supported guard, and the
// reuseAgent + function refusal in serve().

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { getSdkServer } = require('../dist/lib/server/adcp-server');
const { ADCP_INSTRUCTIONS_FN } = require('../dist/lib/server/create-adcp-server');

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

describe('instructions — async not yet supported', () => {
  it('a function returning a Promise throws ConfigurationError (regardless of onInstructionsError)', () => {
    assert.throws(
      () =>
        makeServer(
          buildPlatform({
            instructions: () => Promise.resolve('async prose'),
            onInstructionsError: 'skip', // even with skip, async is a config error
          })
        ),
      /async resolution is not yet supported/
    );
  });
});
