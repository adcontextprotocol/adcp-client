/**
 * Probe-policy tests for adcp-client#1618.
 *
 * Validates the loopback-permissive default + IMDS-always-blocked +
 * RFC-1918-strict-by-default + ADCP_ALLOW_INTERNAL_PROBES opt-in matrix.
 *
 * The env flag is read **once at module load** (security review note),
 * so tests that need to flip it have to use `node:test`'s native subprocess
 * model — within a single process the flag is frozen. Tests that don't
 * exercise the env flag share the default-strict module.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { classifyProbeUrl } = require('../../dist/lib/utils/probe-policy.js');

describe('classifyProbeUrl: default policy (#1618)', () => {
  test('public IPv4 literal is allowed', () => {
    assert.strictEqual(classifyProbeUrl('https://1.2.3.4/').allowed, true);
  });

  test('public hostname is allowed', () => {
    assert.strictEqual(classifyProbeUrl('https://agent.example.com/').allowed, true);
  });

  test('localhost (hostname) is allowed', () => {
    assert.strictEqual(classifyProbeUrl('http://localhost:3000/').allowed, true);
  });

  test('127.0.0.1 loopback is allowed', () => {
    assert.strictEqual(classifyProbeUrl('http://127.0.0.1:3000/').allowed, true);
  });

  test('127.x.x.x loopback range is allowed', () => {
    assert.strictEqual(classifyProbeUrl('http://127.42.0.1/').allowed, true);
  });

  test('IPv6 ::1 loopback is allowed', () => {
    assert.strictEqual(classifyProbeUrl('http://[::1]/').allowed, true);
  });

  test('IPv4-mapped IPv6 loopback is allowed', () => {
    assert.strictEqual(classifyProbeUrl('http://[::ffff:127.0.0.1]/').allowed, true);
  });

  test('AWS IMDS (169.254.169.254) is REFUSED — always-blocked', () => {
    const r = classifyProbeUrl('http://169.254.169.254/.well-known/agent.json');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, 'always_blocked');
    assert.match(r.reason, /169\.254\.169\.254/);
  });

  test('IPv4-mapped IPv6 AWS IMDS (::ffff:169.254.169.254) is REFUSED', () => {
    const r = classifyProbeUrl('http://[::ffff:169.254.169.254]/');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, 'always_blocked', 'BlockList canonicalizes IPv4-mapped IPv6');
  });

  test('IPv6 link-local (fe80::) is REFUSED — always-blocked', () => {
    const r = classifyProbeUrl('http://[fe80::1]/');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, 'always_blocked');
  });

  test('RFC-1918 10/8 is REFUSED by default (no env opt-in)', () => {
    const r = classifyProbeUrl('http://10.0.0.5/');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, 'private_address');
    assert.match(r.reason, /ADCP_ALLOW_INTERNAL_PROBES=1/);
  });

  test('RFC-1918 172.16/12 is REFUSED by default', () => {
    assert.strictEqual(classifyProbeUrl('http://172.20.5.5/').allowed, false);
  });

  test('RFC-1918 192.168/16 is REFUSED by default', () => {
    assert.strictEqual(classifyProbeUrl('http://192.168.1.5/').allowed, false);
  });

  test('IPv6 ULA (fc00::/7) is REFUSED by default', () => {
    assert.strictEqual(classifyProbeUrl('http://[fc00::1]/').allowed, false);
  });

  test('CGNAT (100.64/10) is REFUSED by default', () => {
    assert.strictEqual(classifyProbeUrl('http://100.64.0.1/').allowed, false);
  });

  test('error message names hostname only, not the resolved IP', () => {
    const r = classifyProbeUrl('http://10.0.0.5/');
    assert.strictEqual(r.allowed, false);
    // The hostname IS the IP for literal addresses; for DNS-resolved
    // hosts the hostname would NOT be the IP. The protection here is
    // "no extra IP echoed beyond what's already in the URL".
    assert.match(r.reason, /'10\.0\.0\.5'/);
  });

  test('unparseable URL passes through (downstream surfaces error)', () => {
    // probe-policy is not a URL validator; let `new URL(...)` upstream
    // produce its own error.
    assert.strictEqual(classifyProbeUrl('not a url').allowed, true);
  });

  test('localhost.attacker.com does NOT match loopback (subdomain attack)', () => {
    // `localhost` must be the EXACT hostname; `localhost.attacker.example.com`
    // could be DNS-rebound to a private IP. Forcing exact match means this
    // path falls through to public-hostname (allowed at the literal-policy
    // layer; the per-IP check inside ssrfSafeFetch catches the resolved IP).
    const r = classifyProbeUrl('http://localhost.attacker.example.com/');
    assert.strictEqual(r.allowed, true, 'literal policy allows; DNS layer catches');
  });
});

describe('classifyProbeUrl: ADCP_ALLOW_INTERNAL_PROBES=1 opt-in', () => {
  // The env flag is read once at module load, so we have to spawn a fresh
  // Node process to test the opt-in path. Each test below shells out to
  // confirm the flag flip changes the policy.

  function spawnAssertAllowed(url, env = {}) {
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const { classifyProbeUrl } = require('${require.resolve('../../dist/lib/utils/probe-policy.js').replace(/\\/g, '/')}'); const r = classifyProbeUrl('${url}'); console.log(JSON.stringify(r));`,
      ],
      { env: { ...process.env, ADCP_ALLOW_INTERNAL_PROBES: '1', ...env } }
    );
    if (r.status !== 0) throw new Error(`subprocess exited ${r.status}: ${r.stderr.toString()}`);
    return JSON.parse(r.stdout.toString());
  }

  test('ADCP_ALLOW_INTERNAL_PROBES=1 allows RFC-1918 10/8', () => {
    const r = spawnAssertAllowed('http://10.0.0.5/');
    assert.strictEqual(r.allowed, true, 'RFC-1918 should pass with env opt-in');
  });

  test('ADCP_ALLOW_INTERNAL_PROBES=1 allows RFC-1918 192.168/16', () => {
    const r = spawnAssertAllowed('http://192.168.1.5/');
    assert.strictEqual(r.allowed, true);
  });

  test('ADCP_ALLOW_INTERNAL_PROBES=1 STILL refuses AWS IMDS (always-blocked is unconditional)', () => {
    const r = spawnAssertAllowed('http://169.254.169.254/');
    assert.strictEqual(r.allowed, false, 'IMDS is always-blocked even with env opt-in');
    assert.strictEqual(r.code, 'always_blocked');
  });

  test('ADCP_ALLOW_INTERNAL_PROBES=1 STILL refuses IPv6 link-local', () => {
    const r = spawnAssertAllowed('http://[fe80::1]/');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, 'always_blocked');
  });

  test('ADCP_ALLOW_INTERNAL_PROBES=0 (or unset) keeps default-strict', () => {
    // The other tests in this file run with the default env, so this test
    // is implicit — the previous describe() block confirms strict default.
    // We re-verify here for documentation.
    const r = classifyProbeUrl('http://10.0.0.5/');
    assert.strictEqual(r.allowed, false);
  });
});
