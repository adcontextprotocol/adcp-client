/**
 * `signing_keys` across several matching `authorized_agents[]` entries
 * (adcontextprotocol/adcp#9016): the publisher pins the agent only if every
 * matching entry pins, and the pin is then the union of their keys.
 *
 * The server counterpart runs the same cases in adcontextprotocol/adcp
 * (server/tests/fixtures/authorized-agent-url-matching.ts, SIGNING_KEY_CASES).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  resolveAgentProperties,
  resolvePublisherSigningKeyPin,
} = require('../../dist/lib/discovery/resolve-agent-properties.js');
const discovery = require('../../dist/lib/entrypoints/discovery.js');
const root = require('../../dist/lib/index.js');

const V33 = '3.3';
const V32 = '3.2';
const ORIGIN = 'https://signer.example.com';
const AGENT = 'https://signer.example.com/mcp';

const key = kid => ({ kid, kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', x: `x-${kid}` });

function entry(url, kids) {
  return {
    url,
    authorized_for: 'Direct',
    authorization_type: 'property_ids',
    property_ids: ['site'],
    ...(kids ? { signing_keys: kids.map(key) } : {}),
  };
}

function manifest(entries) {
  return {
    properties: [{ property_id: 'site', property_type: 'website', name: 'Site', identifiers: [] }],
    authorized_agents: entries,
  };
}

function pinKids(entries, agentUrl = AGENT, adcpVersion = V33) {
  const scope = resolveAgentProperties(manifest(entries), agentUrl, { adcpVersion });
  const pin = resolvePublisherSigningKeyPin(scope);
  return pin === undefined ? null : pin.map(k => k.kid);
}

describe('resolvePublisherSigningKeyPin (adcp#9016)', () => {
  const cases = [
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

  for (const [why, entries, expected] of cases) {
    test(`3.3: ${why}`, () => {
      assert.deepStrictEqual(pinKids(entries), expected);
    });
  }

  test('3.2: the single exact entry is the pin; an origin-only entry does not match a path', () => {
    // Below 3.3 the origin entry does not match /mcp, so only /mcp counts.
    assert.deepStrictEqual(pinKids([entry(ORIGIN), entry(AGENT, ['k1'])], AGENT, V32), ['k1']);
    assert.deepStrictEqual(pinKids([entry(ORIGIN, ['k1']), entry(AGENT)], AGENT, V32), null);
    assert.deepStrictEqual(pinKids([entry(AGENT, ['k1', 'k2'])], AGENT, V32), ['k1', 'k2']);
  });

  test('3.2: an ambiguous agent has no matched entry, so no pin is reported', () => {
    const scope = resolveAgentProperties(manifest([entry(AGENT, ['k1']), entry(AGENT, ['k2'])]), AGENT, {
      adcpVersion: V32,
    });
    assert.strictEqual(scope.unresolvable, 'ambiguous_agent_url');
    assert.strictEqual(resolvePublisherSigningKeyPin(scope), undefined);
  });

  test('accepts the matching entries directly', () => {
    assert.deepStrictEqual(
      resolvePublisherSigningKeyPin([entry(ORIGIN, ['k1']), entry(AGENT, ['k2'])]).map(k => k.kid),
      ['k1', 'k2']
    );
    assert.strictEqual(resolvePublisherSigningKeyPin([entry(ORIGIN, ['k1']), entry(AGENT)]), undefined);
    assert.strictEqual(resolvePublisherSigningKeyPin([]), undefined);
  });

  test('no matched entry: no pin', () => {
    assert.strictEqual(pinKids([entry('https://other.example.com', ['k1'])]), null);
  });

  test('keeps a revoked copy of a key next to an unrevoked one', () => {
    const revoked = { ...key('k1'), revoked_at: '2026-11-01T00:00:00Z' };
    const pin = resolvePublisherSigningKeyPin([
      { ...entry(ORIGIN), signing_keys: [key('k1')] },
      { ...entry(AGENT), signing_keys: [revoked] },
    ]);
    assert.deepStrictEqual(pin, [key('k1'), revoked]);
  });

  test('never returns an empty array, which PublisherSigningKeyPin reads as "accept no key"', () => {
    for (const [, entries] of cases) {
      const pin = resolvePublisherSigningKeyPin(entries);
      assert.ok(pin === undefined || pin.length > 0);
    }
  });

  test('is exported from @adcp/sdk and @adcp/sdk/discovery', () => {
    for (const mod of [discovery, root]) {
      assert.strictEqual(typeof mod.resolvePublisherSigningKeyPin, 'function');
      assert.deepStrictEqual(
        mod.resolvePublisherSigningKeyPin([entry(ORIGIN, ['k1']), entry(AGENT, ['k2'])]).map(k => k.kid),
        ['k1', 'k2']
      );
    }
  });
});
