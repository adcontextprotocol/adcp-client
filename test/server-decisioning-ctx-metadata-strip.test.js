// Sanity test for #1343 — ctx_metadata wire-strip behavior.
//
// The framework strips `ctx_metadata` from wire responses; this test
// asserts that contract holds for the canonical surfaces (Account
// projection, list_accounts wire path). Adopters reading
// `docs/guides/CTX-METADATA-SAFETY.md` can copy this pattern to verify
// their own platforms don't accidentally spread `ctx_metadata` into a
// response shape.
//
// This is not a redaction test — `ctx_metadata` is stripped, not redacted.
// The doc warns that adopter-generated strings (`JSON.stringify(account)`
// in error messages, info-level logs that serialize the whole object)
// can still leak. Only re-derive-per-request avoids those vectors.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { toWireAccount } = require('../dist/lib/server/decisioning/account');

describe('#1343 — ctx_metadata wire-strip sanity', () => {
  it('toWireAccount strips ctx_metadata before emit', () => {
    const account = {
      id: 'acc_1',
      name: 'Acme',
      status: 'active',
      ctx_metadata: {
        upstreamId: 'snap_act_42',
        // Intentional anti-pattern — see CTX-METADATA-SAFETY.md. The strip
        // protects this from the wire, but adopter-generated error
        // messages / info logs that serialize the account would still
        // leak it. Re-derive per request instead.
        accessToken: 'PLAINTEXT_BEARER_THAT_MUST_NOT_REACH_WIRE',
      },
    };
    const wire = toWireAccount(account);
    const serialized = JSON.stringify(wire);
    assert.ok(
      !serialized.includes('PLAINTEXT_BEARER_THAT_MUST_NOT_REACH_WIRE'),
      `wire response leaked ctx_metadata: ${serialized}`
    );
    assert.ok(!('ctx_metadata' in wire), `wire should not carry the ctx_metadata key at all: ${serialized}`);
    // Wire-required fields are preserved.
    assert.strictEqual(wire.account_id, 'acc_1');
    assert.strictEqual(wire.name, 'Acme');
    assert.strictEqual(wire.status, 'active');
  });

  it('toWireAccount strips authInfo before emit (companion contract)', () => {
    // authInfo is the framework's canonical credential location (vs
    // ctx_metadata.accessToken — see the guide). It's also strip-on-wire.
    const account = {
      id: 'acc_1',
      name: 'Acme',
      status: 'active',
      ctx_metadata: { upstreamId: 'snap_act_42' },
      authInfo: {
        kind: 'oauth',
        token: 'PLAINTEXT_AUTH_TOKEN_MUST_NOT_REACH_WIRE',
        principal: 'p1',
      },
    };
    const wire = toWireAccount(account);
    const serialized = JSON.stringify(wire);
    assert.ok(!serialized.includes('PLAINTEXT_AUTH_TOKEN_MUST_NOT_REACH_WIRE'));
    assert.ok(!('authInfo' in wire));
  });

  it('preserves non-secret wire-shaped fields through the projection', () => {
    const account = {
      id: 'acc_1',
      name: 'Acme c/o Pinnacle',
      status: 'active',
      brand: { domain: 'acme.com' },
      operator: 'pinnacle.com',
      advertiser: 'acme.com',
      account_scope: 'operator_brand',
      ctx_metadata: { internal_only: true },
    };
    const wire = toWireAccount(account);
    assert.strictEqual(wire.account_id, 'acc_1');
    assert.strictEqual(wire.name, 'Acme c/o Pinnacle');
    assert.deepStrictEqual(wire.brand, { domain: 'acme.com' });
    assert.strictEqual(wire.operator, 'pinnacle.com');
    assert.strictEqual(wire.advertiser, 'acme.com');
    assert.strictEqual(wire.account_scope, 'operator_brand');
    assert.ok(!('ctx_metadata' in wire));
  });
});
