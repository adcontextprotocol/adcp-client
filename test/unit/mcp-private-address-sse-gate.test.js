/**
 * Unit tests for the isPrivateAddress gate in connectMCPWithFallback (issue #1054).
 *
 * Verifies the address-classification logic that prevents SSE fallback for
 * localhost/private-IP agents. Replicates isPrivateAddress() inline (same
 * pattern as mcp-discovery-sse-fallback.test.js) so the tests run without dist/.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

/**
 * Replicates isPrivateAddress() from src/lib/protocols/mcp.ts.
 * Keep in sync with the source; any divergence is a test bug.
 */
function isPrivateAddress(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const bare = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (/^127\./.test(bare)) return true;
  if (/^10\./.test(bare)) return true;
  if (/^192\.168\./.test(bare)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(bare)) return true;
  if (/^fe80:/i.test(host)) return true;
  return false;
}

describe('isPrivateAddress: private/loopback detection', () => {
  // Named hosts
  test('localhost is private', () => {
    assert.ok(isPrivateAddress(new URL('http://localhost:3000/mcp')));
  });

  // IPv4 loopback
  test('127.0.0.1 is private', () => {
    assert.ok(isPrivateAddress(new URL('http://127.0.0.1:8080/mcp')));
  });

  test('127.x.x.x range is private', () => {
    assert.ok(isPrivateAddress(new URL('http://127.99.0.1/mcp')));
  });

  // IPv6 loopback / unspecified
  test('IPv6 loopback ::1 is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::1]:3000/mcp')));
  });

  test('IPv6 unspecified :: is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::]/mcp')));
  });

  // Unspecified IPv4
  test('0.0.0.0 is private', () => {
    assert.ok(isPrivateAddress(new URL('http://0.0.0.0/mcp')));
  });

  // RFC-1918 private ranges
  test('10.x.x.x is private', () => {
    assert.ok(isPrivateAddress(new URL('http://10.0.0.1/mcp')));
    assert.ok(isPrivateAddress(new URL('http://10.255.255.255/mcp')));
  });

  test('192.168.x.x is private', () => {
    assert.ok(isPrivateAddress(new URL('http://192.168.1.100/mcp')));
  });

  test('172.16–31.x.x is private', () => {
    assert.ok(isPrivateAddress(new URL('http://172.16.0.1/mcp')));
    assert.ok(isPrivateAddress(new URL('http://172.31.255.255/mcp')));
  });

  test('172.15.x.x is NOT private (below RFC-1918 range)', () => {
    assert.ok(!isPrivateAddress(new URL('http://172.15.0.1/mcp')));
  });

  test('172.32.x.x is NOT private (above RFC-1918 range)', () => {
    assert.ok(!isPrivateAddress(new URL('http://172.32.0.1/mcp')));
  });

  // IPv4-mapped IPv6 (::ffff:x.y.z.w)
  test('::ffff:127.0.0.1 (IPv4-mapped loopback) is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::ffff:127.0.0.1]/mcp')));
  });

  test('::ffff:10.x.x.x (IPv4-mapped RFC-1918) is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::ffff:10.0.0.1]/mcp')));
  });

  test('::ffff:192.168.x.x (IPv4-mapped RFC-1918) is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::ffff:192.168.1.1]/mcp')));
  });

  test('::ffff:172.16.x.x (IPv4-mapped RFC-1918) is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::ffff:172.16.0.1]/mcp')));
  });

  // IPv6 link-local
  test('fe80:: link-local is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[fe80::1]/mcp')));
  });

  // Public addresses
  test('public hostname is not private', () => {
    assert.ok(!isPrivateAddress(new URL('https://agent.example.com/mcp')));
  });

  test('public IPv4 is not private', () => {
    assert.ok(!isPrivateAddress(new URL('https://8.8.8.8/mcp')));
    assert.ok(!isPrivateAddress(new URL('https://203.0.113.1/mcp')));
  });

  test('192.167.x.x is NOT private', () => {
    assert.ok(!isPrivateAddress(new URL('http://192.167.1.1/mcp')));
  });

  test('11.x.x.x is NOT private', () => {
    assert.ok(!isPrivateAddress(new URL('http://11.0.0.1/mcp')));
  });

  test('::ffff: prefix on a public address is not private', () => {
    assert.ok(!isPrivateAddress(new URL('http://[::ffff:8.8.8.8]/mcp')));
  });
});
