const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const { buildCommunityMirrorAdagents } = require('../../dist/lib/registry/index.js');
const { resolveBundleKey } = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const SCHEMA_ROOT = path.resolve(__dirname, '..', '..', 'dist', 'lib', 'schemas-data', resolveBundleKey(ADCP_VERSION));
const LEGACY_SCHEMA_ROOT = path.resolve(__dirname, '..', '..', 'dist', 'lib', 'schemas-data', 'v2.5');

function walkJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function loadAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const addedIds = new Set();

  for (const file of walkJsonFiles(SCHEMA_ROOT)) {
    const rel = path.relative(SCHEMA_ROOT, file);
    const top = rel.split(path.sep)[0];
    if (top === 'bundled') continue;

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Avoid ajv.getSchema() during registration: it can eagerly compile refs
    // before later sibling schema directories have been added.
    if (typeof raw.$id === 'string' && !addedIds.has(raw.$id)) {
      ajv.addSchema(raw);
      addedIds.add(raw.$id);
    }
  }

  return ajv;
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .slice(0, 8)
    .map(e => `path=${e.instancePath || '(root)'} keyword=${e.keyword} msg=${e.message}`)
    .join('\n');
}

describe('packaged adagents.json schema', () => {
  test('relaxes authorized_agents only for catalog-capable schema bundles', () => {
    const current = JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'adagents.json'), 'utf8'));
    const currentInline = current.oneOf.find(variant => variant?.properties?.authorized_agents);
    assert.strictEqual(currentInline.properties.authorized_agents.minItems, undefined);
    assert.ok(currentInline.properties.catalog_etag, 'current schema must expose catalog_etag');
    assert.ok(currentInline.properties.formats, 'current schema must expose formats');

    if (fs.existsSync(path.join(LEGACY_SCHEMA_ROOT, 'adagents.json'))) {
      const legacy = JSON.parse(fs.readFileSync(path.join(LEGACY_SCHEMA_ROOT, 'adagents.json'), 'utf8'));
      const legacyInline = legacy.oneOf.find(variant => variant?.properties?.authorized_agents);
      assert.strictEqual(legacyInline.properties.authorized_agents.minItems, 1);
      assert.strictEqual(legacyInline.properties.catalog_etag, undefined);
      assert.strictEqual(legacyInline.properties.formats, undefined);
    }
  });

  test('accepts catalog-only community mirrors with no authorized sellers yet', () => {
    const adagentsPath = path.join(SCHEMA_ROOT, 'adagents.json');
    const schema = JSON.parse(fs.readFileSync(adagentsPath, 'utf8'));
    const ajv = loadAjv();
    const validate = (typeof schema.$id === 'string' && ajv.getSchema(schema.$id)) || ajv.compile(schema);

    const catalog = buildCommunityMirrorAdagents({
      catalog_etag: 'meta-creative-formats-2026-05',
      formats: [
        {
          format_option_id: 'meta-feed-image',
          format_kind: 'image',
          params: {
            width: 1080,
            height: 1080,
          },
          v1_format_ref: [
            {
              agent_url: 'https://creative.adcontextprotocol.org/translated/meta',
              id: 'feed_image',
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(catalog.authorized_agents, []);
    assert.ok(
      validate(catalog),
      `community mirror helper output must validate against packaged adagents.json schema:\n${formatAjvErrors(validate.errors)}`
    );
  });
});
