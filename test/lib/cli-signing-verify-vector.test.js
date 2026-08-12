const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
const VECTOR_ROOT = path.resolve(__dirname, '../../compliance/cache/latest/test-vectors/request-signing');
const KEYS = path.join(VECTOR_ROOT, 'keys.json');

function verifyVectorPath(vectorPath) {
  return spawnSync(process.execPath, [CLI, 'signing', 'verify-vector', '--vector', vectorPath, '--keys', KEYS], {
    encoding: 'utf8',
    timeout: 45_000,
  });
}

function verifyVector(vector) {
  return verifyVectorPath(path.join(VECTOR_ROOT, vector));
}

function verifyReplayVectorWithUrl(url) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-signing-vector-'));
  try {
    const source = path.join(VECTOR_ROOT, 'negative/016-replayed-nonce.json');
    const vector = JSON.parse(readFileSync(source, 'utf8'));
    vector.request.url = url;
    const vectorPath = path.join(tmpDir, 'vector.json');
    writeFileSync(vectorPath, JSON.stringify(vector));
    return verifyVectorPath(vectorPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseOutput(result) {
  assert.ok(result.stdout, `expected JSON on stdout. stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('signing verify-vector accepts a positive request-signing vector', () => {
  const result = verifyVector('positive/001-basic-post.json');

  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.strictEqual(parseOutput(result).outcome, 'accepted');
});

test('signing verify-vector rejects a preloaded replay nonce', () => {
  const result = verifyVector('negative/016-replayed-nonce.json');

  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
  const output = parseOutput(result);
  assert.strictEqual(output.outcome, 'rejected');
  assert.strictEqual(output.error_code, 'request_signature_replayed');
});

test('signing verify-vector canonicalizes replay scope before preloading', () => {
  const result = verifyReplayVectorWithUrl('https://seller.example.com:443/adcp/create_media_buy');

  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
  assert.strictEqual(parseOutput(result).error_code, 'request_signature_replayed');
});

test('signing verify-vector formats replay-state URL errors as JSON', () => {
  const result = verifyReplayVectorWithUrl('https://user:pass@seller.example.com/adcp/create_media_buy');

  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
  const output = parseOutput(result);
  assert.strictEqual(output.outcome, 'rejected');
  assert.strictEqual(output.error_code, 'request_signature_header_malformed');
});
