/**
 * v2 sunset warning — adcp#2220
 *
 * v2 went unsupported on 2026-04-20 (AdCP 3.0 GA). The client still executes
 * v2 code paths but emits a one-time `console.warn` when a client instance
 * observes non-synthetic v2 capabilities from an agent. Synthetic capabilities
 * (no `get_adcp_capabilities` tool) don't warn because the version is unknown.
 *
 * Suppression: `process.env.ADCP_ALLOW_V2 === '1'`.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

const stubAgent = {
  id: 'a1',
  name: 'stub',
  protocol: 'mcp',
  agent_uri: 'https://stub.example/mcp',
};

function captureWarnings() {
  const captured = [];
  const original = console.warn;
  console.warn = (...args) => {
    captured.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return {
    get calls() {
      return captured;
    },
    restore() {
      console.warn = original;
    },
  };
}

describe('v2 sunset warning (adcp#2220)', () => {
  let origAllow;

  beforeEach(() => {
    origAllow = process.env.ADCP_ALLOW_V2;
    delete process.env.ADCP_ALLOW_V2;
  });

  afterEach(() => {
    if (origAllow === undefined) {
      delete process.env.ADCP_ALLOW_V2;
    } else {
      process.env.ADCP_ALLOW_V2 = origAllow;
    }
  });

  it('emits one warning on first v2 capabilities read', async () => {
    const warn = captureWarnings();
    try {
      const client = new SingleAgentClient(stubAgent);
      client.cachedCapabilities = {
        version: 'v2',
        majorVersions: [2],
        protocols: ['media_buy'],
        features: {},
        extensions: [],
        _synthetic: false, // agent declared v2 via get_adcp_capabilities
      };

      await client.getCapabilities();

      assert.equal(warn.calls.length, 1, 'expected exactly one warning');
      assert.match(warn.calls[0], /v2/);
      assert.match(warn.calls[0], /unsupported/);
      assert.match(warn.calls[0], /2026-04-20/);
      assert.match(warn.calls[0], /ADCP_ALLOW_V2/);
      assert.match(warn.calls[0], /adcp\/issues\/2220/);
    } finally {
      warn.restore();
    }
  });

  it('does not re-emit on subsequent calls from the same client', async () => {
    const warn = captureWarnings();
    try {
      const client = new SingleAgentClient(stubAgent);
      client.cachedCapabilities = {
        version: 'v2',
        majorVersions: [2],
        protocols: ['media_buy'],
        features: {},
        extensions: [],
        _synthetic: false,
      };

      await client.getCapabilities();
      await client.getCapabilities();
      await client.getCapabilities();

      assert.equal(warn.calls.length, 1, 'warning must fire only once per client');
    } finally {
      warn.restore();
    }
  });

  it('does not emit when ADCP_ALLOW_V2=1 is set', async () => {
    process.env.ADCP_ALLOW_V2 = '1';
    const warn = captureWarnings();
    try {
      const client = new SingleAgentClient(stubAgent);
      client.cachedCapabilities = {
        version: 'v2',
        majorVersions: [2],
        protocols: ['media_buy'],
        features: {},
        extensions: [],
        _synthetic: false,
      };

      await client.getCapabilities();

      assert.equal(warn.calls.length, 0, 'opt-out env var must fully suppress');
    } finally {
      warn.restore();
    }
  });

  it('does not emit for synthetic v2 capabilities (version unknown)', async () => {
    const warn = captureWarnings();
    try {
      const client = new SingleAgentClient(stubAgent);
      client.cachedCapabilities = {
        version: 'v2',
        majorVersions: [2],
        protocols: ['media_buy'],
        features: {},
        extensions: [],
        _synthetic: true, // no get_adcp_capabilities on the agent
      };

      await client.getCapabilities();

      assert.equal(warn.calls.length, 0, 'synthetic capabilities must not trigger the sunset warning');
    } finally {
      warn.restore();
    }
  });

  it('does not emit for v3 capabilities', async () => {
    const warn = captureWarnings();
    try {
      const client = new SingleAgentClient(stubAgent);
      client.cachedCapabilities = {
        version: 'v3',
        majorVersions: [3],
        protocols: ['media_buy'],
        features: {},
        extensions: [],
        _synthetic: false,
      };

      await client.getCapabilities();

      assert.equal(warn.calls.length, 0);
    } finally {
      warn.restore();
    }
  });
});
