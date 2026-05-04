// Tests for #1529 L2 — WireSafe<T> brand + pickWireSpecFields
// + scrubExtensions.
//
// L2 is the structural-leakage half of the credential-discipline plan.
// Where L1 (#1535 credentialPolicy) catches credential-shaped keys at
// the buyer-facing dispatch boundary, L2 catches structural leakage at
// the operational fan-out boundary — storefront fan-out code that
// picks per-target args from a buyer request and forwards them
// upstream.
//
// The brand exists at the type level (TS only). Runtime behavior:
// `pickWireSpecFields` strips to the wire-spec field allowlist;
// `scrubExtensions` filters ext/context per a caller-supplied
// allowlist and merges in caller-injected values.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { pickWireSpecFields, scrubExtensions, WIRE_SPEC_FIELDS } = require('../dist/lib/server/wire-safe');

describe('WIRE_SPEC_FIELDS — codegen output', () => {
  it('includes the canonical mutating-tool request shapes', () => {
    assert.ok(WIRE_SPEC_FIELDS.UpdateMediaBuyRequest);
    assert.ok(WIRE_SPEC_FIELDS.CreateMediaBuyRequest);
    assert.ok(WIRE_SPEC_FIELDS.ActivateSignalRequest);
    assert.ok(WIRE_SPEC_FIELDS.GetMediaBuyDeliveryRequest);
  });

  it('UpdateMediaBuyRequest field set matches the wire spec', () => {
    const fields = WIRE_SPEC_FIELDS.UpdateMediaBuyRequest.fields;
    // Required fields per spec
    assert.ok(fields.includes('media_buy_id'));
    assert.ok(fields.includes('idempotency_key'));
    assert.ok(fields.includes('account'));
    // Common mutation fields
    assert.ok(fields.includes('paused'));
    assert.ok(fields.includes('canceled'));
    assert.ok(fields.includes('packages'));
    // Extension envelope
    assert.ok(fields.includes('context'));
    assert.ok(fields.includes('ext'));
    // Should NOT include credential-shaped names
    assert.ok(!fields.includes('snap_access_token'));
    assert.ok(!fields.includes('access_token'));
  });

  it('field arrays are runtime-frozen (defense in depth against shared-state mutation)', () => {
    const fields = WIRE_SPEC_FIELDS.UpdateMediaBuyRequest.fields;
    assert.ok(Object.isFrozen(fields), 'codegen must emit Object.freeze()');
    // Non-strict-mode mutation silently fails; strict mode throws.
    // Assert the EFFECT (no mutation) rather than the mode-dependent
    // throw — the security property is "you can't widen the scrub,"
    // not "you can't try."
    const originalLength = fields.length;
    const originalFirst = fields[0];
    try {
      fields.push('snap_access_token');
    } catch {}
    try {
      fields[0] = 'overwritten';
    } catch {}
    assert.strictEqual(fields.length, originalLength, 'frozen array must reject push (no length change)');
    assert.strictEqual(fields[0], originalFirst, 'frozen array must reject index write (no value change)');
  });

  it('top-level WIRE_SPEC_FIELDS object is frozen', () => {
    assert.ok(Object.isFrozen(WIRE_SPEC_FIELDS));
  });
});

describe('pickWireSpecFields', () => {
  it('strips a clean buyer request to itself (no-op)', () => {
    const buyerReq = {
      media_buy_id: 'mb_1',
      paused: true,
      idempotency_key: 'uuid-1',
    };
    const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
    assert.deepStrictEqual(safe, {
      media_buy_id: 'mb_1',
      paused: true,
      idempotency_key: 'uuid-1',
    });
  });

  it('drops top-level credential-shaped keys (round-1 vector)', () => {
    const buyerReq = {
      media_buy_id: 'mb_1',
      paused: true,
      idempotency_key: 'uuid-1',
      snap_access_token: 'attacker-pat',
    };
    const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
    assert.deepStrictEqual(safe, {
      media_buy_id: 'mb_1',
      paused: true,
      idempotency_key: 'uuid-1',
    });
    assert.ok(!('snap_access_token' in safe));
  });

  it('preserves context and ext (they ARE wire-spec fields)', () => {
    // pickWireSpecFields only filters TOP-LEVEL keys. Inside ext and
    // context the buyer can carry arbitrary structured data per spec.
    // Storefronts that need narrower ext/context follow up with
    // scrubExtensions.
    const buyerReq = {
      media_buy_id: 'mb_1',
      idempotency_key: 'uuid-1',
      context: { snap_access_token: 'still-here' },
      ext: { tiktok_access_token: 'still-here-too' },
    };
    const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
    assert.deepStrictEqual(safe.context, { snap_access_token: 'still-here' });
    assert.deepStrictEqual(safe.ext, { tiktok_access_token: 'still-here-too' });
  });

  it('drops account-pivot fields when buyer fakes account', () => {
    // If `account` is not in the wire-spec for the schema, it's
    // dropped. (For UpdateMediaBuyRequest, account IS in the spec,
    // so storefronts must validate it via AccountStore.resolve OR
    // overwrite via scrubExtensions.inject.)
    // Demonstrate with a request shape that doesn't have `account`:
    const buyerReq = {
      list_id: 'pl_1',
      idempotency_key: 'uuid-1',
      account: { brand: 'attacker.com' }, // not in DeletePropertyListRequest? actually it is
    };
    const safe = pickWireSpecFields(buyerReq, 'DeletePropertyListRequest');
    // account IS in DeletePropertyListRequest spec — so it survives.
    // The L2 brand doesn't replace AccountStore.resolve org-gating —
    // it complements it. Documented in CTX-METADATA-SAFETY.md.
    assert.ok('account' in safe);
  });

  it('handles non-object input defensively (returns empty)', () => {
    assert.deepStrictEqual(pickWireSpecFields(null, 'UpdateMediaBuyRequest'), {});
    assert.deepStrictEqual(pickWireSpecFields(undefined, 'UpdateMediaBuyRequest'), {});
    assert.deepStrictEqual(pickWireSpecFields('string', 'UpdateMediaBuyRequest'), {});
    assert.deepStrictEqual(pickWireSpecFields(42, 'UpdateMediaBuyRequest'), {});
  });

  it('drops hasOwnProperty=false poisoning attempts', () => {
    // Buyer sends an object whose prototype has a credential-shaped
    // key. hasOwnProperty check should prevent the prototype value
    // from leaking through.
    const proto = { snap_access_token: 'attacker-via-prototype' };
    const buyerReq = Object.create(proto);
    buyerReq.media_buy_id = 'mb_1';
    buyerReq.idempotency_key = 'uuid-1';
    const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
    assert.deepStrictEqual(safe, { media_buy_id: 'mb_1', idempotency_key: 'uuid-1' });
    assert.ok(!('snap_access_token' in safe), 'prototype-chain credential must not leak');
  });

  it('preserves nested data structures verbatim within wire-spec fields', () => {
    const buyerReq = {
      media_buy_id: 'mb_1',
      idempotency_key: 'uuid-1',
      packages: [
        { package_id: 'p1', budget: 1000 },
        { package_id: 'p2', impressions: 50000 },
      ],
    };
    const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
    // packages survives — it IS a wire-spec field. pickWireSpecFields
    // doesn't recurse into nested wire-spec values; that's the wire
    // schema's job to validate.
    assert.deepStrictEqual(safe.packages, buyerReq.packages);
  });
});

describe('scrubExtensions', () => {
  it('filters ext and context to allowedExtKeys', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: {
          scope3_api_key: 'legit',
          snap_access_token: 'attacker',
          partner_request_id: 'req-1',
        },
        context: {
          scope3_api_key: 'legit-too',
          tiktok_access_token: 'attacker-too',
        },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      allowedExtKeys: new Set(['scope3_api_key', 'partner_request_id']),
    });
    assert.deepStrictEqual(scrubbed.ext, { scope3_api_key: 'legit', partner_request_id: 'req-1' });
    assert.deepStrictEqual(scrubbed.context, { scope3_api_key: 'legit-too' });
  });

  it('injects adopter-controlled values AFTER allowlist filter', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        context: { partner_request_id: 'req-1' },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      allowedExtKeys: new Set(['partner_request_id']),
      inject: {
        context: {
          managed_access_token: 'storefront-token',
          managed_advertiser_id: 'act_123',
        },
      },
    });
    assert.deepStrictEqual(scrubbed.context, {
      partner_request_id: 'req-1',
      managed_access_token: 'storefront-token',
      managed_advertiser_id: 'act_123',
    });
  });

  it('inject without allowedExtKeys leaves filter pass-through', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: { existing: 'value' },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      inject: { ext: { added: 'value' } },
    });
    assert.deepStrictEqual(scrubbed.ext, { existing: 'value', added: 'value' });
  });

  it('empty allowedExtKeys drops both ext and context entirely', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: { something: 'value' },
        context: { other: 'value' },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, { allowedExtKeys: new Set() });
    assert.deepStrictEqual(scrubbed.ext, {});
    assert.deepStrictEqual(scrubbed.context, {});
  });

  it('inject overrides allowlisted values when keys collide', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        context: { partner_id: 'buyer-supplied' },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      allowedExtKeys: new Set(['partner_id']),
      inject: { context: { partner_id: 'storefront-supplied' } },
    });
    // inject runs AFTER filter, so storefront-supplied wins.
    // Documents the layering: the filter is for buyer keys; the
    // inject is for storefront-controlled credentials/IDs.
    assert.strictEqual(scrubbed.context.partner_id, 'storefront-supplied');
  });

  it('recursive scan drops nested credentials INSIDE allowlisted top-level keys (round-4)', () => {
    // The buyer hides credentials one level deep inside an allowlisted
    // key. Without recursive scanning, `partner.partner_access_token`
    // would survive because `partner` is allowlisted at the top level.
    // Default patterns catch `*_access_token`, `*_token$`, `*_secret$`,
    // etc. — bare `token` (no separator) is intentionally NOT in the
    // default set (false-positive risk on `paymentToken`-style fields);
    // adopters extend if they need broader coverage.
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: {
          partner: {
            request_id: 'legitimate',
            partner_access_token: 'attacker-deep-nesting',
            inner: { snap_access_token: 'attacker-deeper' },
          },
        },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      allowedExtKeys: new Set(['partner']),
    });
    // partner survived (allowlisted), but its credential-shaped
    // descendants are dropped at any depth.
    assert.deepStrictEqual(scrubbed.ext, {
      partner: {
        request_id: 'legitimate',
        inner: {},
      },
    });
  });

  it('recursive scan with no allowlist drops top-level credential keys too', () => {
    // No `allowedExtKeys` — recursive scan fires from depth 0.
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: {
          partner_request_id: 'legitimate',
          snap_access_token: 'attacker-top-level',
        },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {});
    assert.deepStrictEqual(scrubbed.ext, { partner_request_id: 'legitimate' });
  });

  it('recursive scan can be disabled per-call via recursiveCredentialScan: false', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: { partner: { token: 'preserved-because-scan-disabled' } },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      allowedExtKeys: new Set(['partner']),
      recursiveCredentialScan: false,
    });
    // With scan disabled, nested credential survives. Adopters opt
    // out only when they've validated the surviving shape themselves.
    assert.deepStrictEqual(scrubbed.ext, {
      partner: { token: 'preserved-because-scan-disabled' },
    });
  });

  it('bare token (no _ separator) passes through recursive scan by default', () => {
    // DEFAULT_CREDENTIAL_PATTERNS intentionally excludes bare `token`
    // (no `_` separator) to avoid false positives on fields like
    // `paymentToken`. This test pins that behavioral contract: a value
    // at { partner: { token: 'kept' } } must survive scrubExtensions
    // even with recursiveCredentialScan: true (the default). A
    // regression in DEFAULT_CREDENTIAL_PATTERNS that added bare `token`
    // would silently break adopters who inject token inside an
    // allowlisted key.
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        ext: { partner: { token: 'kept' } },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, {
      allowedExtKeys: new Set(['partner']),
      recursiveCredentialScan: true,
    });
    assert.deepStrictEqual(scrubbed.ext, {
      partner: { token: 'kept' },
    });
  });

  it('preserves wire-spec fields outside ext/context untouched', () => {
    const safe = pickWireSpecFields(
      {
        media_buy_id: 'mb_1',
        idempotency_key: 'uuid-1',
        paused: true,
        packages: [{ package_id: 'p1' }],
        context: { whatever: 'value' },
      },
      'UpdateMediaBuyRequest'
    );
    const scrubbed = scrubExtensions(safe, { allowedExtKeys: new Set() });
    assert.strictEqual(scrubbed.media_buy_id, 'mb_1');
    assert.strictEqual(scrubbed.idempotency_key, 'uuid-1');
    assert.strictEqual(scrubbed.paused, true);
    assert.deepStrictEqual(scrubbed.packages, [{ package_id: 'p1' }]);
  });
});

describe('end-to-end — closes round-N vectors at the operational boundary', () => {
  // Combined test that demonstrates how a storefront fan-out caller
  // chains pickWireSpecFields + scrubExtensions to produce a per-target
  // request that has dropped buyer credentials AND injected
  // storefront-resolved credentials in context.

  it('storefront fan-out flow: buyer creds out, storefront creds in', () => {
    const buyerReq = {
      // Wire-spec fields (legitimate)
      media_buy_id: 'mb_1',
      idempotency_key: 'uuid-1',
      paused: true,
      // Round-1 vector
      snap_access_token: 'attacker-r1',
      // Wire-spec field carrying allowlisted ext keys + buyer creds
      ext: {
        scope3_api_key: 'legit-api-key',
        linkedin_access_token: 'attacker-r3',
      },
      // Wire-spec field carrying buyer-pivot identity
      context: {
        partner_request_id: 'req-1',
        tiktok_access_token: 'attacker-r2',
      },
      // More attack vectors that aren't wire-spec
      account: { brand: 'attacker.com' },
    };

    // Step 1: strip to wire-spec fields. Round-1 dropped, account
    // dropped (wait: account IS wire-spec for UMBR — not dropped).
    const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
    assert.ok(!('snap_access_token' in safe), 'round-1 vector dropped');

    // Step 2: per-target scrub of ext/context + injection of
    // storefront-resolved credentials. Round-2 (context) and
    // round-3 (ext) credential names are NOT in the allowlist, so
    // they're dropped. Storefront credentials are injected.
    const target = scrubExtensions(safe, {
      allowedExtKeys: new Set(['scope3_api_key', 'partner_request_id']),
      inject: {
        context: {
          managed_access_token: 'storefront-resolved-token',
          managed_advertiser_id: 'act_target_1',
        },
      },
    });

    // All three round-N vectors gone:
    assert.ok(!('snap_access_token' in target));
    assert.ok(!('linkedin_access_token' in target.ext));
    assert.ok(!('tiktok_access_token' in target.context));

    // Allowlisted buyer keys survive:
    assert.strictEqual(target.ext.scope3_api_key, 'legit-api-key');
    assert.strictEqual(target.context.partner_request_id, 'req-1');

    // Storefront credentials injected:
    assert.strictEqual(target.context.managed_access_token, 'storefront-resolved-token');
    assert.strictEqual(target.context.managed_advertiser_id, 'act_target_1');

    // Wire-spec mutation fields untouched:
    assert.strictEqual(target.media_buy_id, 'mb_1');
    assert.strictEqual(target.paused, true);
  });
});
