const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const sdk = require('../../dist/lib');
const {
  evaluateSupplyPath,
  verifySupplyPath: verifySupplyPathSdk,
  parseInventoryPartnerDomains,
  annotateProductsSupplyPaths,
  RegistryClient,
} = sdk;
const verifySupplyPath = (request, options = { source: 'authoritative' }) =>
  verifySupplyPathSdk(
    request,
    options.source === 'registry' ? options : { authorityStore: new sdk.InMemorySupplyPathAuthorityStore(), ...options }
  );
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
      authorized_agents: [
        {
          url: AGENT,
          authorized_for: 'Owner avails',
          authorization_type: 'property_ids',
          property_ids: ['owner_property'],
          collections: [{ publisher_domain: OWNER }],
        },
      ],
      collections: [
        {
          collection_id: 'retro_news',
          publisher_domain: OWNER,
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

describe('authority and revocation trust boundaries', () => {
  it('never lets a storage adapter erase a freshly observed denial', async () => {
    const fixture = input();
    fixture.hostManifest.revoked_publisher_domains = [{ publisher_domain: OWNER, revoked_at: '2026-09-01T00:00:00Z' }];
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      revocationStore: { observe: async () => [] },
      trustedFetchFn: transport({ [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest }),
    });
    assert.equal(result.state, 'owner_attested');
    assert.equal(result.sources.held_revocations.find(r => r.authority === HOST).entries[0].publisher_domain, OWNER);
  });
  for (const publisher of [undefined, 'other.example', HOST]) {
    it(`requires explicit matching host attribution in a shared authoritative document (${publisher})`, async () => {
      const fixture = input();
      fixture.hostManifest.properties[0].publisher_domain = publisher;
      const result = await verifySupplyPath(request, {
        source: 'authoritative',
        trustedFetchFn: transport({
          [`https://${HOST}/.well-known/adagents.json`]: { authoritative_location: 'https://cdn.example/host.json' },
          'https://cdn.example/host.json': fixture.hostManifest,
        }),
      });
      assert.equal(result.state, publisher === HOST ? 'verified_owner_sold' : 'owner_attested');
    });
  }
  it('refuses changed authority locations before fetching them and supports independently approved migrations', async () => {
    const authorityStore = new sdk.InMemorySupplyPathAuthorityStore();
    const fixture = input();
    fixture.hostManifest.properties[0].publisher_domain = HOST;
    const verify = (location, requests = []) =>
      verifySupplyPath(request, {
        source: 'authoritative',
        authorityStore,
        trustedFetchFn: transport(
          {
            [`https://${HOST}/.well-known/adagents.json`]: { authoritative_location: location },
            [location]: fixture.hostManifest,
          },
          requests
        ),
      });
    assert.equal((await verify('https://cdn.example/host.json')).state, 'verified_owner_sold');
    const requests = [];
    await assert.rejects(verify('https://changed.example/host.json', requests), /Authoritative location changed/);
    assert.equal(
      requests.some(r => r.url === 'https://changed.example/host.json'),
      false
    );
    authorityStore.approveChange(HOST, 'https://changed.example/host.json');
    assert.equal((await verify('https://changed.example/host.json')).state, 'verified_owner_sold');
  });
  it('bounds authority persistence by the overall deadline', async () => {
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        timeoutMs: 25,
        authorityStore: { check: () => new Promise(() => {}), observe: async () => true },
        trustedFetchFn: transport(),
      }),
      /deadline|abort/i
    );
  });
  it('validates custom registry adapters and the concrete winning collection', async () => {
    const valid = {
      ...request,
      ...evaluateSupplyPath(input()),
      checked_at: new Date().toISOString(),
      sources: {
        owner_fetched_at: new Date().toISOString(),
        host_fetched_at: new Date().toISOString(),
        owner_resolved_url: null,
        host_resolved_url: null,
        cached: true,
        owner_adagents_url: `https://${OWNER}/.well-known/adagents.json`,
        host_adagents_url: `https://${HOST}/.well-known/adagents.json`,
      },
    };
    for (const patch of [
      { legs: {} },
      { resolved_collection_id: undefined },
      { resolved_collection_id: 42 },
      { resolved_collection_id: 'other' },
    ]) {
      await assert.rejects(
        verifySupplyPath(request, {
          source: 'registry',
          registry: { verifySupplyPath: async () => ({ ...valid, ...patch }) },
        }),
        /Invalid registry/
      );
    }
    for (const malformed of [
      { owner_fetched_at: undefined },
      { host_fetched_at: 12345 },
      { owner_resolved_url: 'http://owner.example/' },
      { host_resolved_url: {} },
    ]) {
      await assert.rejects(
        verifySupplyPath(request, {
          source: 'registry',
          registry: { verifySupplyPath: async () => ({ ...valid, sources: { ...valid.sources, ...malformed } }) },
        }),
        /Invalid registry/
      );
    }
    assert.deepEqual(
      await verifySupplyPath(request, { source: 'registry', registry: { verifySupplyPath: async () => valid } }),
      valid
    );
  });
});

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
  it('rejects malformed host inline property grants', () => {
    const evidence = input();
    const grant = evidence.hostManifest.authorized_agents[0];
    grant.authorization_type = 'inline_properties';
    delete grant.property_ids;
    grant.properties = [{ property_id: 'hoststream_ctv' }];
    const result = evaluateSupplyPath(evidence);
    assert.equal(result.state, 'owner_attested');
    assert.equal(result.legs.host_authorization.failure, 'property_scope_mismatch');
  });
  it('does not accept legacy discovery-only identifier aliases as property authorization', () => {
    for (const identifierType of [
      'amazon_app_store_id',
      'lg_channel_id',
      'vizio_app_id',
      'fire_tv_app_id',
      'dooh_venue_id',
      'podcast_rss_feed',
      'spotify_show_id',
      'iab_tech_lab_domain_id',
      'custom',
    ]) {
      const evidence = input();
      evidence.hostManifest.authorized_agents = [];
      evidence.hostInventoryPartnerDomains = [OWNER];
      const grant = evidence.ownerManifest.authorized_agents[0];
      grant.authorization_type = 'inline_properties';
      delete grant.property_ids;
      grant.properties = [
        {
          property_id: 'legacy_alias',
          property_type: 'ctv_app',
          name: 'Legacy alias',
          identifiers: [{ type: identifierType, value: 'anything' }],
        },
      ];
      const result = evaluateSupplyPath(evidence);
      assert.equal(result.state, 'owner_attested');
      assert.equal(result.legs.owner_agent_declared.failure, 'agent_not_declared_by_owner');
    }
  });
  for (const authorizationType of ['property_ids', 'property_tags', 'publisher_properties']) {
    it(`rejects malformed top-level properties for ${authorizationType} grants`, () => {
      const evidence = input();
      evidence.hostManifest.properties[0] = {
        property_id: 'hoststream_ctv',
        tags: ['ctv'],
      };
      const grant = evidence.hostManifest.authorized_agents[0];
      grant.authorization_type = authorizationType;
      delete grant.property_ids;
      if (authorizationType === 'property_ids') grant.property_ids = ['hoststream_ctv'];
      if (authorizationType === 'property_tags') grant.property_tags = ['ctv'];
      if (authorizationType === 'publisher_properties') {
        grant.publisher_properties = [{ publisher_domain: HOST, selection_type: 'all' }];
      }
      const result = evaluateSupplyPath(evidence);
      assert.equal(result.state, 'owner_attested');
      assert.equal(result.legs.owner_distribution_carriage.failure, 'property_ids_unresolved');
    });
  }
  for (const [selection_type, field] of [
    ['by_id', 'property_ids'],
    ['by_tag', 'property_tags'],
  ]) {
    it(`rejects malformed owner publisher_properties ${selection_type} elements`, () => {
      const evidence = input();
      evidence.hostManifest.authorized_agents = [];
      evidence.hostInventoryPartnerDomains = [OWNER];
      const grant = evidence.ownerManifest.authorized_agents[0];
      grant.authorization_type = 'publisher_properties';
      delete grant.property_ids;
      grant.publisher_properties = [{ publisher_domain: OWNER, selection_type, [field]: [null] }];
      const result = evaluateSupplyPath(evidence);
      assert.equal(result.state, 'owner_attested');
      assert.equal(result.legs.owner_agent_declared.failure, 'agent_not_declared_by_owner');
    });
  }
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
  it('preserves a sanitized transport cause code in unavailable evidence', async () => {
    const failure = new Error('internal address and TLS details');
    failure.code = 'ECONNREFUSED';
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: async () => {
        throw failure;
      },
    });
    assert.equal(result.state, 'unverified');
    assert.ok(result.sources.evidence.length > 0);
    assert.ok(result.sources.evidence.every(item => item.error === 'fetch_failed'));
    assert.ok(result.sources.evidence.every(item => item.cause_code === 'ECONNREFUSED'));
    assert.ok(result.sources.evidence.every(item => !JSON.stringify(item).includes('internal address')));
  });
  it('rejects oversized authority pointers before fetching or retaining them', async () => {
    const oversized = `https://cdn.example/${'x'.repeat(8192)}`;
    const calls = [];
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport(
        { [`https://${OWNER}/.well-known/adagents.json`]: { authoritative_location: oversized } },
        calls
      ),
    });
    assert.equal(result.state, 'unverified');
    assert.equal(
      calls.some(call => call.url === oversized),
      false
    );
    const store = new sdk.InMemorySupplyPathAuthorityStore();
    await assert.rejects(store.check(OWNER, oversized), /1 to 8192 characters/);
    await assert.rejects(store.observe(OWNER, oversized), /1 to 8192 characters/);
    assert.throws(() => store.approveChange(OWNER, oversized), /1 to 8192 characters/);
  });
});

describe('registry wrapper and product discovery annotations', () => {
  it('posts only the canonical request and preserves registry evidence', async () => {
    const response = {
      ...request,
      ...evaluateSupplyPath(input()),
      sources: {
        owner_fetched_at: new Date().toISOString(),
        host_fetched_at: new Date().toISOString(),
        owner_resolved_url: null,
        host_resolved_url: null,
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
    assert.deepEqual(invalid[0].supply_path_verification.errors, ['invalid_collection_selector']);
    assert.deepEqual(await annotateProductsSupplyPaths([], AGENT), []);
  });
  it('rejects predicates that conflict with selection_type before evidence retrieval', async () => {
    const conflicting = {
      publisher_domain: HOST,
      selection_type: 'all',
      property_ids: ['unapproved_property'],
    };
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        propertySelectors: [conflicting],
        trustedFetchFn: () => {
          throw new Error('unexpected fetch');
        },
      }),
      /conflicts with selection_type/
    );
    const calls = [];
    const [annotated] = await annotateProductsSupplyPaths(
      [
        {
          product_id: 'conflicting-selector',
          publisher_properties: [conflicting],
          collections: [{ publisher_domain: OWNER, collection_ids: ['retro_news'] }],
        },
      ],
      AGENT,
      { source: 'authoritative', trustedFetchFn: transport({}, calls) }
    );
    assert.deepEqual(annotated.supply_path_verification.errors, ['invalid_product_selector_predicate']);
    assert.equal(calls.length, 0);
  });
  it('reports an invalid agent URL independently of product selectors', async () => {
    await assert.rejects(annotateProductsSupplyPaths([], 'not-a-url'), /agentUrl must be an HTTPS URL/);
  });
  it('deduplicates repeated selectors before path expansion', async () => {
    const propertySelector = { publisher_domain: HOST, selection_type: 'all' };
    const collectionSelector = { publisher_domain: OWNER, collection_ids: ['retro_news', 'retro_news'] };
    const calls = [];
    const [result] = await annotateProductsSupplyPaths(
      [
        {
          product_id: 'duplicate-selectors',
          publisher_properties: Array.from({ length: 128 }, () => ({ ...propertySelector })),
          collections: Array.from({ length: 128 }, () => ({ ...collectionSelector })),
        },
      ],
      AGENT,
      { source: 'authoritative', trustedFetchFn: transport({}, calls) }
    );
    assert.equal(result.supply_path_state, 'verified_owner_sold');
    assert.equal(result.supply_path_verification.paths.length, 1);
    assert.equal(calls.length, 2);
  });
  it('rejects compact selector byte amplification before allocating path keys', async () => {
    const startedAt = Date.now();
    const [result] = await annotateProductsSupplyPaths(
      [
        {
          product_id: 'compact-amplification',
          publisher_properties: [
            {
              publisher_domains: Array.from({ length: 1024 }, (_, index) => `host${index}.example`),
              selection_type: 'by_tag',
              property_tags: Array.from({ length: 128 }, (_, index) => `tag_${index}_${'a'.repeat(1000)}`),
            },
          ],
          collections: [{ publisher_domain: OWNER, collection_ids: ['retro_news'] }],
        },
      ],
      AGENT,
      {
        source: 'authoritative',
        timeoutMs: 50,
        trustedFetchFn: () => {
          throw new Error('unexpected fetch');
        },
      }
    );
    assert.deepEqual(result.supply_path_verification.errors, ['selector_work_limit_exceeded']);
    assert.ok(Date.now() - startedAt < 500, 'preprocessing should reject without predicate duplication');
  });
  it('validates evidence-session options before allocating batch timers', async () => {
    const before = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
    await assert.rejects(
      annotateProductsSupplyPaths([], AGENT, { source: 'authoritative', maxBodyBytes: 0 }),
      /maxBodyBytes/
    );
    const after = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
    assert.equal(after, before);
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
  it('accepts a schema-valid empty property tag list for an unrelated by-id scope', async () => {
    const fixture = input();
    fixture.hostManifest.properties[0].tags = [];
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      trustedFetchFn: transport({ [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest }),
      propertySelectors: [{ publisher_domain: HOST, selection_type: 'by_id', property_ids: ['hoststream_ctv'] }],
    });
    assert.equal(result.state, 'verified_owner_sold');
  });
  it('fails closed before selector and property tags can multiply synchronous work', async () => {
    const fixture = input();
    fixture.hostManifest.properties[0].tags = Array.from({ length: 1024 }, (_, index) => `host_${index}`);
    const propertySelectors = Array.from({ length: 40 }, (_, selector) => ({
      publisher_domain: HOST,
      selection_type: 'by_tag',
      property_tags: Array.from({ length: 1024 }, (_, tag) => `selector_${selector}_${tag}`),
    }));
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      timeoutMs: 200,
      trustedFetchFn: transport({ [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest }),
      propertySelectors,
    });
    assert.equal(result.state, 'unverified');
    assert.equal(result.legs.host_authorization.failure, 'evaluation_limit_exceeded');
  });
  it('enforces its absolute deadline even before the timer callback can run', () => {
    const { SupplyPathEvidenceSession } = require('../../dist/lib/supply-path/fetch-evidence');
    const session = new SupplyPathEvidenceSession({ source: 'authoritative', timeoutMs: 1 });
    const until = Date.now() + 5;
    while (Date.now() < until) {
      // Deliberately occupy the event loop so only the absolute check can observe expiry.
    }
    assert.throws(() => session.assertActive(), /deadline/i);
    session.close();
  });
  for (const selectionType of ['all', 'by_tag']) {
    it(`fails closed when a ${selectionType} selector includes a property without property_id`, async () => {
      const fixture = input();
      fixture.hostManifest.properties[0].tags = ['selected'];
      fixture.hostManifest.properties.push({
        property_type: 'website',
        name: 'Unaddressable property',
        identifiers: [{ type: 'domain', value: 'extra.example' }],
        tags: ['selected'],
      });
      const selector = {
        publisher_domain: HOST,
        selection_type: selectionType,
        ...(selectionType === 'by_tag' ? { property_tags: ['selected'] } : {}),
      };
      const result = await verifySupplyPath(request, {
        source: 'authoritative',
        trustedFetchFn: transport({ [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest }),
        propertySelectors: [selector],
      });
      assert.equal(result.state, 'owner_attested');
      assert.equal(result.legs.host_authorization.failure, 'property_scope_mismatch');
    });
  }
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
      /revocation storage failed/
    );
  });
  it('rejects older registry semantics and inconsistent verified legs while preserving new diagnostic strings', async () => {
    const response = {
      ...request,
      ...evaluateSupplyPath(input()),
      sources: {
        owner_fetched_at: new Date().toISOString(),
        host_fetched_at: new Date().toISOString(),
        owner_resolved_url: null,
        host_resolved_url: null,
        owner_adagents_url: `https://${OWNER}/`,
        host_adagents_url: `https://${HOST}/`,
        cached: true,
      },
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
  // The policy vector isolates file selection and intentionally omits a complete
  // owner grant. Supply one here so this integration assertion measures the
  // fetched inventory-partner fallback rather than owner-grant validation.
  fixture.ownerManifest.authorized_agents[0].authorization_type = 'property_ids';
  fixture.ownerManifest.authorized_agents[0].property_ids = ['owner_property'];
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
    /Invalid revoked_publisher_domains in adagents\.json for hoststream\.example/
  );
});

// An invalid affirmative list must not discard independently meaningful denials.
it('retains fresh revocations from a host document missing authorized_agents', async () => {
  const result = await verifySupplyPath(request, {
    source: 'authoritative',
    revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
    trustedFetchFn: transport({
      [`https://${HOST}/.well-known/adagents.json`]: { revoked_publisher_domains: [OWNER] },
      [`https://${HOST}/ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
        headers: { 'content-type': 'text/plain' },
      }),
      [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
        headers: { 'content-type': 'text/plain' },
      }),
    }),
  });
  assert.equal(result.state, 'owner_attested');
  assert.equal(result.sources.held_revocations.find(r => r.authority === HOST).entries[0].publisher_domain, OWNER);
});

it('isolates a single publisher authority from consuming the global revocation capacity', async () => {
  const store = new sdk.InMemorySupplyPathRevocationStore();
  const revoked = Array.from({ length: 1024 }, (_, i) => ({
    publisher_domain: `publisher-${i}.example`,
    revoked_at: '2026-09-01T00:00:00Z',
  }));
  await store.observe('attacker.example', revoked);
  await assert.rejects(
    store.observe('attacker.example', [{ publisher_domain: 'next.example', revoked_at: '2026-09-02T00:00:00Z' }]),
    /authority revocation capacity/
  );
  assert.equal((await store.observe('attacker.example', [])).length, 1024);
  assert.deepEqual(
    await store.observe('innocent.example', [{ publisher_domain: OWNER, revoked_at: '2026-09-02T00:00:00Z' }]),
    [{ publisher_domain: OWNER, revoked_at: '2026-09-02T00:00:00Z' }]
  );
});

it('rate-bounds many-authority admission and retains all live default-store evidence at capacity', () => {
  // A separate process exercises the actual module defaults without poisoning
  // the other verification tests' process-wide stores.
  const { execFileSync } = require('node:child_process');
  execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    let now = Date.parse('2026-09-01T00:00:00Z');
    Date.now = () => now;
    const { defaultSupplyPathRevocations: revocations, defaultSupplyPathAuthorities: pins } = require(${JSON.stringify(require.resolve('../../dist/lib/supply-path/revocations'))});
    const denial = [{ publisher_domain: 'owner.example', revoked_at: '2026-09-01T00:00:00Z' }];
    (async () => {
      for (let i = 0; i < 10000; i++) {
        if (i > 0 && i % 128 === 0) {
          await assert.rejects(revocations.observe('rate-blocked.attacker.example', denial), /admission rate/);
          await assert.rejects(pins.observe('rate-blocked.attacker.example', 'https://cdn.example/blocked.json'), /admission rate/);
          // Existing evidence remains readable during an admission-rate refusal.
          assert.deepEqual(await revocations.observe('host-0.attacker.example', []), denial);
          assert.equal(await pins.check('host-0.attacker.example', 'https://cdn.example/0.json'), true);
          now += 60001;
        }
        const authority = 'host-' + i + '.attacker.example';
        await revocations.observe(authority, denial);
        await pins.observe(authority, 'https://cdn.example/' + i + '.json');
      }
      now += 60001;
      await assert.rejects(revocations.observe('innocent.example', denial), /capacity exceeded/);
      await assert.rejects(pins.observe('innocent.example', 'https://innocent.example/adagents.json'), /capacity exceeded/);
      // Scan every retained authority: neither rate limiting nor total exhaustion
      // may evict a live denial or adopt a different pinned location.
      for (let i = 0; i < 10000; i++) {
        const authority = 'host-' + i + '.attacker.example';
        assert.deepEqual(await revocations.observe(authority, []), denial);
        assert.equal(await pins.check(authority, 'https://cdn.example/' + i + '.json'), true);
        assert.equal(await pins.check(authority, 'https://attacker.example/replacement'), false);
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { timeout: 60000, stdio: 'pipe' }
  );
});

it('retains denials in an ambiguous pointer envelope before considering IAB evidence', async () => {
  const result = await verifySupplyPath(request, {
    source: 'authoritative',
    revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
    trustedFetchFn: transport({
      [`https://${HOST}/.well-known/adagents.json`]: {
        authoritative_location: 'https://cdn.example/host.json',
        authorized_agents: [],
        revoked_publisher_domains: [OWNER],
      },
      [`https://${HOST}/ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
        headers: { 'content-type': 'text/plain' },
      }),
      [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
        headers: { 'content-type': 'text/plain' },
      }),
    }),
  });
  assert.equal(result.state, 'owner_attested');
  assert.equal(result.sources.held_revocations.find(r => r.authority === HOST).entries[0].publisher_domain, OWNER);
});

it('holds from first observation across changed timestamps and expires at the exact boundary', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-01T00:00:00Z') });
  const store = new sdk.InMemorySupplyPathRevocationStore();
  await store.observe(HOST, [{ publisher_domain: OWNER, revoked_at: '2026-09-01T00:00:00Z' }]);
  t.mock.timers.tick(6 * 86400000);
  await store.observe(HOST, [
    { publisher_domain: OWNER, revoked_at: '2026-09-07T00:00:00Z' },
    { publisher_domain: 'new.example', revoked_at: '2026-09-07T00:00:00Z' },
  ]);
  t.mock.timers.tick(86400000 - 1);
  assert.equal((await store.observe(HOST, [])).length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(
    (await store.observe(HOST, [])).map(r => r.publisher_domain),
    ['new.example']
  );
});

it('requires explicit owner attribution before a shared document can declare a collection', async () => {
  for (const publisher of [undefined, 'other-owner.example', OWNER]) {
    const fixture = input();
    fixture.ownerManifest.collections[0].publisher_domain = publisher;
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
      trustedFetchFn: transport({
        [`https://${OWNER}/.well-known/adagents.json`]: {
          authoritative_location: 'https://cdn.example/shared-owner.json',
        },
        'https://cdn.example/shared-owner.json': fixture.ownerManifest,
        [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
          headers: { 'content-type': 'text/plain' },
        }),
      }),
    });
    assert.equal(result.state, publisher === OWNER ? 'verified_owner_sold' : 'unverified');
  }
});

it('does not borrow an unscoped owner agent grant from a shared catalog through inventory-partner evidence', async () => {
  const fixture = input();
  delete fixture.ownerManifest.authorized_agents[0].collections;
  fixture.hostManifest.authorized_agents = [];
  const result = await verifySupplyPath(request, {
    source: 'authoritative',
    revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
    trustedFetchFn: transport({
      [`https://${OWNER}/.well-known/adagents.json`]: {
        authoritative_location: 'https://cdn.example/shared-owner.json',
      },
      'https://cdn.example/shared-owner.json': fixture.ownerManifest,
      [`https://${HOST}/.well-known/adagents.json`]: fixture.hostManifest,
      [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
        headers: { 'content-type': 'text/plain' },
      }),
    }),
  });
  assert.equal(result.state, 'owner_attested');
  assert.equal(result.legs.owner_agent_declared.failure, 'agent_not_declared_by_owner');
});

it('records malformed pointers as unavailable evidence while retaining their denials', async () => {
  for (const location of [
    'not a URL',
    'http://example.com/host.json',
    'https://user:password@example.com/host.json',
    'https://cdn.example/host.json#',
  ]) {
    const store = new sdk.InMemorySupplyPathRevocationStore();
    const result = await verifySupplyPath(request, {
      source: 'authoritative',
      revocationStore: store,
      trustedFetchFn: transport({
        [`https://${HOST}/.well-known/adagents.json`]: {
          authoritative_location: location,
          revoked_publisher_domains: [OWNER],
        },
        [`https://${HOST}/ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
          headers: { 'content-type': 'text/plain' },
        }),
        [`https://${HOST}/app-ads.txt`]: new Response(`inventorypartnerdomain=${OWNER}`, {
          headers: { 'content-type': 'text/plain' },
        }),
      }),
    });
    assert.equal(result.state, 'owner_attested');
    assert.ok(result.sources.evidence.some(item => item.error === 'invalid_authoritative_location'));
    assert.deepEqual(
      (await store.observe(HOST, [])).map(item => item.publisher_domain),
      [OWNER]
    );
  }
});

describe('authority pins require a successfully validated manifest', () => {
  it('does not charge authority admission for more than 128 failed target fetches', async () => {
    const pins = new sdk.InMemorySupplyPathAuthorityStore();
    for (let i = 0; i < 129; i++) {
      const host = `failed-${i}.admission.example`;
      const target = `https://cdn.example/failed-${i}.json`;
      await verifySupplyPath(
        { ...request, host_domain: host },
        {
          source: 'authoritative',
          authorityStore: pins,
          revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
          trustedFetchFn: transport({
            [`https://${host}/.well-known/adagents.json`]: { authoritative_location: target },
            [target]: {},
          }),
        }
      );
      assert.equal(await pins.check(host, 'https://cdn.example/recovery.json'), true);
    }
    assert.equal(
      (
        await verifySupplyPath(request, {
          source: 'authoritative',
          authorityStore: pins,
          trustedFetchFn: transport(),
          revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
        })
      ).state,
      'verified_owner_sold'
    );
  });
  it('refuses an empty fragment without fetching or pinning its target', async () => {
    const pins = new sdk.InMemorySupplyPathAuthorityStore();
    const requests = [];
    const target = 'https://cdn.example/host.json#';
    await verifySupplyPath(request, {
      source: 'authoritative',
      authorityStore: pins,
      revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
      trustedFetchFn: transport(
        {
          [`https://${HOST}/.well-known/adagents.json`]: { authoritative_location: target },
          [target]: input().hostManifest,
        },
        requests
      ),
    });
    assert.equal(
      requests.some(item => item.url === target),
      false
    );
    assert.equal(await pins.check(HOST, 'https://cdn.example/recovery.json'), true);
    assert.equal(
      (
        await verifySupplyPath(request, {
          source: 'authoritative',
          authorityStore: pins,
          trustedFetchFn: transport(),
          revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
        })
      ).state,
      'verified_owner_sold'
    );
  });
  const failures = {
    unavailable: new Response('unavailable', { status: 503 }),
    malformed: new Response('{invalid JSON', { headers: { 'content-type': 'application/json' } }),
    missing_envelope: {},
    malformed_envelope: { authorized_agents: null },
    malformed_agent_entry: { authorized_agents: [null] },
    chained: { authoritative_location: 'https://chained.example/another.json' },
  };
  for (const [name, failedTarget] of Object.entries(failures)) {
    it(`does not poison the process default with a ${name} target`, async () => {
      const host = `${name.replaceAll('_', '-')}.first-pin.example`;
      const failed = `https://cdn.example/${name}-failed.json`;
      const valid = `https://cdn.example/${name}-valid.json`;
      const replacement = `https://cdn.example/${name}-replacement.json`;
      const fixture = input();
      fixture.ownerManifest.collections[0].distribution[0].publisher_domain = host;
      fixture.hostManifest.properties[0].publisher_domain = host;
      const verify = (location, contents, requests = []) =>
        verifySupplyPathSdk(
          { ...request, host_domain: host },
          {
            source: 'authoritative', // Exercise the actual default authority store.
            revocationStore: new sdk.InMemorySupplyPathRevocationStore(),
            trustedFetchFn: transport(
              {
                [`https://${OWNER}/.well-known/adagents.json`]: fixture.ownerManifest,
                [`https://${host}/.well-known/adagents.json`]: { authoritative_location: location },
                [location]: contents,
              },
              requests
            ),
          }
        );
      assert.equal((await verify(failed, failedTarget)).state, 'owner_attested');
      assert.equal(await sdk.defaultSupplyPathAuthorities.check(host, valid), true);
      assert.equal((await verify(valid, fixture.hostManifest)).state, 'verified_owner_sold');
      assert.equal(await sdk.defaultSupplyPathAuthorities.check(host, valid), true);
      assert.equal(await sdk.defaultSupplyPathAuthorities.check(host, replacement), false);
      const requests = [];
      await assert.rejects(
        verify(replacement, { revoked_publisher_domains: [OWNER] }, requests),
        /Authoritative location changed/
      );
      assert.equal(
        requests.some(item => item.url === replacement),
        false
      );
      // A failed refresh of the accepted location preserves its pin as well.
      assert.equal((await verify(valid, failedTarget)).state, 'owner_attested');
      assert.equal(await sdk.defaultSupplyPathAuthorities.check(host, replacement), false);
    });
  }
  it('does not pin a malformed publisher-origin envelope before a later valid pointer', async () => {
    const pins = new sdk.InMemorySupplyPathAuthorityStore();
    await verifySupplyPath(request, {
      source: 'authoritative',
      authorityStore: pins,
      trustedFetchFn: transport({ [`https://${HOST}/.well-known/adagents.json`]: {} }),
    });
    assert.equal(await pins.check(HOST, 'https://cdn.example/later.json'), true);
    assert.equal(await pins.observe(HOST, 'https://cdn.example/later.json'), true);
    assert.equal(await pins.check(HOST, `https://${HOST}/.well-known/adagents.json`), false);
  });
  it('atomically rejects a pin changed between precheck and successful observation', async () => {
    const pins = new sdk.InMemorySupplyPathAuthorityStore();
    const revocationStore = new sdk.InMemorySupplyPathRevocationStore();
    const fixture = input();
    fixture.hostManifest.properties[0].publisher_domain = HOST;
    const target = 'https://cdn.example/racing.json';
    const confirmed = 'https://operator-confirmed.example/host.json';
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        authorityStore: pins,
        revocationStore,
        trustedFetchFn: transport({
          [`https://${HOST}/.well-known/adagents.json`]: {
            authoritative_location: target,
            revoked_publisher_domains: [OWNER],
          },
          [target]: () => {
            pins.approveChange(HOST, confirmed);
            return new Response(JSON.stringify(fixture.hostManifest), {
              headers: { 'content-type': 'application/json' },
            });
          },
        }),
      }),
      /Authoritative location changed/
    );
    assert.equal(await pins.check(HOST, confirmed), true);
    assert.equal(await pins.check(HOST, target), false);
    const recovered = await verifySupplyPath(request, {
      source: 'authoritative',
      authorityStore: pins,
      revocationStore,
      trustedFetchFn: transport({
        [`https://${HOST}/.well-known/adagents.json`]: { authoritative_location: confirmed },
        [confirmed]: fixture.hostManifest,
      }),
    });
    assert.equal(recovered.state, 'owner_attested');
    assert.deepEqual(
      (await revocationStore.observe(HOST, [])).map(entry => entry.publisher_domain),
      [OWNER]
    );
  });
  for (const failure of ['throw', 'timeout']) {
    it(`retains a validated target denial when final authority observation fails by ${failure}`, async () => {
      const pins = new sdk.InMemorySupplyPathAuthorityStore();
      const revocationStore = new sdk.InMemorySupplyPathRevocationStore();
      const target = `https://cdn.example/observation-${failure}.json`;
      await pins.observe(HOST, target);
      let failing = true;
      const authorityStore = {
        check: (publisher, location) => pins.check(publisher, location),
        observe: (publisher, location) => {
          if (publisher === HOST && failing) {
            if (failure === 'timeout') return new Promise(() => {});
            throw new Error('authority backend unavailable');
          }
          return pins.observe(publisher, location);
        },
      };
      const fixture = input();
      fixture.hostManifest.properties[0].publisher_domain = HOST;
      const verify = manifest =>
        verifySupplyPath(request, {
          source: 'authoritative',
          authorityStore,
          revocationStore,
          timeoutMs: failing && failure === 'timeout' ? 25 : 1000,
          trustedFetchFn: transport({
            [`https://${HOST}/.well-known/adagents.json`]: { authoritative_location: target },
            [target]: manifest,
          }),
        });
      await assert.rejects(
        verify({ ...fixture.hostManifest, revoked_publisher_domains: [OWNER] }),
        /storage failed|deadline|abort/i
      );
      failing = false;
      assert.equal((await verify(fixture.hostManifest)).state, 'owner_attested');
      assert.deepEqual(
        (await revocationStore.observe(HOST, [])).map(entry => entry.publisher_domain),
        [OWNER]
      );
    });
  }
  it('bounds the successful-observation commit by the same overall deadline', async () => {
    await assert.rejects(
      verifySupplyPath(request, {
        source: 'authoritative',
        timeoutMs: 25,
        authorityStore: { check: async () => true, observe: () => new Promise(() => {}) },
        trustedFetchFn: transport(),
      }),
      /deadline|abort/i
    );
  });
});
