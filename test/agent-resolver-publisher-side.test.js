/**
 * Publisher-side smoke: a seller's `get_adcp_capabilities` response that
 * includes `identity.brand_json_url` MUST pass validation against the
 * 3.0.5 schema. This is the spec's forward-compat narrative made
 * verifiable: 3.0-pinned operators can adopt the field today without
 * waiting for 3.1, because 3.0.5 relaxed `identity.additionalProperties`
 * to `true` (cherry-picked from spec PR adcontextprotocol/adcp#3690).
 *
 * On 3.0.4 and earlier, this same payload would have been rejected by
 * the closed-property `identity` validator. The test fails-loud if a
 * future schema regression closes that door again.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const { readFileSync } = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(
  __dirname,
  '..',
  'schemas',
  'cache',
  '3.0.5',
  'protocol',
  'get-adcp-capabilities-response.json'
);

describe('publisher-side: identity.brand_json_url on 3.0.5', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  // Strip $id so ajv treats this as an inline schema rather than trying
  // to register the URI; the cached schema's $ref pointers resolve relative
  // to the bundled tree which we don't carry into this test.
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  addFormats(ajv);
  // Replace external $refs with permissive `true` schemas — we only care
  // that the top-level shape (and identity in particular) accepts the field.
  inlineRefsAsTrue(schema);
  const validate = ajv.compile(schema);

  const minBase = () => ({
    adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
    supported_protocols: ['media_buy'],
  });

  it('accepts identity.brand_json_url alongside the existing closed property list', () => {
    const ok = validate({
      ...minBase(),
      identity: {
        per_principal_key_isolation: true,
        key_origins: { request_signing: 'https://keys.scope3.com' },
        brand_json_url: 'https://scope3.com/.well-known/brand.json',
      },
    });
    if (!ok) {
      // Surface the first error so a future regression names exactly which
      // validator clamped down.
      assert.fail(`schema rejected forward-compat field: ${JSON.stringify(validate.errors?.[0])}`);
    }
  });

  it('still passes when identity is empty (semantic-neutral block)', () => {
    const ok = validate({ ...minBase(), identity: {} });
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('still passes without identity at all', () => {
    const ok = validate(minBase());
    assert.ok(ok, JSON.stringify(validate.errors));
  });
});

function inlineRefsAsTrue(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(inlineRefsAsTrue);
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === '$ref' && typeof node[k] === 'string') {
      delete node.$ref;
      // Replace this object with `true` semantics — drop other constraints.
      for (const sib of Object.keys(node)) delete node[sib];
      Object.assign(node, { not: { not: {} } });
      return;
    }
    inlineRefsAsTrue(node[k]);
  }
}
