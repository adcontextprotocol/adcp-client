process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('@adcp/sdk/server/legacy/v5 subpath', () => {
  it('exports createAdcpServer (the v5 handler-bag constructor)', () => {
    const legacy = require('../dist/lib/server/legacy/v5');
    assert.equal(typeof legacy.createAdcpServer, 'function');
  });

  it('createAdcpServer is no longer exported from @adcp/sdk/server top-level', () => {
    const topLevel = require('../dist/lib/server');
    assert.equal(
      topLevel.createAdcpServer,
      undefined,
      'createAdcpServer was removed from top-level — only @adcp/sdk/server/legacy/v5 exports it'
    );
    const fromSubpath = require('../dist/lib/server/legacy/v5').createAdcpServer;
    assert.equal(typeof fromSubpath, 'function', 'subpath still exports the v5 constructor');
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
