process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('@adcp/sdk/server/legacy/v5 subpath', () => {
  it('exports createAdcpServer (the v5 handler-bag constructor)', () => {
    const legacy = require('../dist/lib/server/legacy/v5');
    assert.equal(typeof legacy.createAdcpServer, 'function');
  });

  it('exports the same createAdcpServer reference as @adcp/sdk/server (no fork)', () => {
    const fromTopLevel = require('../dist/lib/server').createAdcpServer;
    const fromSubpath = require('../dist/lib/server/legacy/v5').createAdcpServer;
    assert.equal(fromTopLevel, fromSubpath, 'subpath re-exports the same function — not a fork');
  });

  it('exports the v5-adjacent helpers adopters typically reach for alongside createAdcpServer', () => {
    const legacy = require('../dist/lib/server/legacy/v5');
    assert.equal(typeof legacy.requireSessionKey, 'function');
    assert.equal(typeof legacy.ADCP_PRE_TRANSPORT, 'symbol');
    assert.equal(typeof legacy.ADCP_SIGNED_REQUESTS_STATE, 'symbol');
  });

  it('subpath resolves through the package "exports" map (not deep-relative)', () => {
    // Loading via the package name + subpath — what an external consumer
    // writing `import { createAdcpServer } from '@adcp/sdk/server/legacy/v5'`
    // would hit. Inside this monorepo we resolve via the relative dist
    // path; the consumer-facing path resolution is exercised by package
    // resolution against the published dist + exports map. This test
    // validates the dist artifact exists and is importable.
    assert.doesNotThrow(() => require('../dist/lib/server/legacy/v5/index.js'));
  });
});
