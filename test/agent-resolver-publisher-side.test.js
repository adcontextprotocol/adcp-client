/**
 * Publisher-side smoke: a seller's `get_adcp_capabilities` response that
 * includes `identity.brand_json_url` MUST pass the SDK's own validation
 * gate against the 3.0.5 schema bundle. This is the spec's forward-compat
 * narrative made verifiable: 3.0-pinned operators can adopt the field
 * today without waiting for 3.1, because 3.0.5 relaxed
 * `identity.additionalProperties` to `true` (cherry-picked from spec PR
 * adcontextprotocol/adcp#3690).
 *
 * Goes through `validateResponse` rather than rolling a fresh ajv, so:
 *   - We test the same code path production callers (`createAdcpServer`'s
 *     response-validation gate) go through.
 *   - `$ref`s resolve via the SDK's bundled schema-loader; ref-target
 *     regressions surface here instead of getting masked by a
 *     test-local stub.
 *
 * On 3.0.4 and earlier, this same payload would have been rejected by the
 * closed-property `identity` validator. The test fails-loud if a future
 * schema regression closes that door again.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateResponse } = require('../dist/lib/validation/schema-validator');

const minBase = () => ({
  adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
  supported_protocols: ['media_buy'],
});

describe('publisher-side: identity.brand_json_url on 3.0.5', () => {
  it('accepts identity.brand_json_url alongside the existing closed property list', () => {
    const result = validateResponse('get_adcp_capabilities', {
      ...minBase(),
      identity: {
        per_principal_key_isolation: true,
        key_origins: { request_signing: 'https://keys.scope3.com' },
        brand_json_url: 'https://scope3.com/.well-known/brand.json',
      },
    });
    if (!result.valid) {
      // Surface the first issue so a future regression names exactly which
      // validator clamped down on the forward-compat field.
      assert.fail(`schema rejected forward-compat field: ${JSON.stringify(result.issues?.[0])}`);
    }
  });

  it('still passes when identity is empty (semantic-neutral block)', () => {
    const result = validateResponse('get_adcp_capabilities', { ...minBase(), identity: {} });
    assert.ok(result.valid, JSON.stringify(result.issues));
  });

  it('still passes without identity at all', () => {
    const result = validateResponse('get_adcp_capabilities', minBase());
    assert.ok(result.valid, JSON.stringify(result.issues));
  });
});
