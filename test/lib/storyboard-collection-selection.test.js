/**
 * Collection foundation regressions: the shared domain-qualified pair
 * normalizer, the bounded eligibility predicate and its witnesses, and the
 * namespace-aware set validator — exercised through the public
 * `@adcp/sdk/testing` entry point and the real MCP transport.
 *
 * These are repaired expectations. The pre-change behavior of this tree is
 * recorded separately in `.context/baseline/baseline-8259-at-main.test.cjs`;
 * nothing here passes by observing an unresolved defect.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Adopter surface comes from the public barrel; the incidental helpers the
// barrel deliberately does not promote come from the deep path.
const {
  diffCollectionPairSets,
  evaluateCollectionSelection,
  normalizeCollectionSelectors,
  parseStoryboard,
  productSatisfiesCollectionSelection,
  readCollectionWitness,
  runStoryboard,
  runStoryboardStep,
} = require('../../dist/lib/testing/index.js');
const {
  compareCollectionPairs,
  formatCollectionPair,
  normalizeCollectionSelectionSelector,
  summarizeCollectionPairs,
} = require('../../dist/lib/testing/storyboard/collection-selection.js');

// ────────────────────────────────────────────────────────────
// Shared transport + storyboard scaffolding
// ────────────────────────────────────────────────────────────

const CAPS = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['brief', 'wholesale'] },
};
const TOOLS = ['get_adcp_capabilities', 'get_products', 'create_media_buy'];

function product(id, extra = {}) {
  return {
    product_id: id,
    name: 'Catalog offer',
    description: 'Seller-owned collection foundation offer.',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    channels: ['ctv'],
    delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [{ pricing_option_id: 'seller-price', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
    collections: [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 0,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
    ...extra,
  };
}

function transport(catalog, overrides = {}) {
  const calls = [];
  let reads = 0;
  const trustedFetchFn = async (_input, init = {}) => {
    const message = JSON.parse(init.body);
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'collection-selection-test', version: '1' },
      };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = {
        tools: TOOLS.map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request });
      let data;
      if (name === 'get_adcp_capabilities') data = CAPS;
      else if (name === 'get_products') {
        reads += 1;
        data = overrides.read?.(request, reads) ?? {
          status: 'completed',
          products: catalog,
          cache_scope: 'account',
          wholesale_feed_version: 'v1',
        };
      } else if (name === 'create_media_buy') {
        data = overrides.create?.(request) ?? {
          status: 'completed',
          media_buy_id: 'seller-buy',
          revision: 1,
          confirmed_at: '2026-10-19T00:00:00Z',
          packages: [],
        };
      } else throw new Error(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    options: {
      adcpVersion: '3.2.5',
      timeout_ms: 5000,
      profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
      transport: { trustedFetchFn },
    },
  };
}

const ENDPOINT = 'https://collection-selection-test.example/mcp';

function collectionPredicate(value) {
  return { path: '', operator: 'collection_selection_satisfies', value };
}

/** A non-mutating read step, for graphs that only need preparation to run. */
function catalogReadStep() {
  return {
    id: 'read',
    title: 'Read the catalog',
    task: 'get_products',
    stateful: false,
    sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
    validations: [{ check: 'response_schema', description: 'Schema holds' }],
  };
}

function board({ match, captures, phases, context, pricing }) {
  return {
    id: 'collection_foundation/selection',
    version: '1.0.0',
    category: 'media_buy_seller',
    title: 'Collection selection foundation',
    summary: 'Repaired expectations for the #8259 foundation.',
    narrative: 'Exercises the public runner end to end.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
    caller: { role: 'buyer_agent' },
    ...(context && { context }),
    fixtures: {
      products: [product('authored-product', { collection_targeting_allowed: true })],
      ...(pricing && {
        pricing_options: [
          { product_id: 'authored-product', pricing_option_id: 'authored-price', pricing_model: 'cpm' },
        ],
      }),
    },
    fixture_resolution: {
      products: [
        {
          handle: 'authored-product',
          strategies: ['discover'],
          match: match ?? [collectionPredicate({ collection_targeting: 'any' })],
          ...(captures && { context_outputs: captures }),
        },
      ],
      ...(pricing && {
        pricing_options: [
          {
            handle: 'authored-price',
            product_handle: 'authored-product',
            strategies: ['discover'],
            match: pricing.match,
            ...(pricing.captures && { context_outputs: pricing.captures }),
          },
        ],
      }),
    },
    phases: phases ?? [
      {
        id: 'exercise',
        title: 'Exercise',
        steps: [
          {
            id: 'create',
            title: 'Buy the pinned offer',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {
              brand: { domain: 'acmeoutdoor.example' },
              start_time: 'asap',
              end_time: '2099-06-30T23:59:59Z',
              packages: [{ product_id: 'authored-product', pricing_option_id: 'seller-price', budget: 1000 }],
            },
            validations: [{ check: 'field_present', path: 'media_buy_id', description: 'The buy succeeds' }],
          },
        ],
      },
    ],
  };
}

function paginated(pages) {
  return {
    read(request) {
      const page = Number(request.pagination?.cursor ?? 0);
      return {
        status: 'completed',
        products: pages[page],
        cache_scope: 'account',
        wholesale_feed_version: 'v1',
        pagination: { has_more: page < pages.length - 1, ...(page < pages.length - 1 && { cursor: String(page + 1) }) },
      };
    },
  };
}

// ────────────────────────────────────────────────────────────
// Normalizer
// ────────────────────────────────────────────────────────────

describe('domain-qualified collection normalizer', () => {
  test('grouping and inner order do not change the set; namespaces do', () => {
    const grouped = normalizeCollectionSelectors([
      { publisher_domain: 'owner.example', collection_ids: ['news', 'music'] },
      { publisher_domain: 'second.example', collection_ids: ['sports'] },
    ]);
    const regrouped = normalizeCollectionSelectors([
      { publisher_domain: 'second.example', collection_ids: ['sports'] },
      { publisher_domain: 'owner.example', collection_ids: ['music'] },
      { publisher_domain: 'owner.example', collection_ids: ['news'] },
    ]);
    assert.ok(grouped.ok && regrouped.ok);
    assert.deepEqual(grouped.value.pairs, regrouped.value.pairs);
    assert.equal(diffCollectionPairSets(grouped.value.pairs, regrouped.value.pairs).equal, true);

    const otherNamespace = normalizeCollectionSelectors([
      { publisher_domain: 'other.example', collection_ids: ['news', 'music'] },
      { publisher_domain: 'second.example', collection_ids: ['sports'] },
    ]);
    assert.ok(otherNamespace.ok);
    assert.equal(diffCollectionPairSets(otherNamespace.value.pairs, grouped.value.pairs).equal, false);
  });

  test('schema-valid redundancy collapses to one pair', () => {
    const result = normalizeCollectionSelectors([
      { publisher_domain: 'owner.example', collection_ids: ['news', 'news'] },
      { publisher_domain: 'owner.example', collection_ids: ['news'] },
    ]);
    assert.ok(result.ok);
    assert.deepEqual(result.value.pairs, [{ publisher_domain: 'owner.example', collection_id: 'news' }]);
    // The outer grouping is still reported verbatim for diagnostics.
    assert.equal(result.value.selector_count, 2);
  });

  test('an empty-string id is legal and lossless; no minLength rule is invented', () => {
    const result = normalizeCollectionSelectors([{ publisher_domain: 'owner.example', collection_ids: [''] }]);
    assert.ok(result.ok);
    assert.deepEqual(result.value.pairs, [{ publisher_domain: 'owner.example', collection_id: '' }]);
    assert.notEqual(
      formatCollectionPair(result.value.pairs[0]),
      formatCollectionPair({ publisher_domain: 'owner.example', collection_id: null })
    );
  });

  test('Unicode identifiers survive without case folding or rewriting', () => {
    const ids = ['Nachrichten', 'nachrichten', 'ニュース', 'naïve'];
    const result = normalizeCollectionSelectors([{ publisher_domain: 'öwner.example', collection_ids: ids }]);
    assert.ok(result.ok);
    assert.equal(result.value.pairs.length, 4);
    assert.deepEqual(result.value.pairs.map(pair => pair.collection_id).sort(), [...ids].sort());
    assert.equal(result.value.pairs[0].publisher_domain, 'öwner.example');
  });

  test('the domain-only bulk-grant form is a distinct selector, not an empty enumeration', () => {
    const bulk = normalizeCollectionSelectors([{ publisher_domain: 'owner.example' }]);
    const explicit = normalizeCollectionSelectors([{ publisher_domain: 'owner.example', collection_ids: ['news'] }]);
    assert.ok(bulk.ok && explicit.ok);
    assert.deepEqual(bulk.value.pairs, [{ publisher_domain: 'owner.example', collection_id: null }]);
    assert.equal(diffCollectionPairSets(bulk.value.pairs, explicit.value.pairs).equal, false);
  });

  test('schema-invalid shapes fail with distinct codes instead of normalizing', () => {
    assert.equal(normalizeCollectionSelectors({}).failure.code, 'not_an_array');
    assert.equal(normalizeCollectionSelectors([null]).failure.code, 'selector_not_object');
    assert.equal(normalizeCollectionSelectors([{ collection_ids: ['a'] }]).failure.code, 'publisher_domain_invalid');
    assert.equal(
      normalizeCollectionSelectors([{ publisher_domain: 'a.example', collection_ids: [] }]).failure.code,
      'collection_ids_invalid'
    );
    assert.equal(
      normalizeCollectionSelectors([{ publisher_domain: 'a.example', collection_ids: [7] }]).failure.code,
      'collection_id_invalid'
    );
  });

  test('the pair bound is a visible failure, never silent truncation', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const result = normalizeCollectionSelectors([{ publisher_domain: 'owner.example', collection_ids: ids }], {
      limit: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'pair_limit_exceeded');
  });

  test('diagnostics are bounded and say so', () => {
    const pairs = Array.from({ length: 50 }, (_, i) => ({
      publisher_domain: 'owner.example',
      collection_id: `c${i}`,
    }));
    const summary = summarizeCollectionPairs(pairs);
    assert.match(summary, /\(\+30 more\)$/);
  });

  test('pair ordering is total and bytewise', () => {
    const pairs = [
      { publisher_domain: 'b.example', collection_id: 'a' },
      { publisher_domain: 'a.example', collection_id: 'b' },
      { publisher_domain: 'a.example', collection_id: null },
      { publisher_domain: 'a.example', collection_id: 'a' },
    ].sort(compareCollectionPairs);
    assert.deepEqual(pairs, [
      { publisher_domain: 'a.example', collection_id: null },
      { publisher_domain: 'a.example', collection_id: 'a' },
      { publisher_domain: 'a.example', collection_id: 'b' },
      { publisher_domain: 'b.example', collection_id: 'a' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// Predicate
// ────────────────────────────────────────────────────────────

describe('collection_selection_satisfies predicate', () => {
  test('fixed accepts literal false AND omission; true does not', () => {
    const selector = normalizeCollectionSelectionSelector({ collection_targeting: 'fixed' }, 'test');
    assert.equal(
      productSatisfiesCollectionSelection(product('a', { collection_targeting_allowed: false }), selector),
      true
    );
    assert.equal(productSatisfiesCollectionSelection(product('a'), selector), true);
    assert.equal(
      productSatisfiesCollectionSelection(product('a', { collection_targeting_allowed: true }), selector),
      false
    );
  });

  test('selectable requires literal true', () => {
    const selector = normalizeCollectionSelectionSelector({ collection_targeting: 'selectable' }, 'test');
    assert.equal(
      productSatisfiesCollectionSelection(product('a', { collection_targeting_allowed: true }), selector),
      true
    );
    assert.equal(
      productSatisfiesCollectionSelection(product('a', { collection_targeting_allowed: false }), selector),
      false
    );
    assert.equal(productSatisfiesCollectionSelection(product('a'), selector), false);
  });

  test('a non-boolean flag never qualifies under any collection_targeting', () => {
    for (const targeting of ['fixed', 'selectable', 'any']) {
      const selector = normalizeCollectionSelectionSelector({ collection_targeting: targeting }, 'test');
      const evaluation = evaluateCollectionSelection(product('a', { collection_targeting_allowed: null }), selector);
      assert.equal(evaluation.eligible, false, targeting);
      assert.match(evaluation.reason, /must be boolean or absent/);
    }
  });

  test('default materialization needs one distinct pair; strict subset needs two', () => {
    const onePair = product('one', {
      collection_targeting_allowed: true,
      collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }],
    });
    const defaultSelector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'selectable', minimum_pairs: 1 },
      't'
    );
    const subsetSelector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'selectable', minimum_pairs: 2 },
      't'
    );
    assert.equal(productSatisfiesCollectionSelection(onePair, defaultSelector), true);
    assert.equal(productSatisfiesCollectionSelection(onePair, subsetSelector), false);

    // Independence: a one-pair product keeps its default coverage even though
    // no subset witness exists for it.
    const witness = evaluateCollectionSelection(onePair, defaultSelector).witness;
    assert.equal(witness.strict_subset, null);
    assert.equal(readCollectionWitness(witness, 'strict_subset').ok, false);
    assert.equal(readCollectionWitness(witness, 'declared_selectors').ok, true);
  });

  test('a bulk-grant selector in a product is non-conformant composition, not a qualifying pair', () => {
    // `core/product.json` requires `collection_ids` on every `collections[]`
    // entry. Accepting one would also put a schema-invalid
    // `{publisher_domain}` selector into the witness bundle that storyboards
    // substitute whole into `collection_selection.collections`.
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'selectable', minimum_pairs: 1 },
      't'
    );
    const bulkOnly = product('bulk', {
      collection_targeting_allowed: true,
      collections: [{ publisher_domain: 'owner.example' }],
    });
    assert.match(evaluateCollectionSelection(bulkOnly, selector).reason, /domain-only bulk-grant selector/);
    assert.equal(productSatisfiesCollectionSelection(bulkOnly, selector), false);

    const mixed = product('mixed', {
      collection_targeting_allowed: true,
      collections: [
        { publisher_domain: 'owner.example', collection_ids: ['news'] },
        { publisher_domain: 'other.example' },
      ],
    });
    const evaluation = evaluateCollectionSelection(mixed, selector);
    assert.equal(evaluation.eligible, false);
    assert.match(evaluation.reason, /domain-only bulk-grant selector/);
  });

  test('the product fan-out publisher_domains arm is not read as a host domain', () => {
    // `core/product.json` restricts each publisher_properties entry with
    // {"not": {"required": ["publisher_domains"]}} and tells SDK implementers
    // to enforce singular-only at runtime. Reading it would ENLARGE the host
    // set, making the relation strictly harder to satisfy and silently
    // suppressing qualification into a coverage gap.
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'any', minimum_pairs: 1, require_cross_publisher_collection: true },
      't'
    );
    const nonConformant = product('fan-out', {
      publisher_properties: [{ publisher_domains: ['owner.example'], selection_type: 'all' }],
      collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }],
    });
    const evaluation = evaluateCollectionSelection(nonConformant, selector);
    assert.equal(evaluation.eligible, true);
    assert.deepEqual(evaluation.witness.property_publisher_domains, []);
    assert.equal(evaluation.witness.cross_publisher_relation.collection_publisher_domain, 'owner.example');
  });

  test('the owner/host relation traverses every selector, not index zero', () => {
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'any', minimum_pairs: 1, require_cross_publisher_collection: true },
      't'
    );
    const carriage = product('carriage', {
      publisher_properties: [
        { publisher_domain: 'host-a.example', selection_type: 'all' },
        { publisher_domain: 'host-b.example', selection_type: 'all' },
        { publisher_domain: 'host-c.example', selection_type: 'all' },
      ],
      collections: [
        // The external namespace is NOT at index zero.
        { publisher_domain: 'host-b.example', collection_ids: ['inhouse'] },
        { publisher_domain: 'external-owner.example', collection_ids: ['sold'] },
      ],
    });
    const evaluation = evaluateCollectionSelection(carriage, selector);
    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.witness.cross_publisher_relation.collection_publisher_domain, 'external-owner.example');
    assert.deepEqual(evaluation.witness.cross_publisher_relation.property_publisher_domains, [
      'host-a.example',
      'host-b.example',
      'host-c.example',
    ]);
    // The relation is a DECLARED wire relationship. It is not, and must not
    // be read as, verified ownership or adagents.json host authorization.
    assert.equal('verified_owner' in evaluation.witness.cross_publisher_relation, false);
  });

  test('an ordinary same-namespace product does not satisfy the carriage relation', () => {
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'any', minimum_pairs: 1, require_cross_publisher_collection: true },
      't'
    );
    const sameNamespace = product('ordinary', {
      publisher_properties: [{ publisher_domain: 'owner.example', selection_type: 'all' }],
      collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }],
    });
    const evaluation = evaluateCollectionSelection(sameNamespace, selector);
    assert.equal(evaluation.eligible, false);
    assert.match(evaluation.reason, /also a declared property namespace/);
  });

  test('negative witnesses are collision-checked against the complete product', () => {
    const crowded = product('crowded', {
      collection_targeting_allowed: true,
      collections: [
        {
          publisher_domain: 'owner.example',
          collection_ids: ['news', 'adcp-absent-collection', 'adcp-absent-collection-0'],
        },
      ],
    });
    const witness = evaluateCollectionSelection(
      crowded,
      normalizeCollectionSelectionSelector({ collection_targeting: 'selectable', minimum_pairs: 2 }, 't')
    ).witness;
    const pairs = normalizeCollectionSelectors(crowded.collections).value.pairs;
    const unknown = normalizeCollectionSelectors(witness.undeclared_collection_id_selectors).value.pairs;
    assert.equal(diffCollectionPairSets(unknown, pairs).unexpected.length, 1, 'unknown id must not already exist');
    const mismatched = normalizeCollectionSelectors(witness.undeclared_publisher_domain_selectors).value.pairs;
    assert.equal(
      pairs.some(pair => pair.publisher_domain === mismatched[0].publisher_domain),
      false,
      'mismatched domain must be outside every owner namespace'
    );
    // Deterministic: the same product always yields the same witness.
    const again = evaluateCollectionSelection(
      crowded,
      normalizeCollectionSelectionSelector({ collection_targeting: 'selectable', minimum_pairs: 2 }, 't')
    ).witness;
    assert.deepEqual(again.undeclared_collection_id_selectors, witness.undeclared_collection_id_selectors);
  });

  test('when carriage is requested, the subset and negatives come from the external owner', () => {
    // A bytewise-EARLIER local pair would otherwise win `concrete[0]`, and
    // the subset would exercise only the host's own inventory while the
    // storyboard believed it was testing carriage.
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'any', minimum_pairs: 2, require_cross_publisher_collection: true },
      't'
    );
    const locallyFirst = product('locally-first', {
      publisher_properties: [{ publisher_domain: 'aaa-host.example', selection_type: 'all' }],
      collections: [
        { publisher_domain: 'aaa-host.example', collection_ids: ['local'] },
        { publisher_domain: 'zzz-owner.example', collection_ids: ['sold'] },
      ],
    });
    const evaluation = evaluateCollectionSelection(locallyFirst, selector);
    assert.equal(evaluation.eligible, true);
    const witness = evaluation.witness;
    assert.equal(witness.distinct_pairs[0].publisher_domain, 'aaa-host.example', 'local pair really does sort first');
    assert.equal(witness.cross_publisher_relation.collection_publisher_domain, 'zzz-owner.example');
    assert.deepEqual(witness.strict_subset, [{ publisher_domain: 'zzz-owner.example', collection_ids: ['sold'] }]);
    assert.equal(witness.undeclared_collection_id_selectors[0].publisher_domain, 'zzz-owner.example');
    assert.equal(witness.undeclared_publisher_domain_selectors[0].collection_ids[0], 'sold');

    // Two distinct TOTAL pairs suffice: one external pair alongside a local
    // one is a legitimate carriage product and must not be rejected.
    assert.equal(witness.distinct_pairs.length, 2);

    // The negatives are still verified absent from the complete product.
    const all = normalizeCollectionSelectors(locallyFirst.collections).value.pairs;
    assert.equal(
      diffCollectionPairSets(normalizeCollectionSelectors(witness.undeclared_collection_id_selectors).value.pairs, all)
        .unexpected.length,
      1
    );
    assert.equal(
      all.some(pair => pair.publisher_domain === witness.undeclared_publisher_domain_selectors[0].publisher_domain),
      false
    );
  });

  test('without carriage the subset still comes from the bytewise-first pair', () => {
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'selectable', minimum_pairs: 2 },
      't'
    );
    const witness = evaluateCollectionSelection(
      product('ordinary', { collection_targeting_allowed: true }),
      selector
    ).witness;
    assert.deepEqual(witness.strict_subset, [{ publisher_domain: 'owner.example', collection_ids: ['music'] }]);
    assert.equal(witness.cross_publisher_relation, null);
  });

  test('the subset witness is a genuine strict subset of the bundle', () => {
    const witness = evaluateCollectionSelection(
      product('two', { collection_targeting_allowed: true }),
      normalizeCollectionSelectionSelector({ collection_targeting: 'selectable', minimum_pairs: 2 }, 't')
    ).witness;
    const subset = normalizeCollectionSelectors(witness.strict_subset).value.pairs;
    const full = witness.distinct_pairs;
    assert.equal(subset.length, 1);
    assert.equal(full.length, 2);
    assert.equal(diffCollectionPairSets(subset, full).missing.length, 1);
    assert.equal(diffCollectionPairSets(subset, full).unexpected.length, 0);
  });

  test('the operand is closed and validated', () => {
    assert.throws(() => normalizeCollectionSelectionSelector({ collection_targeting: 'nope' }, 't'), /must be one of/);
    // The obsolete provisional spelling must FAIL, not acquire a meaning.
    assert.throws(() => normalizeCollectionSelectionSelector({ mode: 'fixed' }, 't'), /unknown key\(s\): mode/);
    assert.throws(
      () => normalizeCollectionSelectionSelector({ collection_targeting: 'fixed', minimum_pairs: 3 }, 't'),
      /must be 1 or 2/
    );
    assert.throws(
      () => normalizeCollectionSelectionSelector({ collection_targeting: 'fixed', extra: true }, 't'),
      /unknown key/
    );
    assert.throws(
      () =>
        normalizeCollectionSelectionSelector(
          { collection_targeting: 'fixed', require_cross_publisher_collection: 'yes' },
          't'
        ),
      /must be boolean/
    );
  });
});

// ────────────────────────────────────────────────────────────
// Authoring-time contract
// ────────────────────────────────────────────────────────────

describe('declaration authoring', () => {
  test('a witness capture requires the predicate on the same declaration', () => {
    const sb = board({
      match: [{ path: '/collection_targeting_allowed', operator: 'equals', value: true }],
      captures: [{ key: '__adcp_fixture_bundle', witness: 'declared_selectors' }],
    });
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /requires a collection_selection_satisfies predicate/);
  });

  test('capture keys must sit inside the reserved namespace', () => {
    const sb = board({ captures: [{ key: 'selected_bundle', witness: 'declared_selectors' }] });
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /reserved "__adcp_fixture_" prefix/);
  });

  test('two declarations cannot publish the same capture key', () => {
    const sb = board({
      captures: [{ key: '__adcp_fixture_id', path: 'product_id' }],
      pricing: {
        match: [{ path: '/pricing_model', operator: 'equals', value: 'cpm' }],
        captures: [{ key: '__adcp_fixture_id', path: 'pricing_option_id' }],
      },
    });
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /declared by both/);
  });

  test('a step context_outputs entry cannot write the reserved namespace', () => {
    const sb = board({});
    sb.phases[0].steps[0].context_outputs = [{ key: '__adcp_fixture_forged', path: 'media_buy_id' }];
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /step captures cannot write fixture-preparation state/);
  });

  test('storyboard default context cannot pre-seed the reserved namespace', () => {
    const sb = board({ context: { __adcp_fixture_forged: { product_id: 'forged' } } });
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /reserved "__adcp_fixture_" prefix/);
  });

  test('an unknown capture kind and a both-path-and-witness entry fail load', () => {
    assert.throws(
      () => parseStoryboard(JSON.stringify(board({ captures: [{ key: '__adcp_fixture_x', witness: 'nope' }] }))),
      /witness: must be one of/
    );
    assert.throws(
      () =>
        parseStoryboard(
          JSON.stringify(board({ captures: [{ key: '__adcp_fixture_x', witness: 'declared_selectors', path: 'a' }] }))
        ),
      /exactly one of/
    );
  });
});

// ────────────────────────────────────────────────────────────
// Through the real runner
// ────────────────────────────────────────────────────────────

describe('selection through the public full runner', () => {
  test('an omitted fixed flag qualifies after complete pagination', async () => {
    const io = transport(
      [],
      paginated([[product('a-selectable', { collection_targeting_allowed: true })], [product('z-omitted-fixed')]])
    );
    const result = await runStoryboard(
      ENDPOINT,
      board({ match: [collectionPredicate({ collection_targeting: 'fixed' })] }),
      io.options
    );
    assert.equal(result.overall_passed, true, JSON.stringify(result.fixture_resolutions));
    assert.deepEqual(
      io.calls.filter(c => c.task === 'get_products').map(c => c.request.pagination.cursor),
      [undefined, '1']
    );
    assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'z-omitted-fixed');
    assert.equal(io.calls.find(c => c.task === 'create_media_buy').request.packages[0].product_id, 'z-omitted-fixed');
  });

  test('an explicitly false fixed flag also qualifies', async () => {
    const io = transport([product('explicit', { collection_targeting_allowed: false })]);
    const result = await runStoryboard(
      ENDPOINT,
      board({ match: [collectionPredicate({ collection_targeting: 'fixed' })] }),
      io.options
    );
    assert.equal(result.fixture_resolutions[0].status, 'resolved');
    assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'explicit');
  });

  test('a selectable-only catalog leaves a fixed declaration unsatisfied, not passing', async () => {
    const io = transport([product('selectable', { collection_targeting_allowed: true })]);
    const result = await runStoryboard(
      ENDPOINT,
      board({ match: [collectionPredicate({ collection_targeting: 'fixed' })] }),
      io.options
    );
    assert.equal(result.fixture_resolutions[0].status, 'unsatisfied');
    assert.equal(
      result.coverage_gaps.some(gap => gap.reason === 'fixture_unsatisfied'),
      true
    );
    assert.equal(
      io.calls.some(c => c.task === 'create_media_buy'),
      false
    );
  });

  test('a nonqualifying earlier product cannot hide a later carriage product', async () => {
    const io = transport([
      product('a-same-namespace', {
        publisher_properties: [{ publisher_domain: 'owner.example', selection_type: 'all' }],
      }),
      product('z-carriage'),
    ]);
    const result = await runStoryboard(
      ENDPOINT,
      board({
        match: [collectionPredicate({ collection_targeting: 'any', require_cross_publisher_collection: true })],
      }),
      io.options
    );
    assert.equal(result.overall_passed, true, JSON.stringify(result.fixture_resolutions));
    assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'z-carriage');
    assert.equal(io.calls.find(c => c.task === 'create_media_buy').request.packages[0].product_id, 'z-carriage');
  });

  test('discovery schema failure stays terminal and is not an applicability gap', async () => {
    const io = transport([{ product_id: 'broken' }]);
    const result = await runStoryboard(
      ENDPOINT,
      board({ match: [collectionPredicate({ collection_targeting: 'any' })] }),
      io.options
    );
    assert.equal(result.fixture_resolutions[0].status, 'failed');
    assert.equal(result.overall_passed, false);
    assert.equal(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, false);
    assert.equal(
      io.calls.some(c => c.task === 'create_media_buy'),
      false
    );
  });
});

describe('same-selected-graph captures', () => {
  function captureBoard(extra = {}) {
    return board({
      match: [collectionPredicate({ collection_targeting: 'selectable', minimum_pairs: 2 })],
      captures: [
        { key: '__adcp_fixture_product_id', path: 'product_id' },
        { key: '__adcp_fixture_bundle', witness: 'declared_selectors' },
        { key: '__adcp_fixture_subset', witness: 'strict_subset' },
        { key: '__adcp_fixture_unknown', witness: 'undeclared_collection_id_selectors' },
        { key: '__adcp_fixture_foreign', witness: 'undeclared_publisher_domain_selectors' },
      ],
      pricing: {
        match: [{ path: '/pricing_model', operator: 'equals', value: 'cpm' }],
        captures: [
          { key: '__adcp_fixture_currency', path: 'currency' },
          { key: '__adcp_fixture_min_spend', path: 'min_spend_per_package' },
          { key: '__adcp_fixture_cpm', path: 'fixed_price' },
        ],
      },
      ...extra,
    });
  }

  const selected = product('a-selected', {
    collection_targeting_allowed: true,
    pricing_options: [
      {
        pricing_option_id: 'selected-price',
        pricing_model: 'cpm',
        currency: 'EUR',
        fixed_price: 24,
        min_spend_per_package: 5000,
      },
    ],
  });
  const decoy = product('z-ordinary', {
    collections: [{ publisher_domain: 'ordinary.example', collection_ids: ['ordinary'] }],
    pricing_options: [
      {
        pricing_option_id: 'ordinary-price',
        pricing_model: 'cpm',
        currency: 'GBP',
        fixed_price: 77,
        min_spend_per_package: 9000,
      },
    ],
  });

  test('commercial terms come from the selected graph, not products[0]', async () => {
    // `z-ordinary` is first in the seller response and would win a naive
    // `products[0]` read; `a-selected` is what the resolver actually pins.
    const io = transport([decoy, selected]);
    const sb = captureBoard();
    sb.phases[0].steps[0].sample_request.packages[0].budget = '$context.__adcp_fixture_min_spend';
    sb.phases[0].steps[0].sample_request.packages[0].product_id = '$context.__adcp_fixture_product_id';
    sb.phases[0].steps[0].sample_request.currency = '$context.__adcp_fixture_currency';
    const result = await runStoryboard(ENDPOINT, sb, io.options);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    const request = io.calls.find(c => c.task === 'create_media_buy').request;
    assert.equal(request.packages[0].product_id, 'a-selected');
    assert.equal(request.currency, 'EUR');
    // The exact defect the held reporting draft hit: a 5000 minimum against
    // a 1000 authored budget. The capture supplies the real minimum.
    assert.equal(request.packages[0].budget, 5000);
  });

  test('witness captures are injected as concrete selectors', async () => {
    const io = transport([selected]);
    const sb = captureBoard();
    sb.phases[0].steps[0].sample_request.packages[0].targeting_overlay = {
      collection_selection: { mode: 'selected', collections: '$context.__adcp_fixture_subset' },
    };
    const result = await runStoryboard(ENDPOINT, sb, io.options);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    const overlay = io.calls.find(c => c.task === 'create_media_buy').request.packages[0].targeting_overlay;
    assert.deepEqual(overlay.collection_selection.collections, [
      { publisher_domain: 'owner.example', collection_ids: ['music'] },
    ]);
  });

  test('nothing is published when the graph does not fully resolve', async () => {
    // The product qualifies; its declared child price does not exist.
    const noMatchingPrice = product('a-selected', {
      collection_targeting_allowed: true,
      pricing_options: [{ pricing_option_id: 'flat', pricing_model: 'flat_rate', currency: 'USD', fixed_price: 3 }],
    });
    const io = transport([noMatchingPrice]);
    const result = await runStoryboard(ENDPOINT, captureBoard(), io.options);
    assert.equal(
      io.calls.some(c => c.task === 'create_media_buy'),
      false
    );
    assert.equal(
      result.coverage_gaps.some(gap => gap.reason === 'fixture_unsatisfied'),
      true
    );
    assert.equal(
      Object.keys(result.context).some(key => key.startsWith('__adcp_fixture_')),
      false,
      'a partially resolved graph must publish no captures'
    );
  });

  test('a whole-entity snapshot keeps an optional commercial field absent', async () => {
    // `min_spend_per_package` is OPTIONAL on cpm-option.json: a valid fixed
    // CPM option may omit it, and absence means no minimum. A `path:`
    // capture would fail the run; gating the declaration on `present` would
    // suppress a legal supporting seller. The snapshot keeps absence as
    // absence, with nothing defaulted and no zero fabricated.
    const cases = [
      ['absent', { pricing_option_id: 'p', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }],
      [
        'zero',
        { pricing_option_id: 'p', pricing_model: 'cpm', currency: 'USD', fixed_price: 12, min_spend_per_package: 0 },
      ],
      [
        'five thousand',
        { pricing_option_id: 'p', pricing_model: 'cpm', currency: 'USD', fixed_price: 12, min_spend_per_package: 5000 },
      ],
    ];
    for (const [label, option] of cases) {
      const io = transport([product('a-selected', { collection_targeting_allowed: true, pricing_options: [option] })]);
      const sb = board({
        match: [collectionPredicate({ collection_targeting: 'selectable' })],
        captures: [{ key: '__adcp_fixture_product', snapshot: 'selected_entity' }],
        pricing: {
          match: [{ path: '/pricing_model', operator: 'equals', value: 'cpm' }],
          captures: [{ key: '__adcp_fixture_price', snapshot: 'selected_entity' }],
        },
        phases: [{ id: 'read', title: 'Read', steps: [catalogReadStep()] }],
      });
      const result = await runStoryboard(ENDPOINT, sb, io.options);
      assert.equal(result.overall_passed, true, `${label}: ${JSON.stringify(result.fixture_resolutions)}`);
      const price = result.context.__adcp_fixture_price;
      // Same selected parent, price and currency in every case.
      assert.equal(result.context.__adcp_fixture_product.product_id, 'a-selected');
      assert.equal(price.pricing_option_id, 'p');
      assert.equal(price.currency, 'USD');
      assert.equal(price.fixed_price, 12);
      if (label === 'absent') {
        assert.equal('min_spend_per_package' in price, false, 'absence stays absence');
        assert.equal(price.min_spend_per_package, undefined);
      } else {
        assert.equal(price.min_spend_per_package, label === 'zero' ? 0 : 5000);
      }
      assert.equal(Object.isFrozen(price), true);
    }
  });

  test('a path capture of an explicit zero minimum is faithful, not treated as absent', async () => {
    const io = transport([
      product('a-selected', {
        collection_targeting_allowed: true,
        pricing_options: [
          { pricing_option_id: 'p', pricing_model: 'cpm', currency: 'USD', fixed_price: 12, min_spend_per_package: 0 },
        ],
      }),
    ]);
    const sb = board({
      match: [collectionPredicate({ collection_targeting: 'selectable' })],
      pricing: {
        match: [{ path: '/pricing_model', operator: 'equals', value: 'cpm' }],
        captures: [{ key: '__adcp_fixture_min_spend', path: 'min_spend_per_package' }],
      },
      phases: [{ id: 'read', title: 'Read', steps: [catalogReadStep()] }],
    });
    const result = await runStoryboard(ENDPOINT, sb, io.options);
    assert.equal(result.overall_passed, true, JSON.stringify(result.fixture_resolutions));
    assert.equal(result.context.__adcp_fixture_min_spend, 0);
  });

  test('a snapshot capture is mutually exclusive with path and witness', () => {
    for (const entry of [
      { key: '__adcp_fixture_x', snapshot: 'selected_entity', path: 'product_id' },
      { key: '__adcp_fixture_x', snapshot: 'selected_entity', witness: 'declared_selectors' },
      { key: '__adcp_fixture_x', snapshot: 'whole_catalog' },
    ]) {
      assert.throws(
        () => parseStoryboard(JSON.stringify(board({ captures: [entry] }))),
        /exactly one of|must be 'selected_entity'/,
        JSON.stringify(entry)
      );
    }
  });

  test('a declared capture that cannot be built is a setup failure, not a downgrade', async () => {
    const onePair = product('one-pair', {
      collection_targeting_allowed: true,
      collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }],
    });
    const io = transport([onePair]);
    const sb = board({
      // minimum_pairs: 1 lets the product qualify, but the author still asked
      // for a strict subset the product cannot provide.
      match: [collectionPredicate({ collection_targeting: 'selectable', minimum_pairs: 1 })],
      captures: [{ key: '__adcp_fixture_subset', witness: 'strict_subset' }],
    });
    const result = await runStoryboard(ENDPOINT, sb, io.options);
    assert.equal(result.fixture_resolutions[0].status, 'failed');
    assert.equal(result.overall_passed, false);
    assert.equal(
      result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false,
      false,
      'a buildable-capture failure is not an applicability gap'
    );
  });

  test('parent selection prefers a product whose declared child price exists', async () => {
    const wrongPrice = product('a-first', {
      collection_targeting_allowed: true,
      pricing_options: [{ pricing_option_id: 'flat', pricing_model: 'flat_rate', currency: 'USD', fixed_price: 3 }],
    });
    const io = transport([wrongPrice, selected]);
    const result = await runStoryboard(ENDPOINT, captureBoard(), io.options);
    assert.equal(result.overall_passed, true, JSON.stringify(result.fixture_resolutions));
    assert.equal(result.fixture_resolutions[0].seller_ids.product_id, 'a-selected');
  });
});

describe('collection_set_equals_context', () => {
  function setBoard(expected, path = 'products[0].collections') {
    return {
      id: 'collection_foundation/set_validation',
      version: '1.0.0',
      category: 'media_buy_seller',
      title: 'Collection set validation',
      summary: 'Namespace-aware set comparison.',
      narrative: 'Exercises the shared normalizer through the per-step validation engine.',
      agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
      caller: { role: 'buyer_agent' },
      ...(expected !== undefined && { context: { expected } }),
      phases: [
        {
          id: 'read',
          title: 'Read',
          steps: [
            {
              id: 'read',
              title: 'Read the catalog',
              task: 'get_products',
              stateful: false,
              sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
              validations: [
                {
                  id: 'authored-collection-comparison',
                  check: 'collection_set_equals_context',
                  path,
                  context_key: 'expected',
                  description: 'Collections match the expected domain-qualified set',
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const expectedSet = [
    { publisher_domain: 'owner.example', collection_ids: ['news', 'music'] },
    { publisher_domain: 'second.example', collection_ids: ['sports'] },
  ];

  test('regrouped and reordered selectors now pass', async () => {
    const io = transport([
      product('same-set', {
        collections: [
          { publisher_domain: 'second.example', collection_ids: ['sports'] },
          { publisher_domain: 'owner.example', collection_ids: ['music', 'news'] },
        ],
      }),
    ]);
    const result = await runStoryboardStep(ENDPOINT, setBoard(expectedSet), 'read', io.options);
    assert.equal(result.passed, true, JSON.stringify(result.validations));
  });

  test('a namespace substitution still fails', async () => {
    const io = transport([
      product('wrong-namespace', {
        collections: [
          { publisher_domain: 'other.example', collection_ids: ['news', 'music'] },
          { publisher_domain: 'second.example', collection_ids: ['sports'] },
        ],
      }),
    ]);
    const result = await runStoryboardStep(ENDPOINT, setBoard(expectedSet), 'read', io.options);
    assert.equal(result.passed, false);
    const validation = result.validations.find(v => v.check === 'collection_set_equals_context');
    assert.match(validation.error, /missing .*owner\.example/);
    assert.match(validation.error, /unexpected .*other\.example/);
  });

  test('a proper subset fails — set equality is not containment', async () => {
    const io = transport([
      product('subset', { collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }] }),
    ]);
    const result = await runStoryboardStep(ENDPOINT, setBoard(expectedSet), 'read', io.options);
    assert.equal(result.passed, false);
  });

  test('legal redundant pairs compare equal', async () => {
    const io = transport([
      product('redundant', {
        collections: [
          { publisher_domain: 'owner.example', collection_ids: ['news', 'news', 'music'] },
          { publisher_domain: 'owner.example', collection_ids: ['music'] },
          { publisher_domain: 'second.example', collection_ids: ['sports'] },
        ],
      }),
    ]);
    const result = await runStoryboardStep(ENDPOINT, setBoard(expectedSet), 'read', io.options);
    assert.equal(result.passed, true, JSON.stringify(result.validations));
  });

  test('a missing expected key is a setup failure, not branch-safe success', async () => {
    const io = transport([product('any')]);
    const result = await runStoryboardStep(ENDPOINT, setBoard(undefined), 'read', io.options);
    assert.equal(result.passed, false);
    const validation = result.validations.find(v => v.check === 'collection_set_equals_context');
    assert.match(validation.error, /^expected_context_absent:/);
  });

  test('a malformed expected set is an authoring failure with its own diagnostic', async () => {
    const io = transport([product('any')]);
    const result = await runStoryboardStep(ENDPOINT, setBoard([{ collection_ids: ['news'] }]), 'read', io.options);
    assert.equal(result.passed, false);
    const validation = result.validations.find(v => v.check === 'collection_set_equals_context');
    assert.match(validation.error, /^expected_context_malformed:/);
  });

  test('a missing actual path fails with the actual-side diagnostic', async () => {
    const io = transport([product('any')]);
    const result = await runStoryboardStep(
      ENDPOINT,
      setBoard(expectedSet, 'products[0].not_collections'),
      'read',
      io.options
    );
    assert.equal(result.passed, false);
    const validation = result.validations.find(v => v.check === 'collection_set_equals_context');
    assert.match(validation.error, /^actual_collections_malformed:/);
  });

  test('every failing arm preserves authored context, identity, schema nulls and wire evidence', async () => {
    // runner-output-contract.yaml lists schema_id / schema_url under
    // required_on_failure and requires null outside `response_schema`.
    // Omitting the keys is not the same as recording null: a consumer
    // cannot tell "no schema applies" from "the runner forgot".
    const cases = [
      ['missing expected key', setBoard(undefined), undefined],
      ['malformed expected set', setBoard([{ collection_ids: ['news'] }]), undefined],
      ['malformed actual path', setBoard(expectedSet, 'products[0].not_collections'), undefined],
      ['unequal sets', setBoard(expectedSet), undefined],
      ['missing path', setBoard(expectedSet, ''), undefined],
      ['distinct-pairs witness', setBoard([{ publisher_domain: 'owner.example', collection_id: 'news' }]), undefined],
    ];
    for (const [label, doc] of cases) {
      const io = transport([product('any')]);
      const result = await runStoryboardStep(ENDPOINT, doc, 'read', io.options);
      const validation = result.validations.find(v => v.check === 'collection_set_equals_context');
      assert.ok(validation, label);
      assert.equal(validation.passed, false, label);
      assert.equal(validation.context_key, 'expected', label);
      assert.equal(validation.id, 'authored-collection-comparison', label);
      assert.equal(validation.request.operation, 'get_products', label);
      assert.equal(validation.response.transport, 'mcp', label);
      assert.ok(Object.hasOwn(validation, 'schema_id'), `${label}: schema_id key present`);
      assert.ok(Object.hasOwn(validation, 'schema_url'), `${label}: schema_url key present`);
      assert.equal(validation.schema_id, null, label);
      assert.equal(validation.schema_url, null, label);
    }
  });

  test('the validator runs identically in the full and standalone runners', async () => {
    const matching = product('same-set', {
      collections: [
        { publisher_domain: 'second.example', collection_ids: ['sports'] },
        { publisher_domain: 'owner.example', collection_ids: ['music', 'news'] },
      ],
    });
    const mismatched = product('wrong', {
      collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }],
    });
    for (const [fixture, expectation] of [
      [matching, true],
      [mismatched, false],
    ]) {
      const fullIo = transport([fixture]);
      const full = await runStoryboard(ENDPOINT, setBoard(expectedSet), fullIo.options);
      const stepIo = transport([fixture]);
      const step = await runStoryboardStep(ENDPOINT, setBoard(expectedSet), 'read', stepIo.options);
      assert.equal(full.overall_passed, expectation, JSON.stringify(full.phases));
      assert.equal(step.passed, expectation, JSON.stringify(step.validations));
    }
  });
});

describe('review regressions', () => {
  test('a witness passed where a selector belongs is refused, not silently defaulted', () => {
    // The witness is structurally assignable to the selector, so the
    // compiler accepts `evaluate(candidate, witness)` and it would run with
    // `minimum_pairs: 1` and no carriage requirement — a different question
    // from the one the caller meant to ask.
    const witness = evaluateCollectionSelection(
      product('two', { collection_targeting_allowed: true }),
      normalizeCollectionSelectionSelector({ collection_targeting: 'selectable', minimum_pairs: 2 }, 't')
    ).witness;
    assert.throws(
      () => evaluateCollectionSelection(product('two', { collection_targeting_allowed: true }), witness),
      /witness is the OUTPUT of an evaluation/
    );
  });

  test('the carriage relation selector is bytewise-deterministic, not seller array order', () => {
    // Two selector entries under the SAME external domain: reordering the
    // seller's array must not change which one the witness reports.
    const selector = normalizeCollectionSelectionSelector(
      { collection_targeting: 'any', minimum_pairs: 2, require_cross_publisher_collection: true },
      't'
    );
    const entries = [
      { publisher_domain: 'zzz-owner.example', collection_ids: ['sports'] },
      { publisher_domain: 'zzz-owner.example', collection_ids: ['arts'] },
    ];
    const forward = evaluateCollectionSelection(
      product('p', {
        publisher_properties: [{ publisher_domain: 'host.example', selection_type: 'all' }],
        collections: entries,
      }),
      selector
    ).witness;
    const reversed = evaluateCollectionSelection(
      product('p', {
        publisher_properties: [{ publisher_domain: 'host.example', selection_type: 'all' }],
        collections: [...entries].reverse(),
      }),
      selector
    ).witness;
    assert.deepEqual(forward.cross_publisher_relation.selector, reversed.cross_publisher_relation.selector);
    assert.deepEqual(forward.cross_publisher_relation.selector.collection_ids, ['arts'], 'bytewise-first wins');
  });

  test('a capture path written as an RFC 6901 pointer fails at load, naming the grammar', () => {
    const sb = board({
      match: [collectionPredicate({ collection_targeting: 'selectable' })],
      captures: [{ key: '__adcp_fixture_id', path: '/product_id' }],
      phases: [{ id: 'read', title: 'Read', steps: [catalogReadStep()] }],
    });
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /dotted storyboard grammar/);
  });

  test('a capture path with an empty dotted segment fails at load instead of capturing everything', () => {
    // "." parses as two empty segments and resolved to the WHOLE selected
    // entity, so a stray keystroke silently published the entire product
    // snapshot under a scalar's key. Every segment must name a field;
    // capturing the whole entity has its own explicit spelling.
    for (const path of ['.', '..', 'ext.', '.ext', 'pricing_options..rate', '[]', '...']) {
      const sb = board({
        match: [collectionPredicate({ collection_targeting: 'selectable' })],
        captures: [{ key: '__adcp_fixture_id', path }],
        phases: [{ id: 'read', title: 'Read', steps: [catalogReadStep()] }],
      });
      assert.throws(
        () => parseStoryboard(JSON.stringify(sb)),
        /must name at least one field in the dotted storyboard grammar|every dotted segment must name a field/,
        `path ${JSON.stringify(path)} must reject`
      );
    }
    // The legitimate dotted and indexed forms still load.
    for (const path of ['product_id', 'ext.adcp.creative_wire', 'pricing_options[0].rate']) {
      const sb = board({
        match: [collectionPredicate({ collection_targeting: 'selectable' })],
        captures: [{ key: '__adcp_fixture_id', path }],
        phases: [{ id: 'read', title: 'Read', steps: [catalogReadStep()] }],
      });
      assert.doesNotThrow(() => parseStoryboard(JSON.stringify(sb)), `path ${JSON.stringify(path)} must load`);
    }
  });

  test('a witness capture on a pricing declaration fails at load, naming where it belongs', () => {
    const sb = board({
      match: [collectionPredicate({ collection_targeting: 'selectable' })],
      pricing: {
        match: [
          { path: '/pricing_model', operator: 'equals', value: 'cpm' },
          collectionPredicate({ collection_targeting: 'selectable' }),
        ],
        captures: [{ key: '__adcp_fixture_subset', witness: 'strict_subset' }],
      },
      phases: [{ id: 'read', title: 'Read', steps: [catalogReadStep()] }],
    });
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /describes the product, not one of its pricing options/);
  });

  test('a distinct_pairs witness fed to the set validator is named, not diffed into nonsense', async () => {
    // `distinct_pairs` carries singular `collection_id`. Without the shape
    // check the normalizer reads the missing `collection_ids` as a
    // domain-only bulk grant and the diff reads `missing "d":*` — the exact
    // id-flattened-from-its-domain failure the module exists to prevent.
    const { validateCollectionSetEqualsContext } = require('../../dist/lib/testing/storyboard/validations.js');
    if (typeof validateCollectionSetEqualsContext !== 'function') {
      // Exercised through the runner instead when the helper is private.
      const io = transport([product('a-selected', { collection_targeting_allowed: true })]);
      const sb = board({
        match: [collectionPredicate({ collection_targeting: 'selectable', minimum_pairs: 2 })],
        captures: [{ key: '__adcp_fixture_pairs', witness: 'distinct_pairs' }],
        phases: [
          {
            id: 'read',
            title: 'Read',
            steps: [
              {
                ...catalogReadStep(),
                validations: [
                  {
                    check: 'collection_set_equals_context',
                    path: 'products[0].collections',
                    context_key: '__adcp_fixture_pairs',
                    description: 'readback',
                  },
                ],
              },
            ],
          },
        ],
      });
      const result = await runStoryboard(ENDPOINT, sb, io.options);
      const failing = result.phases
        .flatMap(phase => phase.steps)
        .flatMap(step => step.validations)
        .find(v => v.check === 'collection_set_equals_context');
      assert.ok(failing, JSON.stringify(result.phases));
      assert.equal(failing.passed, false);
      assert.match(failing.error, /diagnostic shape/);
      assert.equal(failing.actual, 'distinct_pairs_witness');
    }
  });
});
