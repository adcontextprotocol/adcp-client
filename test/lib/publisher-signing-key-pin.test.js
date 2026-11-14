/**
 * `signing_keys` across several matching `authorized_agents[]` entries
 * (adcontextprotocol/adcp#9016). Among the entries that match the agent AND
 * authorize the message's scope, the publisher pins the agent only if every
 * one pins, and the pin is then the union of their keys. An entry that
 * authorizes nothing for the message never pins or unpins it. A message about
 * several properties must satisfy each property's pin. An agent that is not
 * authorized gets `[]` (accept no key), never "no pin".
 *
 * The server counterpart runs the same URL cases in adcontextprotocol/adcp
 * (server/tests/fixtures/authorized-agent-url-matching.ts, SIGNING_KEY_CASES).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { generateKeyPair, exportJWK } = require('jose');

const { resolvePublisherSigningKeyPin } = require('../../dist/lib/discovery/resolve-agent-properties.js');
const { assertPublisherPins } = require('../../dist/lib/signing/publisher-pins.js');
const discovery = require('../../dist/lib/entrypoints/discovery.js');
const root = require('../../dist/lib/index.js');

const V33 = '3.3';
const V32 = '3.2';
const ORIGIN = 'https://signer.example.com';
const AGENT = 'https://signer.example.com/mcp';

const key = kid => ({ kid, kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', x: `x-${kid}` });

function entry(url, kids, extra = {}) {
  return {
    url,
    authorized_for: 'Direct',
    authorization_type: 'property_ids',
    property_ids: ['site_x', 'site_y'],
    ...(kids ? { signing_keys: kids.map(key) } : {}),
    ...extra,
  };
}

function manifest(entries) {
  return {
    properties: [
      { property_id: 'site_x', property_type: 'website', name: 'X', identifiers: [] },
      { property_id: 'site_y', property_type: 'website', name: 'Y', identifiers: [] },
    ],
    authorized_agents: entries,
  };
}

function pinKids(entries, options = {}, agentUrl = AGENT) {
  const pin = resolvePublisherSigningKeyPin(manifest(entries), agentUrl, { adcpVersion: V33, ...options });
  return pin === undefined ? null : pin.map(k => k.kid);
}

describe('resolvePublisherSigningKeyPin (adcp#9016)', () => {
  const urlCases = [
    ['origin unpinned, /mcp pinned: no pin', [entry(ORIGIN), entry(AGENT, ['k1'])], null],
    ['/mcp pinned, origin unpinned (reverse order): no pin', [entry(AGENT, ['k1']), entry(ORIGIN)], null],
    ['origin pinned, /mcp unpinned: no pin', [entry(ORIGIN, ['k1']), entry(AGENT)], null],
    ['an empty signing_keys array is unpinned', [entry(ORIGIN, []), entry(AGENT, ['k1'])], null],
    ['both pinned with different keys: the union', [entry(ORIGIN, ['k1']), entry(AGENT, ['k2'])], ['k1', 'k2']],
    ['reverse order: the union in document order', [entry(AGENT, ['k2']), entry(ORIGIN, ['k1'])], ['k2', 'k1']],
    [
      'overlapping keys: a shared key appears once',
      [entry(ORIGIN, ['k1', 'k2']), entry(AGENT, ['k2', 'k3'])],
      ['k1', 'k2', 'k3'],
    ],
    [
      'an unpinned entry for another path does not unpin the agent',
      [entry(ORIGIN, ['k1']), entry('https://signer.example.com/a2a')],
      ['k1'],
    ],
    ['an unpinned /mcp/ entry does not unpin /mcp', [entry(AGENT, ['k1']), entry(`${AGENT}/`)], ['k1']],
    [
      'a pinned entry for another path adds no key',
      [entry(ORIGIN, ['k1']), entry('https://signer.example.com/a2a', ['k9'])],
      ['k1'],
    ],
    ['one exact entry, pinned: its own keys', [entry(AGENT, ['k1', 'k2'])], ['k1', 'k2']],
    ['one exact entry, unpinned: no pin', [entry(AGENT)], null],
  ];

  for (const [why, entries, expected] of urlCases) {
    test(`3.3: ${why}`, () => {
      assert.deepStrictEqual(pinKids(entries), expected);
    });
  }

  describe('an entry that authorizes nothing for the message never pins or unpins it', () => {
    test('an unpinned entry for another country', () => {
      const entries = [entry(ORIGIN, undefined, { countries: ['GB'] }), entry(AGENT, ['k1'])];
      assert.deepStrictEqual(pinKids(entries, { country: 'US' }), ['k1']);
      // For GB both entries authorize the message, so it is unpinned.
      assert.deepStrictEqual(pinKids(entries, { country: 'gb' }), null);
    });

    test('an expired unpinned entry', () => {
      const entries = [entry(ORIGIN, undefined, { effective_until: '2020-01-01T00:00:00Z' }), entry(AGENT, ['k1'])];
      assert.deepStrictEqual(pinKids(entries), ['k1']);
      // Before it expired, it covered the message and unpinned it.
      assert.deepStrictEqual(pinKids(entries, { at: '2019-06-01T00:00:00Z' }), null);
    });

    test('a not-yet-effective unpinned entry', () => {
      const entries = [entry(ORIGIN, undefined, { effective_from: '2999-01-01T00:00:00Z' }), entry(AGENT, ['k1'])];
      assert.deepStrictEqual(pinKids(entries), ['k1']);
    });

    test('an unpinned signals-only entry does not unpin a sales message', () => {
      const signals = { url: ORIGIN, authorized_for: 'Signals', authorization_type: 'signal_ids', signal_ids: ['s1'] };
      assert.deepStrictEqual(pinKids([signals, entry(AGENT, ['k1'])]), ['k1']);
    });

    test('an unpinned entry that resolves to nothing', () => {
      const missingSelector = { url: ORIGIN, authorized_for: 'Broken', authorization_type: 'property_ids' };
      const noMatch = entry(ORIGIN, undefined, { property_ids: ['site_missing'] });
      const unknownType = { url: ORIGIN, authorized_for: 'Future', authorization_type: 'future_type' };
      for (const broken of [missingSelector, noMatch, unknownType]) {
        assert.deepStrictEqual(pinKids([broken, entry(AGENT, ['k1'])]), ['k1']);
      }
    });
  });

  describe('a message about several properties satisfies each property pin', () => {
    test('an unpinned entry for one property does not unpin the other', () => {
      // The origin entry (unpinned) covers X only; /mcp pins k1 on X and Y.
      const entries = [entry(ORIGIN, undefined, { property_ids: ['site_x'] }), entry(AGENT, ['k1'])];
      assert.deepStrictEqual(pinKids(entries, { propertyIds: ['site_x', 'site_y'] }), ['k1']);
      assert.deepStrictEqual(pinKids(entries, { propertyIds: ['site_x'] }), null);
      assert.deepStrictEqual(pinKids(entries, { propertyIds: ['site_y'] }), ['k1']);
    });

    test('pins intersect across properties', () => {
      const entries = [entry(ORIGIN, ['k1'], { property_ids: ['site_x'] }), entry(AGENT, ['k2'])];
      // X allows k1 or k2; Y allows k2.
      assert.deepStrictEqual(pinKids(entries, { propertyIds: ['site_x', 'site_y'] }), ['k2']);
    });

    test('pinned properties that share no key accept no key', () => {
      const entries = [
        entry(ORIGIN, ['k1'], { property_ids: ['site_x'] }),
        entry(AGENT, ['k2'], { property_ids: ['site_y'] }),
      ];
      assert.deepStrictEqual(pinKids(entries, { propertyIds: ['site_x', 'site_y'] }), []);
    });

    test('a property no entry authorizes accepts no key', () => {
      const entries = [entry(AGENT, undefined, { property_ids: ['site_x'] })];
      assert.deepStrictEqual(pinKids(entries, { propertyIds: ['site_x', 'site_y'] }), []);
    });
  });

  describe('not authorized is never "no pin"', () => {
    test('agent not listed: accept no key', () => {
      assert.deepStrictEqual(pinKids([entry('https://other.example.com')]), []);
    });

    test('3.2 ambiguous agent: accept no key', () => {
      assert.deepStrictEqual(pinKids([entry(AGENT), entry(AGENT)], { adcpVersion: V32 }), []);
    });

    test('a country-limited entry with no country given: accept no key', () => {
      assert.deepStrictEqual(pinKids([entry(AGENT, undefined, { countries: ['US'] })]), []);
    });

    test('only an expired entry: accept no key', () => {
      assert.deepStrictEqual(pinKids([entry(AGENT, undefined, { effective_until: '2020-01-01T00:00:00Z' })]), []);
    });

    test('an unparseable agent URL: accept no key', () => {
      assert.deepStrictEqual(pinKids([entry(AGENT)], {}, 'not a url'), []);
    });
  });

  test('3.2: the single exact entry is the pin; an origin-only entry does not match a path', () => {
    assert.deepStrictEqual(pinKids([entry(ORIGIN), entry(AGENT, ['k1'])], { adcpVersion: V32 }), ['k1']);
    assert.deepStrictEqual(pinKids([entry(ORIGIN, ['k1']), entry(AGENT)], { adcpVersion: V32 }), null);
    assert.deepStrictEqual(pinKids([entry(AGENT, ['k1', 'k2'])], { adcpVersion: V32 }), ['k1', 'k2']);
  });

  test('ignores null and non-object entries', () => {
    assert.deepStrictEqual(pinKids([null, 'https://signer.example.com', entry(AGENT, ['k1'])]), ['k1']);
  });

  test('keeps a revoked copy of a key next to an unrevoked one, in either order', () => {
    const revoked = { ...key('k1'), revoked_at: '2026-11-01T00:00:00Z' };
    for (const [a, b] of [
      [key('k1'), revoked],
      [revoked, key('k1')],
    ]) {
      const pin = resolvePublisherSigningKeyPin(
        manifest([
          { ...entry(ORIGIN), signing_keys: [a] },
          { ...entry(AGENT), signing_keys: [b] },
        ]),
        AGENT,
        { adcpVersion: V33 }
      );
      assert.deepStrictEqual(pin, [a, b]);
    }
  });

  test('is exported from @adcp/sdk and @adcp/sdk/discovery', () => {
    for (const mod of [discovery, root]) {
      assert.strictEqual(typeof mod.resolvePublisherSigningKeyPin, 'function');
      const pin = mod.resolvePublisherSigningKeyPin(manifest([entry(ORIGIN, ['k1']), entry(AGENT, ['k2'])]), AGENT, {
        adcpVersion: V33,
      });
      assert.deepStrictEqual(
        pin.map(k => k.kid),
        ['k1', 'k2']
      );
    }
  });
});

describe('resolvePublisherSigningKeyPin with assertPublisherPins', () => {
  const nowSeconds = () => Date.now() / 1000;

  async function signerKey() {
    const { publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwk = await exportJWK(publicKey);
    return { ...jwk, kid: 'live', alg: 'EdDSA', use: 'sig', key_ops: ['verify'], adcp_use: 'webhook-signing' };
  }

  function pinFrom(signingKeys, publisher) {
    return { publisher, signingKeys, refresh: async () => signingKeys ?? null };
  }

  test('the earliest revoked_at on any copy applies, whatever the entry order', async () => {
    const jwk = await signerKey();
    const pinned = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: 'pinned' };
    const revoked = { ...pinned, revoked_at: '2020-01-01T00:00:00Z' };
    for (const [i, [a, b]] of [
      [pinned, revoked],
      [revoked, pinned],
    ].entries()) {
      const signingKeys = resolvePublisherSigningKeyPin(
        manifest([
          { ...entry(ORIGIN), signing_keys: [a] },
          { ...entry(AGENT), signing_keys: [b] },
        ]),
        AGENT,
        { adcpVersion: V33 }
      );
      await assert.rejects(
        assertPublisherPins(jwk, [pinFrom(signingKeys, `revoked-${i}.example`)], nowSeconds),
        /outside the applicable publisher pin/
      );
    }
  });

  test('an unrevoked union key is accepted', async () => {
    const jwk = await signerKey();
    const pinned = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: 'pinned' };
    const signingKeys = resolvePublisherSigningKeyPin(
      manifest([
        { ...entry(ORIGIN), signing_keys: [key('other')] },
        { ...entry(AGENT), signing_keys: [pinned] },
      ]),
      AGENT,
      { adcpVersion: V33 }
    );
    await assertPublisherPins(jwk, [pinFrom(signingKeys, 'union.example')], nowSeconds);
  });

  test('an unauthorized agent ([]) is rejected, not treated as unpinned', async () => {
    const jwk = await signerKey();
    const signingKeys = resolvePublisherSigningKeyPin(manifest([entry('https://other.example.com')]), AGENT, {
      adcpVersion: V33,
    });
    assert.deepStrictEqual(signingKeys, []);
    await assert.rejects(
      assertPublisherPins(jwk, [pinFrom(signingKeys, 'unauthorized.example')], nowSeconds),
      /outside the applicable publisher pin/
    );
  });

  test('an unpinned publisher (undefined) accepts the agent JWKS key', async () => {
    const jwk = await signerKey();
    const signingKeys = resolvePublisherSigningKeyPin(manifest([entry(ORIGIN), entry(AGENT, ['k1'])]), AGENT, {
      adcpVersion: V33,
    });
    assert.strictEqual(signingKeys, undefined);
    await assertPublisherPins(jwk, [pinFrom(signingKeys, 'unpinned.example')], nowSeconds);
  });
});
