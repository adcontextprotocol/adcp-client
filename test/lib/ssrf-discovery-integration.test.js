/**
 * Integration test for adcp-client#1618 — confirms the SSRF policy fires
 * at the two integration sites identified in triage:
 *
 * 1. `detectA2AOrMcp` — guard runs BEFORE the try/catch loop, so a denied
 *    URL can't be silently swallowed and converted into `'a2a'` by
 *    `catch { suspect = true }` (the code-reviewer-flagged catch-swallow class).
 *
 * 2. `createTestClient` — guard runs at URL construction so every transport
 *    call inherits the agent URI's policy verdict (covers downstream
 *    `getAgentInfo` / `getAdcpCapabilities` without instrumenting them).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { detectProtocol } = require('../../dist/lib/utils/protocol-detection.js');
const { createTestClient } = require('../../dist/lib/testing/client.js');
const { SsrfRefusedError } = require('../../dist/lib/net/ssrf-fetch.js');

describe('detectProtocol: SSRF policy gate (#1618)', () => {
  test('rejects AWS IMDS literal BEFORE entering the try/catch loop', async () => {
    // If the gate were inside the try/catch, `catch { suspect = true }`
    // would swallow the SsrfRefusedError and return 'a2a' — the exact
    // bug the code-reviewer flagged.
    await assert.rejects(
      () => detectProtocol('http://169.254.169.254/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError, `Expected SsrfRefusedError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'always_blocked_address');
        return true;
      }
    );
  });

  test('rejects RFC-1918 hostname literal in default-strict mode', async () => {
    await assert.rejects(
      () => detectProtocol('http://10.0.0.5/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'private_address');
        return true;
      }
    );
  });

  test('allows public hostname through the gate', async () => {
    // Mock fetch to a 404 so detectProtocol picks 'mcp' — confirms the
    // policy gate does NOT refuse public addresses, only blocks the
    // SSRF targets.
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    try {
      const result = await detectProtocol('https://agent.example.com/');
      assert.strictEqual(result, 'mcp');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('allows loopback (localhost) through the gate', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    try {
      const result = await detectProtocol('http://localhost:3000/');
      assert.strictEqual(result, 'mcp');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('allows 127.0.0.1 loopback IP through the gate', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    try {
      const result = await detectProtocol('http://127.0.0.1:3000/');
      assert.strictEqual(result, 'mcp');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('createTestClient: SSRF policy gate (#1618)', () => {
  test('throws SsrfRefusedError on AWS IMDS', () => {
    assert.throws(
      () => createTestClient('http://169.254.169.254/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'always_blocked_address');
        // Hostname-only in user-visible message — no resolved IP echo.
        assert.match(err.message, /169\.254\.169\.254/);
        return true;
      }
    );
  });

  test('throws SsrfRefusedError on RFC-1918', () => {
    assert.throws(
      () => createTestClient('http://192.168.1.5/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'private_address');
        return true;
      }
    );
  });

  test('throws SsrfRefusedError on IPv6 link-local', () => {
    assert.throws(
      () => createTestClient('http://[fe80::1]/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'always_blocked_address');
        return true;
      }
    );
  });

  test('accepts loopback', () => {
    assert.doesNotThrow(() => createTestClient('http://localhost:3000/mcp'));
  });

  test('accepts public hostname', () => {
    assert.doesNotThrow(() => createTestClient('https://agent.example.com/mcp'));
  });

  test('accepts 127.0.0.1', () => {
    assert.doesNotThrow(() => createTestClient('http://127.0.0.1:8080/mcp'));
  });
});
