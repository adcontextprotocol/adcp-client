const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../../package.json');

describe('net SSRF helpers public exports', () => {
  it('exports the SSRF helpers from the package root and @adcp/sdk/net', () => {
    const sdk = require('@adcp/sdk');
    const net = require('@adcp/sdk/net');

    assert.strictEqual(typeof sdk.ssrfSafeFetch, 'function');
    assert.strictEqual(typeof sdk.decodeBodyAsJsonOrText, 'function');
    assert.strictEqual(typeof sdk.SsrfRefusedError, 'function');
    assert.strictEqual(typeof sdk.isPrivateIp, 'function');
    assert.strictEqual(typeof sdk.isAlwaysBlocked, 'function');
    assert.strictEqual(typeof sdk.isLikelyPrivateUrl, 'function');
    assert.ok(sdk.SSRF_TRANSIENT_CODES instanceof Set);
    assert.strictEqual(sdk.isPrivateIp('127.0.0.1'), true);

    assert.strictEqual(typeof net.ssrfSafeFetch, 'function');
    assert.strictEqual(typeof net.decodeBodyAsJsonOrText, 'function');
    assert.strictEqual(typeof net.SsrfRefusedError, 'function');
    assert.strictEqual(typeof net.isPrivateIp, 'function');
    assert.strictEqual(typeof net.isAlwaysBlocked, 'function');
    assert.strictEqual(typeof net.isLikelyPrivateUrl, 'function');
    assert.ok(net.SSRF_TRANSIENT_CODES instanceof Set);
    assert.strictEqual(net.isAlwaysBlocked('169.254.169.254'), true);

    assert.strictEqual(sdk.ssrfSafeFetch, net.ssrfSafeFetch);
    assert.strictEqual(sdk.SsrfRefusedError, net.SsrfRefusedError);
    assert.strictEqual(sdk.SSRF_TRANSIENT_CODES, net.SSRF_TRANSIENT_CODES);
  });

  it('publishes runtime and declaration paths for @adcp/sdk/net', () => {
    assert.deepStrictEqual(pkg.exports['./net'], {
      import: { types: './dist/lib/net/index.d.mts', default: './dist/lib/net/index.mjs' },
      require: { types: './dist/lib/net/index.d.ts', default: './dist/lib/net/index.js' },
    });
    assert.deepStrictEqual(pkg.typesVersions['*'].net, ['dist/lib/net/index.d.ts']);

    const distRoot = path.join(__dirname, '..', '..', 'dist', 'lib', 'net');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.js')), 'dist/lib/net/index.js must exist');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.d.ts')), 'dist/lib/net/index.d.ts must exist');
  });
});
