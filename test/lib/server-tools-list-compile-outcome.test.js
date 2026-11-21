// tools/list lists a framework tool only when the release's request schema for
// it compiles, as getValidator decides. With ADCP_VALIDATOR_CACHE_DIR set, a
// schema that compiled is recorded under a key over the root's content, so a
// later listing on the same content compiles nothing, a changed document is
// compiled again, and request and response diagnostics are unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '../../dist/lib');
const VERSION = '3.4.0-beta.0';
const BASE = `https://adcontextprotocol.org/schemas/${VERSION}`;
const REF = `/schemas/${VERSION}`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

// A modular root (flat files, no bundled/ tree):
// - get_products' request and every response ref the whole core/context.json;
// - create_media_buy's request refs core/context.json#/properties/probe
//   directly, so compiling it gives that property its own diagnostic origin;
// - get_adcp_capabilities' request refs nothing;
// - update_media_buy has no request schema.
// Options each change one thing.
function writeRoot(root, { createMediaBuyRef = `${REF}/core/context.json#/properties/probe`, probe, extra } = {}) {
  writeJson(path.join(root, 'index.json'), { adcp_version: VERSION });
  writeJson(path.join(root, 'core', 'context.json'), {
    $id: `${BASE}/core/context.json`,
    type: 'object',
    properties: { probe: probe ?? { type: 'string' } },
  });
  const request = {
    'protocol/get-adcp-capabilities': { type: 'object' },
    'media-buy/get-products': { type: 'object', properties: { context: { $ref: `${REF}/core/context.json` } } },
    'media-buy/create-media-buy': { type: 'object', properties: { probe: { $ref: createMediaBuyRef } } },
  };
  for (const [file, schema] of Object.entries(request)) {
    writeJson(path.join(root, `${file}-request.json`), { $id: `${BASE}/${file}-request.json`, ...schema });
    writeJson(path.join(root, `${file}-response.json`), {
      $id: `${BASE}/${file}-response.json`,
      type: 'object',
      properties: { ctxdata: { $ref: `${REF}/core/context.json` } },
    });
  }
  for (const [file, value] of Object.entries(extra ?? {})) writeJson(path.join(root, file), value);
  return root;
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// In a fresh process: tools/list (unless LIST=0), then a get_products call
// with an invalid request, then one whose response is invalid. Counts the
// Ajv work the listing does: registrations of AdCP documents (every modular
// compile registers the root's documents first) and compiles.
const CHILD = `
const path = require('node:path');
const Ajv = require(require.resolve('ajv', { paths: [process.env.DIST] }));
let work = 0;
for (const name of ['addSchema', 'compile']) {
  const original = Ajv.prototype[name];
  Ajv.prototype[name] = function (schema, ...rest) {
    if (name === 'compile' || String(schema?.$id).startsWith('https://adcontextprotocol.org/')) work++;
    return original.call(this, schema, ...rest);
  };
}
const { createAdcpServer } = require(path.join(process.env.DIST, 'server/create-adcp-server'));
const { withExternalSchemaRoot } = require(path.join(process.env.DIST, 'validation/schema-loader'));
withExternalSchemaRoot(process.env.VERSION, process.env.ROOT, async () => {
  const server = createAdcpServer({
    name: 'Compile outcome seller',
    version: '1.0.0',
    adcpVersion: process.env.VERSION,
    validation: { requests: 'strict', responses: 'strict' },
    mediaBuy: process.env.ONLY_CREATE === '1'
      ? { createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }) }
      : {
          getProducts: async () => ({ products: [], ctxdata: { probe: 5 } }),
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
          updateMediaBuy: async () => ({ media_buy_id: 'mb1' }),
        },
  });
  let tools;
  let listWork;
  if (process.env.LIST !== '0') {
    const before = work;
    const listed = await server.dispatchTestRequest({ method: 'tools/list' });
    listWork = work - before;
    tools = listed.tools.map(tool => tool.name);
  }
  const call = name => args => server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } });
  const calls = process.env.ONLY_CREATE !== '1';
  const request = calls ? await call('get_products')({ context: { probe: 5 } }) : undefined;
  const response = calls ? await call('get_products')({}) : undefined;
  process.stdout.write(JSON.stringify({ tools, listWork, request, response }));
}).catch(error => {
  console.error(error);
  process.exit(1);
});
`;

// onlyCreate: a seller with create_media_buy alone, so its schema is the
// first the listing compiles.
function run(root, { cacheDir, list = true, onlyCreate = false } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DIST,
    VERSION,
    ROOT: root,
    LIST: list ? '1' : '0',
    ONLY_CREATE: onlyCreate ? '1' : '0',
  };
  delete env.ADCP_VALIDATOR_CACHE_DIR;
  if (cacheDir) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
  return JSON.parse(execFileSync(process.execPath, ['-e', CHILD], { env, encoding: 'utf8' }));
}

const ALL = ['get_products', 'create_media_buy', 'get_adcp_capabilities'];

test('a request schema that does not compile hides its tool, with the cache off, cold and warm', t => {
  const root = writeRoot(tempDir(t, 'adcp-compile-outcome-root-'), {
    createMediaBuyRef: `${REF}/core/missing.json`,
  });
  const cacheDir = tempDir(t, 'adcp-compile-outcome-cache-');
  const expected = ['get_products', 'get_adcp_capabilities'];
  assert.deepEqual(run(root).tools, expected, 'cache off');
  assert.deepEqual(run(root, { cacheDir }).tools, expected, 'cache cold');
  const warm = run(root, { cacheDir });
  assert.deepEqual(warm.tools, expected, 'cache warm');
  // Only compiles are recorded: the failing schema compiles in every process.
  assert.ok(warm.listWork > 0, 'a schema that failed is compiled again');
});

test('the record is keyed by root content: a byte copy hits, a changed document misses', t => {
  const cacheDir = tempDir(t, 'adcp-compile-outcome-cache-');
  const cold = run(writeRoot(tempDir(t, 'adcp-compile-outcome-root-')), { cacheDir });
  assert.deepEqual(cold.tools, ALL);
  assert.ok(cold.listWork > 0, 'a cold listing compiles');

  // The same bytes in another directory, with new inodes and mtimes.
  const copy = writeRoot(tempDir(t, 'adcp-compile-outcome-copy-'));
  const hit = run(copy, { cacheDir });
  assert.deepEqual(hit.tools, ALL);
  assert.equal(hit.listWork, 0, 'a byte-identical root is a hit');

  // Only core/context.json changes, which two tools ref.
  const changedRef = writeRoot(tempDir(t, 'adcp-compile-outcome-ref-'), {
    probe: { $ref: `${REF}/core/missing.json` },
  });
  const refMiss = run(changedRef, { cacheDir });
  assert.deepEqual(refMiss.tools, ['get_adcp_capabilities'], 'a changed referenced document');
  assert.deepEqual(refMiss.tools, run(changedRef).tools, 'as with the cache off');
  assert.ok(refMiss.listWork > 0);

  // Only a new document that no tool refs, and that Ajv rejects. Ajv keeps
  // the document it rejected, so the first compile fails and later ones pass:
  // get_products, listed first, is hidden.
  const unrelated = writeRoot(tempDir(t, 'adcp-compile-outcome-unrelated-'), {
    extra: { 'core/unrelated.json': { $id: `${BASE}/core/unrelated.json`, type: 12 } },
  });
  const unrelatedMiss = run(unrelated, { cacheDir });
  assert.deepEqual(unrelatedMiss.tools, ['create_media_buy', 'get_adcp_capabilities'], 'an invalid unrelated document');
  assert.deepEqual(unrelatedMiss.tools, run(unrelated).tools, 'as with the cache off');
  assert.ok(unrelatedMiss.listWork > 0);
  // Those outcomes depend on call order, so none is reused: a seller whose
  // first compile is create_media_buy's hides it, as with the cache off.
  const createFirst = run(unrelated, { cacheDir, onlyCreate: true });
  assert.deepEqual(createFirst.tools, run(unrelated, { onlyCreate: true }).tools);
  assert.deepEqual(createFirst.tools, ['get_adcp_capabilities']);

  // The original content again: still a hit.
  const back = run(writeRoot(tempDir(t, 'adcp-compile-outcome-again-')), { cacheDir });
  assert.deepEqual(back.tools, ALL);
  assert.equal(back.listWork, 0);
});

test('request and response diagnostics are the same with the cache off, cold and warm', t => {
  const root = writeRoot(tempDir(t, 'adcp-compile-outcome-root-'));
  const cacheDir = tempDir(t, 'adcp-compile-outcome-cache-');
  const off = run(root);
  const unlisted = run(root, { list: false });
  // The fixture is sensitive to what the listing compiled: without a listing,
  // create_media_buy's validator is never compiled, and /context/probe and
  // /ctxdata/probe resolve through a shorter diagnostic origin.
  assert.equal(off.request.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
  assert.equal(off.response.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
  assert.notDeepEqual(unlisted.request, off.request, 'the request fixture distinguishes the compile set');
  assert.notDeepEqual(unlisted.response, off.response, 'the response fixture distinguishes the compile set');

  const cold = run(root, { cacheDir });
  const warm = run(root, { cacheDir });
  assert.equal(warm.listWork, 0, 'the warm listing compiled nothing');
  for (const [label, result] of [
    ['cold', cold],
    ['warm', warm],
  ]) {
    assert.deepEqual(result.request, off.request, `request, cache ${label}`);
    assert.deepEqual(result.response, off.response, `response, cache ${label}`);
  }
  // Without a listing nothing was deferred, so nothing extra is compiled.
  const unlistedWarm = run(root, { cacheDir, list: false });
  assert.deepEqual(unlistedWarm.request, unlisted.request);
  assert.deepEqual(unlistedWarm.response, unlisted.response);
});
