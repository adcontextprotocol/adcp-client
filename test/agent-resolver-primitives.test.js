/**
 * Pure-function primitives backing the brand_json_url discovery chain.
 * Tests cover every reject path the spec defines for steps 3, 5, and 7
 * of security.mdx §"Discovering an agent's signing keys via `brand_json_url`":
 *
 *   - eTLD+1 over a pinned PSL with ICANN+PRIVATE both in scope
 *   - IDNA-2008 + ASCII-lowercase origin canonicalization
 *   - byte-equal agents[] selection across flat and house-portfolio shapes
 *   - identity.key_origins consistency check, including publisher-pin carve-out
 *   - strict JSON parse with duplicate-key + prototype-property rejection
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { eTldPlusOne, sameEtldPlusOne, EtldComputationError } = require('../dist/lib/signing/agent-resolver/etld');
const {
  canonicalizeHost,
  canonicalizeOrigin,
  originsEqual,
  CanonicalizeError,
} = require('../dist/lib/signing/agent-resolver/canonicalize');
const {
  collectAgentEntries,
  selectAgentByUrl,
  AgentSelectorError,
} = require('../dist/lib/signing/agent-resolver/select-agent');
const {
  checkOriginConsistency,
  declaredSigningPurposes,
  checkRequiredOrigins,
} = require('../dist/lib/signing/agent-resolver/consistency');
const { parseStrictJson, StrictJsonError } = require('../dist/lib/signing/agent-resolver/strict-json');
const { readBrandJsonUrl, readIdentityPosture } = require('../dist/lib/signing/agent-resolver/capabilities-types');

describe('eTLD+1 helper', () => {
  it('returns the registrable domain for ICANN suffixes', () => {
    assert.equal(eTldPlusOne('https://buyer.example.com/mcp'), 'example.com');
    assert.equal(eTldPlusOne('a.b.c.d.example.co.uk'), 'example.co.uk');
  });
  it('treats PSL PRIVATE-section suffixes as suffixes', () => {
    // The whole point of allowPrivateDomains: foo.vercel.app must NOT share
    // an eTLD+1 with bar.vercel.app. If `tldts` were running ICANN-only we'd
    // get vercel.app == vercel.app and the check would silently green-light
    // a shared-tenancy spoofing attack.
    assert.equal(eTldPlusOne('foo.vercel.app'), 'foo.vercel.app');
    assert.equal(eTldPlusOne('bar.vercel.app'), 'bar.vercel.app');
    assert.notEqual(eTldPlusOne('foo.vercel.app'), eTldPlusOne('bar.vercel.app'));
  });
  it('lowercases hosts before comparison', () => {
    assert.equal(eTldPlusOne('https://Example.COM/'), 'example.com');
  });
  it('handles IDN via Punycode', () => {
    assert.equal(eTldPlusOne('https://Bücher.example/'), 'xn--bcher-kva.example');
  });
  it('throws on IP literals', () => {
    assert.throws(() => eTldPlusOne('https://1.2.3.4/'), EtldComputationError);
    assert.throws(() => eTldPlusOne('https://[::1]/'), EtldComputationError);
  });
  it('sameEtldPlusOne returns false on either-side error rather than throwing', () => {
    assert.equal(sameEtldPlusOne('https://example.com/', 'https://1.2.3.4/'), false);
    assert.equal(sameEtldPlusOne('https://buyer.example.com/', 'https://api.example.com/'), true);
  });
});

describe('origin canonicalizer', () => {
  it('lowercases ASCII hosts', () => {
    assert.equal(canonicalizeHost('Example.COM'), 'example.com');
    assert.equal(canonicalizeOrigin('https://Example.COM/path?q=1'), 'https://example.com');
  });
  it('produces A-label form for IDN', () => {
    assert.equal(canonicalizeHost('Bücher.example'), 'xn--bcher-kva.example');
  });
  it('preserves a non-default port', () => {
    assert.equal(canonicalizeOrigin('https://example.com:8443/'), 'https://example.com:8443');
  });
  it('drops a default port', () => {
    assert.equal(canonicalizeOrigin('https://example.com:443/'), 'https://example.com');
  });
  it('originsEqual byte-compares after canonicalization', () => {
    assert.ok(originsEqual('https://Example.COM/foo', 'https://example.com/bar'));
    assert.ok(!originsEqual('https://example.com/', 'http://example.com/')); // scheme matters
    assert.ok(!originsEqual('https://example.com/', 'https://api.example.com/')); // host matters
    assert.ok(!originsEqual('https://example.com:443/', 'https://example.com:8443/')); // port matters
  });
  it('rejects bad inputs', () => {
    assert.throws(() => canonicalizeHost(''), CanonicalizeError);
    assert.throws(() => canonicalizeOrigin('ftp://example.com/'), CanonicalizeError);
    assert.throws(() => canonicalizeOrigin('not a url'), CanonicalizeError);
  });
});

describe('byte-equal agents[] selector', () => {
  const flat = {
    agents: [
      { type: 'sales', url: 'https://x.com/mcp', jwks_uri: 'https://keys.x.com/jwks.json' },
      { type: 'creative', url: 'https://x.com/creative', jwks_uri: 'https://keys.x.com/jwks.json' },
    ],
  };
  const house = {
    house: {
      agents: [
        { type: 'governance', url: 'https://op.example/governance', jwks_uri: 'https://keys.op.example/jwks.json' },
      ],
    },
    brands: [
      {
        id: 'brand-a',
        agents: [
          { type: 'sales', url: 'https://op.example/brand-a/mcp', jwks_uri: 'https://keys.op.example/jwks.json' },
        ],
      },
    ],
  };

  it('finds a unique entry on byte-equal match', () => {
    const entry = selectAgentByUrl(flat, 'https://x.com/mcp');
    assert.equal(entry.type, 'sales');
  });

  it('walks house and brands[].agents[]', () => {
    assert.equal(selectAgentByUrl(house, 'https://op.example/governance').type, 'governance');
    assert.equal(selectAgentByUrl(house, 'https://op.example/brand-a/mcp').type, 'sales');
  });

  it('throws agent_not_in_brand_json on trailing-slash mismatch', () => {
    try {
      selectAgentByUrl(flat, 'https://x.com/mcp/');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof AgentSelectorError);
      assert.equal(err.code, 'agent_not_in_brand_json');
    }
  });

  it('throws brand_json_ambiguous on multiple matches with matched_entries detail', () => {
    const dup = {
      agents: [
        { type: 'sales', url: 'https://x.com/mcp', jwks_uri: 'https://a/jwks.json' },
        { type: 'sales', url: 'https://x.com/mcp', jwks_uri: 'https://b/jwks.json' }, // operator misconfig
      ],
    };
    try {
      selectAgentByUrl(dup, 'https://x.com/mcp');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'brand_json_ambiguous');
      assert.equal(err.detail.matched_count, 2);
      assert.equal(err.detail.matched_entries.length, 2);
    }
  });

  it('skips entries with non-string url silently (cannot match an agent URL anyway)', () => {
    const partlyBroken = {
      agents: [{ url: 42 }, { type: 'sales', url: 'https://x.com/mcp' }],
    };
    const entry = selectAgentByUrl(partlyBroken, 'https://x.com/mcp');
    assert.equal(entry.type, 'sales');
  });

  it('collectAgentEntries returns entries from every shape', () => {
    assert.equal(collectAgentEntries(flat).length, 2);
    assert.equal(collectAgentEntries(house).length, 2);
    assert.equal(collectAgentEntries(null).length, 0);
    assert.equal(collectAgentEntries({}).length, 0);
  });
});

describe('identity.key_origins consistency', () => {
  it('passes when origin matches', () => {
    const result = checkOriginConsistency({
      purpose: 'request_signing',
      declaredOrigin: 'https://keys.example.com',
      resolvedJwksUri: 'https://keys.example.com/jwks.json',
      publisherPinned: false,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('flags mismatch with canonicalized origins on the detail', () => {
    const result = checkOriginConsistency({
      purpose: 'webhook_signing',
      declaredOrigin: 'https://Webhooks.Example.COM',
      resolvedJwksUri: 'https://keys.example.com/jwks.json',
      publisherPinned: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'key_origin_mismatch');
    assert.equal(result.purpose, 'webhook_signing');
    assert.equal(result.expected_origin, 'https://webhooks.example.com');
    assert.equal(result.actual_origin, 'https://keys.example.com');
  });

  it('skips the check entirely when publisherPinned is true', () => {
    // Sell-side webhook-signing carve-out: publisher pin is authoritative,
    // operator brand.json origin is advisory.
    const result = checkOriginConsistency({
      purpose: 'webhook_signing',
      declaredOrigin: 'https://webhooks.example.com',
      resolvedJwksUri: 'https://pin.publisher.example/jwks.json',
      publisherPinned: true,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('returns ok when no origin is declared (caller checks _missing separately)', () => {
    const result = checkOriginConsistency({
      purpose: 'request_signing',
      declaredOrigin: undefined,
      resolvedJwksUri: 'https://keys.example.com/jwks.json',
      publisherPinned: false,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('declaredSigningPurposes detects request_signing.supported_for', () => {
    const purposes = declaredSigningPurposes({
      request_signing: { supported_for: ['create_media_buy'] },
    });
    assert.ok(purposes.has('request_signing'));
  });
  it('declaredSigningPurposes detects request_signing.required_for', () => {
    const purposes = declaredSigningPurposes({
      request_signing: { required_for: ['create_media_buy'] },
    });
    assert.ok(purposes.has('request_signing'));
  });
  it('declaredSigningPurposes detects webhook_signing.supported', () => {
    const purposes = declaredSigningPurposes({
      webhook_signing: { supported: true },
    });
    assert.ok(purposes.has('webhook_signing'));
  });
  it('declaredSigningPurposes ignores webhook_signing.supported === false', () => {
    const purposes = declaredSigningPurposes({
      webhook_signing: { supported: false },
    });
    assert.ok(!purposes.has('webhook_signing'));
  });
  it('declaredSigningPurposes pulls every purpose present under identity.key_origins', () => {
    const purposes = declaredSigningPurposes({
      identity: { key_origins: { governance_signing: 'https://g.example/', tmp_signing: 'https://t.example/' } },
    });
    assert.ok(purposes.has('governance_signing'));
    assert.ok(purposes.has('tmp_signing'));
  });

  it('checkRequiredOrigins flags purposes with no declared origin', () => {
    const declared = new Set(['request_signing', 'webhook_signing']);
    const missing = checkRequiredOrigins(declared, { request_signing: 'https://r.example/' });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].purpose, 'webhook_signing');
    assert.equal(missing[0].code, 'key_origin_missing');
  });
});

describe('strict JSON parse', () => {
  it('parses normal JSON', () => {
    assert.deepEqual(parseStrictJson('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
  });
  it('rejects duplicate keys at top level', () => {
    try {
      parseStrictJson('{"a":1,"a":2}');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof StrictJsonError);
      assert.equal(err.code, 'duplicate_key');
      assert.equal(err.detail.key, 'a');
    }
  });
  it('rejects duplicate keys in nested objects', () => {
    try {
      parseStrictJson('{"outer":{"k":1,"k":2}}');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'duplicate_key');
      assert.equal(err.detail.key, 'k');
    }
  });
  it('allows the same key at different scopes', () => {
    const v = parseStrictJson('{"k":1,"nested":{"k":2}}');
    assert.deepEqual(v, { k: 1, nested: { k: 2 } });
  });
  it('handles strings with escaped quotes', () => {
    const v = parseStrictJson('{"msg":"a \\"b\\" c","ok":true}');
    assert.equal(v.msg, 'a "b" c');
  });
  it('rejects __proto__ pollution', () => {
    try {
      parseStrictJson('{"__proto__":{"polluted":true}}');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof StrictJsonError);
      assert.equal(err.code, 'forbidden_prototype_property');
    }
  });
  it('rejects constructor pollution', () => {
    try {
      parseStrictJson('{"constructor":{"prototype":{"polluted":true}}}');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'forbidden_prototype_property');
    }
  });
  it('rejects malformed JSON', () => {
    try {
      parseStrictJson('{not json');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof StrictJsonError);
    }
  });
  it('detects duplicate keys when one form is escaped and the other is literal', () => {
    // `a` decodes to `a`. The tokenizer's decoded form must equal a
    // literal `a` so the dedupe Set catches the duplicate. Without proper
    // escape decoding the smuggled key slips past.
    try {
      parseStrictJson('{"a":1,"\\u0061":2}');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'duplicate_key');
    }
  });
  it('rejects unescaped control characters in strings (RFC 8259 §7)', () => {
    try {
      parseStrictJson('{"a":" "}'); // literal NUL inside the value
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'invalid_json');
    }
  });
  it('handles surrogate-pair emoji keys without false positives', () => {
    // 😀 = U+1F600, encoded as the surrogate pair 😀 in UTF-16.
    const v = parseStrictJson('{"\\uD83D\\uDE00":1}');
    assert.equal(v['😀'], 1);
  });
  it('detects duplicate keys across literal and surrogate-pair forms', () => {
    try {
      parseStrictJson('{"😀":1,"\\uD83D\\uDE00":2}');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'duplicate_key');
    }
  });
  it('survives realistic brand.json shapes', () => {
    const text = JSON.stringify({
      identity: { brand_json_url: 'https://op.example/.well-known/brand.json' },
      agents: [{ type: 'sales', url: 'https://op.example/mcp', jwks_uri: 'https://keys.op.example/jwks.json' }],
    });
    assert.ok(parseStrictJson(text));
  });
});

describe('forward-compat capabilities readers', () => {
  it('readBrandJsonUrl returns the field when present and a string', () => {
    const caps = { identity: { brand_json_url: 'https://op.example/.well-known/brand.json' } };
    assert.equal(readBrandJsonUrl(caps), 'https://op.example/.well-known/brand.json');
  });
  it('readBrandJsonUrl returns undefined when absent', () => {
    assert.equal(readBrandJsonUrl({ identity: {} }), undefined);
    assert.equal(readBrandJsonUrl({}), undefined);
    assert.equal(readBrandJsonUrl(null), undefined);
  });
  it('readBrandJsonUrl returns undefined when the field is the wrong type', () => {
    assert.equal(readBrandJsonUrl({ identity: { brand_json_url: 42 } }), undefined);
  });
  it('readIdentityPosture returns the block when present', () => {
    const caps = { identity: { per_principal_key_isolation: true, key_origins: { request_signing: 'x' } } };
    const posture = readIdentityPosture(caps);
    assert.equal(posture.per_principal_key_isolation, true);
    assert.equal(posture.key_origins.request_signing, 'x');
  });
});
