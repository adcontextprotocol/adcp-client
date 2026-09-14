const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const sdk = require('../../dist/lib');
const {
  evaluateSupplyPath,
  verifySupplyPath,
  parseInventoryPartnerDomains,
  annotateProductsSupplyPaths,
  RegistryClient,
} = sdk;
const AGENT = 'https://sales.channel-owner.example';
const OWNER = 'channel-owner.example';
const HOST = 'hoststream.example';
function input() {
  return {
    ownerDomain: OWNER,
    hostDomain: HOST,
    agentUrl: AGENT,
    collectionId: 'retro_news',
    hostInventoryPartnerDomains: null,
    ownerManifest: {
      authorized_agents: [{ url: AGENT, authorized_for: 'Owner avails' }],
      collections: [
        {
          collection_id: 'retro_news',
          name: 'Retro News',
          kind: 'channel',
          distribution: [{ publisher_domain: HOST, property_ids: ['hoststream_ctv'] }],
        },
      ],
    },
    hostManifest: {
      properties: [
        {
          property_id: 'hoststream_ctv',
          name: 'HostStream',
          property_type: 'ctv_app',
          identifiers: [{ type: 'roku_channel_id', value: '123' }],
        },
      ],
      authorized_agents: [
        {
          url: AGENT,
          authorized_for: 'Owner avails',
          authorization_type: 'property_ids',
          property_ids: ['hoststream_ctv'],
          collections: [{ publisher_domain: OWNER, collection_ids: ['retro_news'] }],
        },
      ],
    },
  };
}
const request = { owner_domain: OWNER, host_domain: HOST, agent_url: AGENT, collection_id: 'retro_news' };
function transport(changes = {}, requests = []) {
  const fixture = input();
  const responses = {
    [`https://${OWNER}/.well-known/adagents.json`]: fixture.ownerManifest,
    [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest,
    ...changes,
  };
  return async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.redirect, 'manual');
    const value = responses[url];
    if (typeof value === 'function') return value(url, init);
    if (value instanceof Response) return value.clone();
    if (value === undefined) return new Response('missing', { status: 404 });
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
}

// This corpus is consumed verbatim by the upstream registry and this SDK.
describe('canonical shared supply-path golden vectors', () => {
  it('preserves the pinned upstream bytes', () => {
    const source = JSON.parse(readFileSync(require.resolve('../fixtures/supply-path/source.json'), 'utf8'));
    const bytes = readFileSync(require.resolve('../fixtures/supply-path/vectors.json'));
    assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  });
  const corpus = JSON.parse(readFileSync(require.resolve('../fixtures/supply-path/vectors.json'), 'utf8'));
  const { supplyPathAdsTxtPolicy, combineInventoryPartnerDomains } = require('../../dist/lib/supply-path/evaluate');
  for (const vector of corpus.ads_txt_policy_vectors)
    it(vector.id, () => assert.deepEqual(supplyPathAdsTxtPolicy(vector.input), vector.expected));
  for (const vector of corpus.inventory_partner_combination_vectors)
    it(vector.id, () =>
      assert.deepEqual(combineInventoryPartnerDomains(vector.contents, vector.requireAll), vector.expected)
    );
  for (const vector of corpus.vectors)
    it(vector.id, () => {
      const result = evaluateSupplyPath(vector.input);
      const projection = {
        ...(result.resolved_collection_id ? { resolved_collection_id: result.resolved_collection_id } : {}),
        semantics_version: result.semantics_version,
        state: result.state,
        legs: Object.fromEntries(
          Object.entries(result.legs).map(([key, leg]) => [
            key,
            { ok: leg.ok, ...(leg.failure ? { failure: leg.failure } : {}) },
          ])
        ),
      };
      assert.deepEqual(projection, vector.expected);
    });
  for (const vector of corpus.inventory_partner_domain_vectors)
    it(vector.id, () => assert.deepEqual(parseInventoryPartnerDomains(vector.text), vector.expected));
});

describe('fail-closed authoritative semantics', () => {
  for (const collections of [
    null,
    {},
    'all',
    [],
    [{ publisher_domain: OWNER, collection_ids: null }],
    [{ publisher_domain: OWNER, collection_ids: [] }],
    [{ publisher_domain: OWNER, collection_ids: ['retro_news', 42] }],
  ]) {
    it(`rejects malformed collection scope ${JSON.stringify(collections)}`, () => {
      const evidence = input();
      evidence.hostManifest.authorized_agents[0].collections = collections;
      const result = evaluateSupplyPath(evidence);
      assert.equal(result.state, 'owner_attested');
      assert.equal(result.legs.host_authorization.failure, 'collection_scope_mismatch');
    });
  }
  for (const field of ['countries', 'placement_ids', 'placement_tags', 'effective_from', 'effective_until']) {
    it(`does not widen unevaluated ${field}`, () => {
      const evidence = input();
      evidence.hostManifest.authorized_agents[0][field] = 'unparseable';
      assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
    });
  }
  it('refuses any dangling property ID, even alongside a valid ID', () => {
    const evidence = input();
    evidence.ownerManifest.collections[0].distribution[0].property_ids.push('dangling');
    const result = evaluateSupplyPath(evidence);
    assert.equal(result.state, 'owner_attested');
    assert.equal(result.legs.owner_distribution_carriage.failure, 'property_ids_unresolved');
    assert.deepEqual(result.legs.owner_distribution_carriage.property_ids_unmatched, ['dangling']);
  });
  it('never treats unknown or signal authorization types as publisher-wide', () => {
    for (const type of [undefined, 'signal_ids', 'future']) {
      const evidence = input();
      evidence.hostManifest.authorized_agents[0].authorization_type = type;
      assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
    }
  });
  it('checks identifier-only carriage against a resolvable host grant', () => {
    const evidence = input();
    evidence.ownerManifest.collections[0].distribution[0] = {
      publisher_domain: HOST,
      identifiers: [{ type: 'publisher_channel_id', value: 'retro' }],
    };
    assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
    evidence.hostManifest.authorized_agents[0].property_ids = ['missing'];
    assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
  });
  it('accepts distribution with both property IDs and identifiers', () => {
    const evidence = input();
    evidence.ownerManifest.collections[0].distribution[0].identifiers = [
      { type: 'publisher_channel_id', value: 'retro' },
    ];
    assert.equal(evaluateSupplyPath(evidence).state, 'verified_owner_sold');
  });
  it('never conflates URL paths by lowercasing or removing a slash', () => {
    for (const url of [AGENT + '/Sales', AGENT + '/sales/']) {
      const evidence = input();
      evidence.agentUrl = AGENT + '/sales';
      evidence.hostManifest.authorized_agents[0].url = url;
      assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
    }
  });
  it('does not stitch collection A carriage to collection B authorization', () => {
    const evidence = input();
    delete evidence.collectionId;
    evidence.ownerManifest.collections.push({
      collection_id: 'other',
      name: 'Other',
      kind: 'channel',
      distribution: [],
    });
    evidence.hostManifest.authorized_agents[0].collections[0].collection_ids = ['other'];
    assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
  });
  it('honors host property revocation', () => {
    const evidence = input();
    evidence.hostManifest.revoked_publisher_domains = [HOST];
    assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
  });
  it('resolves property tags and rejects malformed publisher selectors', () => {
    const evidence = input();
    evidence.hostManifest.properties[0].tags = ['ctv'];
    const grant = evidence.hostManifest.authorized_agents[0];
    grant.authorization_type = 'property_tags';
    delete grant.property_ids;
    grant.property_tags = ['ctv'];
    assert.equal(evaluateSupplyPath(evidence).state, 'verified_owner_sold');
    grant.authorization_type = 'publisher_properties';
    grant.publisher_properties = [{ publisher_domain: HOST, publisher_domains: [HOST], selection_type: 'all' }];
    assert.equal(evaluateSupplyPath(evidence).state, 'owner_attested');
  });
});

describe('live evidence retrieval', () => {
  it('fetches authoritative files, returns hashes and replay bytes, and does not call the agent', async () => {
    const calls = [];
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({}, calls),
      retainEvidenceBodies: true,
    });
    assert.equal(result.state, 'verified_owner_sold');
    assert.equal(result.sources.cached, false);
    assert.equal(calls.length, 2);
    for (const item of result.sources.evidence)
      assert.equal(item.sha256, createHash('sha256').update(Buffer.from(item.body_base64, 'base64')).digest('hex'));
    assert.ok(calls.every(c => c.url.endsWith('/.well-known/adagents.json')));
  });
  it('uses app-ads.txt for interim host evidence and distinguishes unavailable from absent', async () => {
    for (const [text, expected] of [
      ['INVENTORYPARTNERDOMAIN=channel-owner.example # owner', 'host_delegated'],
      ['', 'owner_attested'],
    ]) {
      const host = input().hostManifest;
      host.authorized_agents = [];
      const result = await verifySupplyPath(request, {
        source: 'authoritative',
        trustedFetchFn: transport({
          [`https://${HOST}/.well-known/adagents.json`]: host,
          [`https://${HOST}/app-ads.txt`]: new Response(text, { headers: { 'content-type': 'text/plain' } }),
        }),
      });
      assert.equal(result.state, expected);
      assert.equal(result.legs.inventory_partner_domain.failure, text ? undefined : 'not_declared');
    }
  });
  it('follows a publisher-origin authoritative_location once and retains the trust chain', async () => {
    const target = 'https://cdn.example/owner.json';
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({
        [`https://${OWNER}/.well-known/adagents.json`]: { authoritative_location: target },
        [target]: input().ownerManifest,
      }),
    });
    assert.equal(result.state, 'verified_owner_sold');
    assert.ok(result.sources.evidence.some(e => e.delegated_to === target));
  });
  it('refuses cross-origin HTTP redirects without contacting the target', async () => {
    const calls = [];
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport(
        {
          [`https://${OWNER}/.well-known/adagents.json`]: new Response('', {
            status: 302,
            headers: { location: 'https://other.example/manifest' },
          }),
        },
        calls
      ),
    });
    assert.equal(result.state, 'unverified');
    assert.ok(!calls.some(c => c.url.includes('other.example')));
    assert.ok(result.sources.evidence.some(e => e.error === 'redirect_refused'));
  });
  it('follows bounded same-origin HTTP redirects', async () => {
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({
        [`https://${OWNER}/.well-known/adagents.json`]: new Response('', {
          status: 302,
          headers: { location: '/manifest.json' },
        }),
        [`https://${OWNER}/manifest.json`]: input().ownerManifest,
      }),
    });
    assert.equal(result.state, 'verified_owner_sold');
    assert.equal(result.sources.evidence.length, 3);
  });
  it('rejects private/metadata targets even with a trusted transport', async () => {
    for (const target of ['https://127.0.0.1/manifest', 'https://169.254.169.254/manifest', 'https://[::1]/manifest']) {
      await assert.rejects(
        verifySupplyPath(request, {
          source: 'authoritative',
          trustedFetchFn: transport({
            [`https://${OWNER}/.well-known/adagents.json`]: { authoritative_location: target },
          }),
        }),
        /Refusing/
      );
    }
  });
  it('fails closed on oversized, malformed, mislabeled, and chained documents', async () => {
    const target = 'https://cdn.example/manifest.json';
    for (const document of [
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify(input().ownerManifest), { headers: { 'content-type': 'text/html' } }),
      { authoritative_location: target, authorized_agents: [] },
      { authorized_agents: 'all' },
    ]) {
      const result = await verifySupplyPath(request, {
        source: 'authoritative',
        trustedFetchFn: transport({
          [`https://${OWNER}/.well-known/adagents.json`]: document,
          [target]: { authoritative_location: 'https://next.example/' },
        }),
      });
      assert.equal(result.state, 'unverified');
    }
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      maxBodyBytes: 20,
      trustedFetchFn: transport(),
    });
    assert.equal(result.state, 'unverified');
    assert.ok(result.sources.evidence.some(e => e.error === 'body_exceeds_limit'));
  });
  it('validates domains, IDs, bounds, and caller cancellation before network access', async () => {
    const trustedFetchFn = () => {
      throw new Error('unexpected fetch');
    };
    for (const owner_domain of [
      'https://host.example/path',
      'x.example@internal',
      'x.example:444',
      '127.0.0.1',
      'a..example',
    ])
      await assert.rejects(
        verifySupplyPath({ ...request, owner_domain }, { source: 'authoritative', trustedFetchFn }),
        TypeError
      );
    for (const timeoutMs of [0, -1, NaN, Infinity, 60001])
      await assert.rejects(
        verifySupplyPath(request, { source: 'authoritative', timeoutMs, trustedFetchFn }),
        TypeError
      );
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        signal: AbortSignal.abort(new Error('cancelled')),
        trustedFetchFn,
      }),
      /cancelled/
    );
  });
});

describe('registry wrapper and product discovery annotations', () => {
  it('posts only the canonical request and preserves registry evidence', async () => {
    const response = {
      ...request,
      ...evaluateSupplyPath(input()),
      sources: {
        owner_adagents_url: 'https://owner.example/',
        host_adagents_url: 'https://host.example/',
        cached: true,
      },
      checked_at: '2026-09-14T00:00:00Z',
      extension: 'preserved',
    };
    const registry = new RegistryClient({
      apiKey: '',
      fetch: async (url, init) => {
        assert.equal(url, 'https://agenticadvertising.org/api/registry/verify/supply-path');
        assert.deepEqual(JSON.parse(init.body), request);
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.deepEqual(await verifySupplyPath(request, { source: 'registry', registry }), response);
  });
  it('annotates external selectors, deduplicates calls, and removes forged seller verdicts', async () => {
    const product = {
      product_id: 'actual-seller-product',
      publisher_properties: [{ publisher_domain: HOST, selection_type: 'all' }],
      collections: [{ publisher_domain: OWNER, collection_ids: ['retro_news'] }],
      supply_path_state: 'unverified',
    };
    const calls = [];
    const result = await annotateProductsSupplyPaths([product, product], AGENT, {
      source: 'authoritative',
      trustedFetchFn: transport({}, calls),
    });
    assert.equal(result[0].supply_path_state, 'verified_owner_sold');
    assert.equal(result[0].supply_path_verification.scope, 'product_properties');
    assert.equal(calls.length, 2);
    assert.equal(product.supply_path_state, 'unverified');
    assert.equal(result.length, 2);
    const invalid = await annotateProductsSupplyPaths(
      [{ ...product, collections: [{ publisher_domain: OWNER }] }],
      AGENT
    );
    assert.equal(invalid[0].supply_path_state, 'unverified');
    assert.deepEqual(invalid[0].supply_path_verification.errors, ['invalid_product_selectors']);
    assert.deepEqual(await annotateProductsSupplyPaths([], AGENT), []);
  });
});

describe('bounded evidence and complete product scope', () => {
  it('bounds a stalled transport and a stalled response body even if the egress hook ignores abort', async () => {
    for (const trustedFetchFn of [
      () => new Promise(() => {}),
      async () =>
        new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
          headers: { 'content-type': 'application/json' },
        }),
    ]) {
      await assert.rejects(
        verifySupplyPath(request, { source: 'authoritative', timeoutMs: 30, trustedFetchFn }),
        /deadline/
      );
    }
  });
  it('keeps concurrent owner and host pointer provenance associated with the correct response', async () => {
    const ownerTarget = 'https://cdn.example/owner.json';
    const hostTarget = 'https://cdn.example/host.json';
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({
        [`https://${OWNER}/.well-known/adagents.json`]: { authoritative_location: ownerTarget },
        [`https://${HOST}/.well-known/adagents.json`]: { authoritative_location: hostTarget },
        [ownerTarget]: input().ownerManifest,
        [hostTarget]: input().hostManifest,
      }),
    });
    for (const [publisher, target] of [
      [OWNER, ownerTarget],
      [HOST, hostTarget],
    ]) {
      const pointer = result.sources.evidence.find(
        e => e.publisher_domain === publisher && e.requested_url.endsWith('/.well-known/adagents.json')
      );
      assert.equal(pointer.delegated_to, target);
    }
  });
  it('honors superseded_by without accepting stale grants or chained delegation', async () => {
    const target = 'https://cdn.example/new.json';
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({
        [`https://${OWNER}/.well-known/adagents.json`]: { ...input().ownerManifest, superseded_by: target },
        [target]: { authorized_agents: [], collections: [] },
      }),
    });
    assert.equal(result.state, 'unverified');
  });
  it('uses only applicable IAB files and reports deliberately skipped evidence', async () => {
    const calls = [];
    const fixture = input();
    fixture.hostManifest.authorized_agents = [];
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport(
        {
          [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest,
          [`https://${HOST}/ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
            headers: { 'content-type': 'text/plain' },
          }),
        },
        calls
      ),
    });
    assert.equal(result.state, 'owner_attested');
    assert.equal(result.legs.inventory_partner_domain.failure, 'not_declared');
    assert.ok(!calls.some(c => c.url.endsWith('/ads.txt')));
    const verified = await verifySupplyPath(request, { source: 'authoritative', trustedFetchFn: transport() });
    assert.equal(verified.legs.inventory_partner_domain.failure, 'not_evaluated');
  });
  it('deduplicates evidence across different paths without reusing a different product property verdict', async () => {
    const product = {
      product_id: 'seller-product',
      publisher_properties: [{ publisher_domain: HOST, selection_type: 'by_id', property_ids: ['hoststream_ctv'] }],
      collections: [{ publisher_domain: OWNER, collection_ids: ['retro_news'] }],
    };
    const calls = [];
    const result = await annotateProductsSupplyPaths(
      [
        product,
        {
          ...product,
          publisher_properties: [{ publisher_domain: HOST, selection_type: 'by_id', property_ids: ['missing'] }],
        },
      ],
      AGENT,
      { source: 'authoritative', trustedFetchFn: transport({}, calls) }
    );
    assert.equal(result[0].supply_path_state, 'verified_owner_sold');
    assert.equal(result[1].supply_path_state, 'owner_attested');
    assert.equal(calls.filter(c => c.url.endsWith('/.well-known/adagents.json')).length, 2);
  });
  it('does not discard an unresolved selector alongside a valid selector', async () => {
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport(),
      propertySelectors: [
        { publisher_domain: HOST, selection_type: 'by_id', property_ids: ['hoststream_ctv'] },
        { publisher_domain: HOST, selection_type: 'by_tag', property_tags: ['missing'] },
      ],
    });
    assert.equal(result.state, 'owner_attested');
  });
  it('holds revocations across refreshes and scopes them to the publisher authority', async () => {
    const revocationStore = new sdk.InMemorySupplyPathRevocationStore();
    const revoked = input().hostManifest;
    revoked.revoked_publisher_domains = [{ publisher_domain: OWNER, revoked_at: '2026-09-01T00:00:00Z' }];
    const first = await verifySupplyPath(request, {
      source: 'authoritative',
      revocationStore,
      trustedFetchFn: transport({ [`https://${HOST}/.well-known/adagents.json`]: revoked }),
    });
    assert.equal(first.state, 'owner_attested');
    const stale = await verifySupplyPath(request, {
      source: 'authoritative',
      revocationStore,
      trustedFetchFn: transport(),
    });
    assert.equal(stale.state, 'owner_attested');
    assert.equal(stale.sources.held_revocations.find(r => r.authority === HOST).entries[0].publisher_domain, OWNER);
    assert.deepEqual(await revocationStore.observe('unrelated.example', []), []);
  });
  it('propagates revocation storage failures instead of dropping the hold', async () => {
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        trustedFetchFn: transport(),
        revocationStore: {
          observe: async () => {
            throw new Error('storage unavailable');
          },
        },
      }),
      /storage unavailable/
    );
  });
  it('rejects older registry semantics and inconsistent verified legs while preserving new diagnostic strings', async () => {
    const response = {
      ...request,
      ...evaluateSupplyPath(input()),
      sources: { owner_adagents_url: `https://${OWNER}/`, host_adagents_url: `https://${HOST}/`, cached: true },
      checked_at: new Date().toISOString(),
    };
    const registry = value =>
      new RegistryClient({
        fetch: async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }),
      });
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'registry',
        registry: registry({ ...response, semantics_version: undefined }),
      }),
      /Invalid registry/
    );
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'registry',
        registry: registry({
          ...response,
          legs: { ...response.legs, owner_distribution_carriage: { ok: false, failure: 'property_ids_unresolved' } },
        }),
      }),
      /Invalid registry/
    );
    const extended = {
      ...response,
      state: 'owner_attested',
      legs: { ...response.legs, host_authorization: { ok: false, failure: 'future_diagnostic' } },
    };
    assert.deepEqual(await verifySupplyPath(request, { source: 'registry', registry: registry(extended) }), extended);
  });
});

describe('review regressions at state and deadline boundaries', () => {
  it('enforces retained revocations when the next host manifest cannot be fetched', async () => {
    const revocationStore = new sdk.InMemorySupplyPathRevocationStore();
    await revocationStore.observe(HOST, [{ publisher_domain: OWNER, revoked_at: '2026-09-01T00:00:00Z' }]);
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      revocationStore,
      trustedFetchFn: transport({
        [`https://${HOST}/.well-known/adagents.json`]: new Response('unavailable', { status: 503 }),
        [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
          headers: { 'content-type': 'text/plain' },
        }),
      }),
    });
    assert.equal(result.state, 'owner_attested');
    assert.equal(result.legs.host_authorization.failure, 'manifest_not_found');
    assert.equal(result.sources.held_revocations.find(r => r.authority === HOST).entries.length, 1);
  });
  it('bounds durable revocation storage by the same overall deadline', async () => {
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        timeoutMs: 30,
        trustedFetchFn: transport(),
        revocationStore: { observe: () => new Promise(() => {}) },
      }),
      /deadline/
    );
  });
  it('selects the strongest domain-level path using each collection applicable IAB evidence', async () => {
    const corpus = JSON.parse(readFileSync(require.resolve('../fixtures/supply-path/vectors.json'), 'utf8'));
    const fixture = corpus.vectors.find(v => v.id === 'domain-level-iab-per-complete-collection').input;
    const result = await verifySupplyPath(
      { owner_domain: OWNER, host_domain: HOST, agent_url: AGENT },
      {
        source: 'authoritative',
        trustedFetchFn: transport({
          [`https://${OWNER}/.well-known/adagents.json`]: fixture.ownerManifest,
          [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest,
          [`https://${HOST}/ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
            headers: { 'content-type': 'text/plain' },
          }),
        }),
      }
    );
    assert.equal(result.state, 'host_delegated');
    assert.equal(result.resolved_collection_id, 'web_channel');
  });
});

it('bulk fetching preserves untyped collection fallback alongside a typed website collection', async () => {
  const corpus = JSON.parse(readFileSync(require.resolve('../fixtures/supply-path/vectors.json'), 'utf8'));
  const fixture = corpus.ads_txt_policy_vectors.find(
    v => v.id === 'bulk-fetch-includes-untyped-collection-fallback'
  ).input;
  const calls = [];
  const result = await verifySupplyPath(
    { owner_domain: OWNER, host_domain: HOST, agent_url: AGENT },
    {
      source: 'authoritative',
      trustedFetchFn: transport(
        {
          [`https://${OWNER}/.well-known/adagents.json`]: fixture.ownerManifest,
          [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest,
          [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
            headers: { 'content-type': 'text/plain' },
          }),
        },
        calls
      ),
    }
  );
  assert.equal(result.state, 'host_delegated');
  assert.equal(result.resolved_collection_id, 'retro_news');
  assert.ok(calls.some(c => c.url.endsWith('/app-ads.txt')));
});

it('does not turn a malformed revocation list containing a valid denial into host delegation', async () => {
  const host = input().hostManifest;
  host.revoked_publisher_domains = [{ publisher_domain: OWNER, revoked_at: '2026-09-01T00:00:00Z' }, {}];
  await assert.rejects(
    verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({
        [`https://${HOST}/.well-known/adagents.json`]: host,
        [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
          headers: { 'content-type': 'text/plain' },
        }),
      }),
    }),
    /Invalid publisher revocation evidence/
  );
});
