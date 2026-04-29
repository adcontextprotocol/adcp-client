/**
 * Unit tests for the isPrivateAddress gate in connectMCPWithFallback (issue #1054).
 *
 * Verifies the address-classification logic that prevents SSE fallback for
 * localhost/private-IP agents. Replicates the isPrivateAddress() logic inline
 * (same pattern as mcp-discovery-sse-fallback.test.js and mcp-sse-auth-fallback.test.js)
 * so the tests run without a compiled dist/.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

/**
 * Replicates isPrivateAddress() from src/lib/protocols/mcp.ts.
 * Keep in sync with the source; any divergence is a test bug.
 */
function isPrivateAddress(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  if (/^fe80:/i.test(host)) return true;
  return false;
}

describe('isPrivateAddress: private/loopback detection', () => {
  test('localhost is private', () => {
    assert.ok(isPrivateAddress(new URL('http://localhost:3000/mcp')));
  });

  test('127.0.0.1 is private', () => {
    assert.ok(isPrivateAddress(new URL('http://127.0.0.1:8080/mcp')));
  });

  test('127.x.x.x range is private', () => {
    assert.ok(isPrivateAddress(new URL('http://127.99.0.1/mcp')));
  });

  test('IPv6 loopback ::1 is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[::1]:3000/mcp')));
  });

  test('10.x.x.x is private (RFC-1918)', () => {
    assert.ok(isPrivateAddress(new URL('http://10.0.0.1/mcp')));
    assert.ok(isPrivateAddress(new URL('http://10.255.255.255/mcp')));
  });

  test('192.168.x.x is private (RFC-1918)', () => {
    assert.ok(isPrivateAddress(new URL('http://192.168.1.100/mcp')));
  });

  test('172.16–31.x.x is private (RFC-1918)', () => {
    assert.ok(isPrivateAddress(new URL('http://172.16.0.1/mcp')));
    assert.ok(isPrivateAddress(new URL('http://172.31.255.255/mcp')));
  });

  test('172.15.x.x is NOT private (below RFC-1918 range)', () => {
    assert.ok(!isPrivateAddress(new URL('http://172.15.0.1/mcp')));
  });

  test('172.32.x.x is NOT private (above RFC-1918 range)', () => {
    assert.ok(!isPrivateAddress(new URL('http://172.32.0.1/mcp')));
  });

  test('fe80:: link-local is private', () => {
    assert.ok(isPrivateAddress(new URL('http://[fe80::1%25eth0]:3000/mcp')));
  });

  test('public IP is not private', () => {
    assert.ok(!isPrivateAddress(new URL('https://agent.example.com/mcp')));
    assert.ok(!isPrivateAddress(new URL('https://8.8.8.8/mcp')));
    assert.ok(!isPrivateAddress(new URL('https://203.0.113.1/mcp')));
  });

  test('192.167.x.x is NOT private', () => {
    assert.ok(!isPrivateAddress(new URL('http://192.167.1.1/mcp')));
  });

  test('11.x.x.x is NOT private', () => {
    assert.ok(!isPrivateAddress(new URL('http://11.0.0.1/mcp')));
  });
});
