// Experimental AdCP 3.3 CLI: Web Bot Auth keys, key-directory generation and
// scheduled re-signing, directory verification, trust.json validation, and
// WBA vectors through `adcp signing verify-vector`.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
const VECTORS = path.resolve(__dirname, '../fixtures/wba-profile-vectors');

function run(...args) {
  return spawnSync(process.execPath, ['--no-deprecation', CLI, 'signing', ...args], {
    encoding: 'utf8',
    timeout: 45_000,
  });
}
const json = result => {
  assert.ok(result.stdout, `expected stdout; stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

describe('adcp signing (Web Bot Auth, experimental)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-wba-cli-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('generates a key whose kid is its thumbprint', () => {
    const result = run(
      'generate-key',
      '--profile',
      'web-bot-auth',
      '--private-out',
      path.join(dir, 'k1.pem'),
      '--public-out',
      path.join(dir, 'k1.json')
    );
    assert.equal(result.status, 0, result.stderr);
    const jwk = JSON.parse(readFileSync(path.join(dir, 'k1.json'), 'utf8'));
    assert.match(jwk.kid, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(jwk.adcp_use, undefined);
    assert.equal(jwk.d, undefined);
    assert.equal(run('generate-key', '--profile', 'web-bot-auth', '--kid', 'custom').status, 2);
  });

  it('signs a directory, skips re-signing while valid, and re-signs with --force or near expiry', () => {
    run(
      'generate-key',
      '--profile',
      'web-bot-auth',
      '--private-out',
      path.join(dir, 'k2.pem'),
      '--public-out',
      path.join(dir, 'k2.json')
    );
    const base = [
      'key-directory',
      '--origin',
      'https://buyer.example.com',
      '--key',
      path.join(dir, 'k1.pem'),
      '--key',
      path.join(dir, 'k2.pem'),
      '--out-dir',
      dir,
      '--json',
    ];
    const first = run(...base);
    assert.equal(first.status, 0, first.stderr);
    const signed = json(first);
    assert.equal(signed.outcome, 'signed');
    assert.equal(signed.kids.length, 2);
    const body = readFileSync(path.join(dir, 'http-message-signatures-directory'), 'utf8');
    assert.doesNotMatch(body, /"d"/, 'private material never enters the directory');
    assert.equal(json(run(...base)).outcome, 'fresh');
    assert.equal(json(run(...base, '--force')).outcome, 'signed');
    assert.equal(
      json(run(...base, '--renew-before', '90000')).outcome,
      'signed',
      'expiry within the renewal window re-signs'
    );

    const verified = run('verify-directory', '--origin', 'https://buyer.example.com', '--dir', dir);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(json(verified).kids.length, 2);
    const wrongOrigin = run('verify-directory', '--origin', 'https://attacker.example.com', '--dir', dir);
    assert.equal(wrongOrigin.status, 1);
    assert.equal(json(wrongOrigin).outcome, 'invalid');
  });

  it('validates an authored trust.json for its host', () => {
    const good = path.join(dir, 'trust.json');
    writeFileSync(good, JSON.stringify({ agents: [{ url: 'https://buyer.agency.com', roles: ['adcp:buying'] }] }));
    assert.equal(run('trust-json', 'validate', good, '--operator-domain', 'agency.com').status, 0);
    const bad = path.join(dir, 'bad-trust.json');
    writeFileSync(
      bad,
      JSON.stringify({
        agents: [
          { url: 'https://buyer.agency.com', roles: ['adcp:buying'], jwks_uri: 'https://buyer.agency.com/keys' },
        ],
      })
    );
    const rejected = run('trust-json', 'validate', bad, '--operator-domain', 'agency.com');
    assert.equal(rejected.status, 1);
    assert.equal(json(rejected).outcome, 'invalid');
  });

  it('runs WBA vectors through verify-vector', () => {
    const keys = path.join(VECTORS, 'keys.json');
    const positive = run(
      'verify-vector',
      '--vector',
      path.join(VECTORS, 'positive/002-relay-request-two-signatures.json'),
      '--keys',
      keys
    );
    assert.equal(positive.status, 0, positive.stderr);
    assert.deepEqual(Object.values(json(positive).identities), [
      'https://agent.brand-7k3q.com',
      'https://relay.agency-7k3q.com',
    ]);
    const negative = run(
      'verify-vector',
      '--vector',
      path.join(VECTORS, 'negative/006-key-not-in-named-directory.json'),
      '--keys',
      keys
    );
    assert.equal(negative.status, 1);
    assert.equal(json(negative).status, 403);
  });
});
