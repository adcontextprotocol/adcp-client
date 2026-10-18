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

function run(operation) {
  const result = spawnSync(process.execPath, [ADAPTER], { input: JSON.stringify(operation), encoding: 'utf8' });
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
  assert.deepEqual(pick(run({ op: 'unknown' })), { ok: false, status: 0, rule: 'Error' });
});
