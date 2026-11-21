// Error-arm descriptors are schema reads, so they belong to the responses that
// need them: building a server reads no schema document, and a response reads
// a tool's response schema only when it carries an error layer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withExternalSchemaRoot, unregisterExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { adcpError } = require('../../dist/lib/server/errors');

const VERSION = '3.4.0-beta.0';
const WIRE = '3.4-beta.0';

function errorArmResponse(id, status) {
  return {
    $id: id,
    oneOf: [
      {
        type: 'object',
        required: ['status', 'errors'],
        properties: {
          status: { const: status },
          errors: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['code', 'message'],
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } },
            },
          },
        },
      },
      { type: 'object', required: ['status'], properties: { status: { const: 'completed' } } },
    ],
  };
}

// A raw bundled root (one JSON file per schema) with two dispatchable tools
// whose responses both declare an Error arm, so file reads show which tool's
// schema a response consulted.
function writeRoot(root) {
  const domain = path.join(root, 'bundled', 'media-buy');
  fs.mkdirSync(domain, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: VERSION }));
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ tools: { control_media_buy: {}, update_media_buy: {} } })
  );
  for (const [tool, status] of [
    ['control-media-buy', 'failed'],
    ['update-media-buy', 'rejected'],
  ]) {
    const base = `https://adcontextprotocol.org/schemas/${VERSION}/media-buy/${tool}`;
    fs.writeFileSync(
      path.join(domain, `${tool}-request.json`),
      JSON.stringify({ $id: `${base}-request.json`, type: 'object' })
    );
    fs.writeFileSync(
      path.join(domain, `${tool}-response.json`),
      JSON.stringify(errorArmResponse(`${base}-response.json`, status))
    );
  }
}

async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-error-arm-lazy-'));
  writeRoot(root);
  try {
    return await withExternalSchemaRoot(VERSION, root, () => fn(root));
  } finally {
    unregisterExternalSchemaRoot(VERSION);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Records every path under `root` that the SDK reads or lists while `fn` runs.
// The CommonJS build reads fs functions by property at call time.
async function readsUnder(root, fn) {
  const seen = [];
  const original = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const record = p => {
    const file = String(p);
    if (file.startsWith(root)) seen.push(path.relative(root, file) || '.');
  };
  fs.readFileSync = function (p, ...rest) {
    record(p);
    return original.readFileSync.call(this, p, ...rest);
  };
  fs.readdirSync = function (p, ...rest) {
    record(p);
    return original.readdirSync.call(this, p, ...rest);
  };
  try {
    await fn();
  } finally {
    Object.assign(fs, original);
  }
  return seen;
}

function server() {
  return createAdcpServer({
    name: 'Lazy error-arm seller',
    version: '1.0.0',
    adcpVersion: VERSION,
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: {
      controlMediaBuy: async () => adcpError('ACTION_NOT_ALLOWED', { message: 'Paused by policy' }),
      updateMediaBuy: async () => adcpError('ACTION_NOT_ALLOWED', { message: 'Locked' }),
    },
  });
}

test('building a server reads no schema document of the active root', () =>
  withRoot(async root => {
    const reads = await readsUnder(root, () => {
      server();
    });
    assert.deepEqual(reads, []);
  }));

async function call(srv, name, args = {}) {
  return srv.dispatchTestRequest(
    { method: 'tools/call', params: { name, arguments: { adcp_version: WIRE, media_buy_id: 'mb1', ...args } } },
    { authInfo: { credential: { kind: 'api_key', key_id: 'lazy-error-arm-test' } } }
  );
}

const responseReads = reads => reads.filter(file => file.endsWith('-response.json'));

test('a success response reads no response schema', () =>
  withRoot(async root => {
    const srv = createAdcpServer({
      name: 'Lazy error-arm seller',
      version: '1.0.0',
      adcpVersion: VERSION,
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { updateMediaBuy: async () => ({ media_buy_id: 'mb1', status: 'completed' }) },
    });
    const reads = await readsUnder(root, async () => {
      const response = await call(srv, 'update_media_buy');
      assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    });
    assert.deepEqual(responseReads(reads), []);
  }));

test("a failing call reads only its own tool's response schema, once", () =>
  withRoot(async root => {
    const srv = server();
    const reads = await readsUnder(root, async () => {
      for (let i = 0; i < 2; i++) {
        const response = await call(srv, 'control_media_buy', { action: 'pause' });
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent.errors[0].code, 'ACTION_NOT_ALLOWED');
        assert.equal(response.structuredContent.status, 'failed', 'the Error arm discriminator is applied');
      }
    });
    assert.deepEqual(responseReads(reads), ['bundled/media-buy/control-media-buy-response.json']);
  }));

test('per-tool descriptors equal the full-inventory scan for every packaged bundle', () => {
  const { getErrorArmDescriptor } = require('../../dist/lib/server/error-arm-tools');
  const expected = require('../fixtures/error-arm-descriptors.json');
  const dataRoot = path.join(__dirname, '../../dist/lib/schemas-data');
  for (const [version, descriptors] of Object.entries(expected)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, version, 'manifest.json'), 'utf8'));
    for (const tool of Object.keys(manifest.tools)) {
      const actual = getErrorArmDescriptor(tool, version);
      if (tool in descriptors) assert.deepEqual(actual?.extraRequired, descriptors[tool], `${version} ${tool}`);
      else assert.equal(actual, undefined, `${version} ${tool} has no Error arm`);
    }
  }
});
