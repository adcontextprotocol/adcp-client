// adcp-client#3529: the ESM build's envelope-status check must read the ESM
// schema loader's root registry. It used a lazy `require()`, which resolved the
// CommonJS loader even from the ESM build, so a root registered through the ESM
// loader looked unknown and a 3.2.x-style `decline_proposals` kept `status`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VERSION = '3.4.0-beta.0';
const dist = path.resolve(__dirname, '../../dist/lib');

// Minimal loader-isolation root: a closed decline_proposals response with no
// `status`, as 3.2.x publishes it. Not a replacement for a published bundle.
function writeRoot(root) {
  const domain = path.join(root, 'bundled', 'media-buy');
  fs.mkdirSync(domain, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: VERSION }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ tools: { decline_proposals: {} } }));
  const id = name => `https://adcontextprotocol.org/schemas/${VERSION}/media-buy/${name}`;
  fs.writeFileSync(
    path.join(domain, 'decline-proposals-request.json'),
    JSON.stringify({ $id: id('decline-proposals-request.json'), type: 'object' })
  );
  fs.writeFileSync(
    path.join(domain, 'decline-proposals-response.json'),
    JSON.stringify({
      $id: id('decline-proposals-response.json'),
      type: 'object',
      required: ['results'],
      properties: { results: { type: 'array' } },
      additionalProperties: false,
    })
  );
}

async function withRoot(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-envelope-esm-'));
  writeRoot(temp);
  try {
    return await fn(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const importDist = relative => import(pathToFileURL(path.join(dist, relative)).href);

test('ESM: a root registered through the ESM loader decides envelope status', async () => {
  const loader = await importDist('validation/schema-loader.mjs');
  const compat = await importDist('utils/envelope-status-compat.mjs');
  await withRoot(async root => {
    // Unknown before registration, and that answer must not be cached.
    assert.equal(compat.omitsEnvelopeStatusForRelease('decline_proposals', VERSION), false);
    loader.registerExternalSchemaRoot(VERSION, root);
    try {
      assert.equal(loader.responseSchemaComposesEnvelope('decline_proposals', VERSION), false);
      assert.equal(compat.omitsEnvelopeStatusForRelease('decline_proposals', VERSION), true);
    } finally {
      loader.unregisterExternalSchemaRoot(VERSION);
    }
  });
});

test('ESM: a scoped ESM root decides envelope status', async () => {
  const loader = await importDist('validation/schema-loader.mjs');
  const compat = await importDist('utils/envelope-status-compat.mjs');
  await withRoot(async root => {
    const omits = loader.withExternalSchemaRoot(VERSION, root, () =>
      compat.omitsEnvelopeStatusForRelease('decline_proposals', VERSION)
    );
    assert.equal(omits, true);
  });
});

test('CJS: a root registered through the CommonJS loader decides envelope status', async () => {
  const loader = require('../../dist/lib/validation/schema-loader.js');
  const compat = require('../../dist/lib/utils/envelope-status-compat.js');
  await withRoot(async root => {
    loader.registerExternalSchemaRoot(VERSION, root);
    try {
      assert.equal(compat.omitsEnvelopeStatusForRelease('decline_proposals', VERSION), true);
    } finally {
      loader.unregisterExternalSchemaRoot(VERSION);
    }
  });
});
