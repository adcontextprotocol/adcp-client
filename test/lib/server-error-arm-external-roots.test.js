const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brotliCompressSync } = require('node:zlib');
const {
  withExternalSchemaRoot,
  registerExternalSchemaRoot,
  unregisterExternalSchemaRoot,
  getValidator,
} = require('../../dist/lib/validation/schema-loader');
const { getToolsWithErrorArm } = require('../../dist/lib/server/error-arm-tools');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { adcpError } = require('../../dist/lib/server/errors');

const VERSION = '3.3.0-beta.0';
const WIRE = '3.3-beta.0';

// Minimal loader-isolation schemas, with a discriminator that distinguishes
// two independently supplied roots for the same release. These are not a
// replacement for a published AdCP bundle.
function writeRoot(root, { bundled = true, status = 'failed', version = VERSION } = {}) {
  const domain = path.join(root, ...(bundled ? ['bundled'] : []), 'media-buy');
  fs.mkdirSync(domain, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: version }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ tools: { control_media_buy: {} } }));
  fs.writeFileSync(
    path.join(domain, 'control-media-buy-request.json'),
    JSON.stringify({
      $id: `https://adcontextprotocol.org/schemas/${version}/media-buy/control-media-buy-request.json`,
      type: 'object',
    })
  );
  const response = {
    $id: `https://adcontextprotocol.org/schemas/${version}/media-buy/control-media-buy-response.json`,
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
        additionalProperties: false,
      },
      { type: 'object', required: ['status'], properties: { status: { const: 'completed' } } },
    ],
  };
  fs.writeFileSync(path.join(domain, 'control-media-buy-response.json'), JSON.stringify(response));
  // Non-tool helper schemas must remain outside the dispatch inventory.
  fs.writeFileSync(
    path.join(domain, 'helper-response.json'),
    JSON.stringify({ ...response, $id: response.$id.replace('control-media-buy', 'helper') })
  );
}

function writeCompressedRoot(root, options) {
  writeRoot(root, options);
  const bundledRoot = path.join(root, 'bundled');
  const schemas = Object.fromEntries(
    fs
      .readdirSync(bundledRoot, { recursive: true })
      .flatMap(relative =>
        relative.endsWith('.json')
          ? [
              [
                relative.split(path.sep).join('/'),
                JSON.parse(fs.readFileSync(path.join(bundledRoot, relative), 'utf8')),
              ],
            ]
          : []
      )
  );
  fs.writeFileSync(path.join(root, 'bundled.schemas.br'), brotliCompressSync(Buffer.from(JSON.stringify(schemas))));
  fs.rmSync(bundledRoot, { recursive: true });
  fs.mkdirSync(bundledRoot);
}

async function withRoots(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-error-arm-roots-'));
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  writeRoot(a);
  writeRoot(b, { status: 'other-root-failure' });
  try {
    return await fn(a, b);
  } finally {
    unregisterExternalSchemaRoot(VERSION);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function status() {
  const map = getToolsWithErrorArm(WIRE);
  assert.equal(map.size, 1, 'only manifest-declared control_media_buy is dispatchable');
  return map.get('control_media_buy').extraRequired.status;
}

test('error-arm lookup observes registration after a missing lookup and restores after unregister', () =>
  withRoots(a => {
    assert.equal(getToolsWithErrorArm(WIRE).size, 0);
    registerExternalSchemaRoot(VERSION, a);
    assert.equal(status(), 'failed');
    const original = getToolsWithErrorArm(WIRE);
    assert.strictEqual(getToolsWithErrorArm(WIRE), original, 'reuse the inventory within the active loader epoch');
    writeRoot(a, { status: 'replaced-without-unregister' });
    registerExternalSchemaRoot(VERSION, a);
    assert.notStrictEqual(getToolsWithErrorArm(WIRE), original, 're-registering the same path starts a fresh epoch');
    assert.equal(status(), 'replaced-without-unregister');
    unregisterExternalSchemaRoot(VERSION);
    assert.equal(getToolsWithErrorArm(WIRE).size, 0);
    writeRoot(a, { status: 'replaced-at-same-path' });
    registerExternalSchemaRoot(VERSION, a);
    assert.equal(status(), 'replaced-at-same-path', 'an earlier external map must not survive re-registration');
  }));

test('nested and parallel external roots with the same version do not leak descriptors', () =>
  withRoots(async (a, b) => {
    await withExternalSchemaRoot(VERSION, a, async () => {
      assert.equal(status(), 'failed');
      assert.strictEqual(getToolsWithErrorArm(WIRE), getToolsWithErrorArm(WIRE), 'reuse the active scope inventory');
      withExternalSchemaRoot(VERSION, b, () => assert.equal(status(), 'other-root-failure'));
      assert.equal(status(), 'failed', 'exiting nested scope restores the parent');
      await Promise.all([
        withExternalSchemaRoot(VERSION, a, async () => {
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(status(), 'failed');
        }),
        withExternalSchemaRoot(VERSION, b, async () => {
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(status(), 'other-root-failure');
        }),
      ]);
    });
    assert.equal(getToolsWithErrorArm(WIRE).size, 0, 'exiting all scopes leaves no candidate inventory');
  }));

for (const scoped of [false, true]) {
  test(`compressed same-path replacement refreshes ${scoped ? 'scoped' : 'registered'} descriptors and validators`, () =>
    withRoots(a => {
      const observe = expected => {
        assert.equal(status(), expected);
        const validate = getValidator('control_media_buy', 'sync', WIRE);
        const errors = [{ code: 'ACTION_NOT_ALLOWED', message: 'Unavailable' }];
        assert.equal(validate({ status: expected, errors }), true, JSON.stringify(validate.errors));
        assert.equal(validate({ status: expected === 'failed' ? 'replacement' : 'failed', errors }), false);
      };
      const install = expected => {
        if (scoped) return withExternalSchemaRoot(VERSION, a, () => observe(expected));
        registerExternalSchemaRoot(VERSION, a);
        observe(expected);
      };
      writeCompressedRoot(a);
      install('failed');
      writeCompressedRoot(a, { status: 'replacement' });
      install('replacement');
      writeCompressedRoot(a, { version: '3.2.5' });
      assert.throws(
        () => (scoped ? withExternalSchemaRoot(VERSION, a, () => {}) : registerExternalSchemaRoot(VERSION, a)),
        /does not match/,
        'replacement provenance must be checked against the new archive contents'
      );
    }));
}

test('raw external roots use the loader response index when no bundled store exists', () =>
  withRoots(a => {
    fs.rmSync(path.join(a, 'bundled'), { recursive: true });
    writeRoot(a, { bundled: false });
    withExternalSchemaRoot(VERSION, a, () => assert.equal(status(), 'failed'));
  }));

test('external error-arm discovery retains schema-root version provenance checks', () =>
  withRoots(a => {
    assert.throws(() => withExternalSchemaRoot('3.2', a, () => getToolsWithErrorArm('3.2')), /does not match/);
    assert.throws(() => registerExternalSchemaRoot('3.2', a), /does not match/);
    assert.equal(getToolsWithErrorArm(WIRE).size, 0);
  }));

test('strict 3.3 server mirrors error details and required Error-arm discriminator from the active root', () =>
  withRoots(a =>
    withExternalSchemaRoot(VERSION, a, async () => {
      const server = createAdcpServer({
        name: 'Candidate error seller',
        version: '1.0.0',
        adcpVersion: VERSION,
        validation: { requests: 'strict', responses: 'strict' },
        mediaBuy: {
          controlMediaBuy: async () =>
            adcpError('ACTION_NOT_ALLOWED', {
              message: 'The requested increase has an unresolved condition',
              details: { reason: 'condition_unresolved', condition_id: 'review-required' },
            }),
        },
      });
      const response = await server.dispatchTestRequest(
        {
          method: 'tools/call',
          params: {
            name: 'control_media_buy',
            arguments: { adcp_version: WIRE, media_buy_id: 'mb1', action: 'pause' },
          },
        },
        { authInfo: { credential: { kind: 'api_key', key_id: 'candidate-error-test' } } }
      );
      const payload = response.structuredContent;
      assert.equal(response.isError, true);
      assert.equal(payload.adcp_version, WIRE);
      assert.equal(payload.adcp_error.code, 'ACTION_NOT_ALLOWED');
      assert.equal(payload.status, 'failed');
      assert.equal(payload.errors[0].code, 'ACTION_NOT_ALLOWED');
      assert.deepEqual(payload.errors[0].details, payload.adcp_error.details);
      assert.equal(payload.errors[0].details.reason, 'condition_unresolved');
      const validate = getValidator('control_media_buy', 'sync', VERSION);
      assert.equal(validate(payload), true, JSON.stringify(validate.errors));
      assert.deepEqual(JSON.parse(response.content[0].text).errors, payload.errors);
    })
  ));
