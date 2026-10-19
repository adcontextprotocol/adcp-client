// test/wba-interop/adapter.cjs speaks the adcp repository's Web Bot Auth
// harness protocol. These cases run it the way the harness does, one process
// per operation, so the adapter cannot drift from the SDK's public API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');

const ADAPTER = path.join(__dirname, '../wba-interop/adapter.cjs');
const ORIGIN = 'https://buyer.example.com';
const NOW = 1790841610;
const REQUEST = {
  method: 'POST',
  url: 'https://seller.example.com/mcp',
  headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
};

const spawn = operation =>
  spawnSync(process.execPath, [ADAPTER], { input: JSON.stringify(operation), encoding: 'utf8' });
function run(operation) {
  const result = spawn(operation);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const pick = ({ ok, status, rule }) => ({ ok, status, rule });

test('the adapter signs and verifies requests and directories', () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const directory = run({ op: 'sign_directory', keys: [key], origin: ORIGIN, now: NOW });
  assert.equal(directory.status, 200);
  const checked = run({ op: 'verify_directory', origin: ORIGIN, response: directory, now: NOW });
  assert.equal(checked.ok, true);
  assert.equal(checked.keyids.length, 1);

  const request = run({ op: 'sign_request', key, origin: ORIGIN, request: REQUEST, now: NOW });
  const directories = { [ORIGIN]: directory };
  assert.deepEqual(run({ op: 'verify_request', request, directories, now: NOW }), {
    ok: true,
    identity: ORIGIN,
    keyid: checked.keyids[0],
  });
  // `prior` builds replay state: the same request verified twice is a replay.
  assert.deepEqual(pick(run({ op: 'verify_request', request, directories, now: NOW, prior: [request] })), {
    ok: false,
    status: 429,
    rule: 'replayed',
  });
});

test('only the SDK verification refusals are refusals; any other error crashes the adapter', () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  // A refusal: a request with no signature fields is a 403.
  assert.deepEqual(pick(run({ op: 'verify_request', request: REQUEST, directories: {}, now: NOW })), {
    ok: false,
    status: 403,
    rule: 'headers_missing',
  });
  // A crash, which the harness grades as a failure, never as a refusal: an
  // unknown operation, a signer refusing its input, and a malformed operation.
  for (const operation of [
    { op: 'unknown' },
    { op: 'sign_request', key, origin: 'http://buyer.example.com', request: REQUEST, now: NOW },
    { op: 'verify_request', request: null, directories: {}, now: NOW },
  ]) {
    const result = spawn(operation);
    assert.notEqual(result.status, 0, operation.op);
    assert.equal(result.stdout, '', operation.op);
  }
});
