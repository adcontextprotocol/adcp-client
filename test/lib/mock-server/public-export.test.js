/**
 * Smoke test for the `@adcp/sdk/mock-server` public sub-export (#1287).
 *
 * Verifies `bootMockServer` is importable through the public path (not just
 * via the brittle `dist/lib/mock-server/index.js`) and that it actually
 * boots a mock — catches regressions where the package.json `exports` map
 * or `typesVersions` entry drifts away from the dist artifact.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('@adcp/sdk/mock-server public sub-export', () => {
  let handle;

  before(async () => {
    // The whole point — import via the public path, not `../../dist/...`.
    const { bootMockServer } = require('@adcp/sdk/mock-server');
    handle = await bootMockServer({ specialism: 'signal-marketplace', port: 0 });
  });

  after(async () => {
    if (handle) await handle.close();
  });

  it('exposes a bootable url', () => {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves /_debug/traffic via the public-export-booted instance', async () => {
    const res = await fetch(`${handle.url}/_debug/traffic`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('traffic' in body, 'expected traffic field on debug endpoint');
  });
});

describe('@adcp/sdk/mock-server boots a different specialism', () => {
  // Catch a switch-case regression in bootMockServer's specialism dispatch:
  // smoke-tests one non-signal-marketplace specialism so a refactor that
  // breaks one branch doesn't ride along behind a passing signal-marketplace
  // test.
  let handle;
  before(async () => {
    const { bootMockServer } = require('@adcp/sdk/mock-server');
    handle = await bootMockServer({ specialism: 'sales-guaranteed', port: 0 });
  });
  after(async () => {
    if (handle) await handle.close();
  });

  it('boots and exposes a url', () => {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('@adcp/sdk/mock-server rejects unknown specialism', () => {
  it('throws when specialism is not registered', async () => {
    const { bootMockServer } = require('@adcp/sdk/mock-server');
    await assert.rejects(() => bootMockServer({ specialism: 'not-a-real-specialism', port: 0 }), {
      message: /Unknown mock-server specialism/,
    });
  });
});
