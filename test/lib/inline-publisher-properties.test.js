/**
 * Tests for the inline-resolution path on `publisher_properties` selectors
 * (adcp#4825 / adcp#4827; adcp-client#1885 Part 1).
 *
 * Pins:
 *  - Selector targeting a parent-file `publisher_domain` with matching
 *    `properties[]` resolves inline; no federated fallback emitted.
 *  - Compact-form `publisher_domains[]` selectors fan out and resolve
 *    inline per-domain.
 *  - `revoked_publisher_domains[]` on the parent file drops the matching
 *    selector entirely — neither inline nor federated.
 *  - Selectors with no inline match flow through `unresolved_selectors`
 *    for the caller's federated fetch.
 *  - Divergence detection identifies (publisher_domain, property_id) pairs
 *    that resolved differently inline vs federated.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  resolveInlinePublisherProperties,
  resolveSingularInline,
  detectInlineFederatedDivergence,
} = require('../../dist/lib/discovery/inline-publisher-properties.js');
const { resolveAgentProperties } = require('../../dist/lib/discovery/resolve-agent-properties.js');

function makeProperty(id, name, domain, tags) {
  const out = {
    property_id: id,
    property_type: 'website',
    name,
    identifiers: [{ type: 'domain', value: name }],
    publisher_domain: domain,
  };
  if (tags) out.tags = tags;
  return out;
}

describe('resolveInlinePublisherProperties — inline match', () => {
  const adAgents = {
    properties: [
      makeProperty('home_a', 'home.a.example', 'a.example'),
      makeProperty('news_a', 'news.a.example', 'a.example', ['news']),
      makeProperty('home_b', 'home.b.example', 'b.example'),
    ],
    authorized_agents: [],
  };

  test('selection_type:all — singular selector resolves inline', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domain: 'a.example' },
    ]);
    assert.strictEqual(result.inline_properties.length, 2);
    assert.deepStrictEqual(result.inline_properties.map(p => p.property_id).sort(), ['home_a', 'news_a']);
    assert.strictEqual(result.unresolved_selectors.length, 0);
    assert.strictEqual(result.revoked_selectors.length, 0);
  });

  test('selection_type:by_id — predicate filters within inline domain match', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'by_id', publisher_domain: 'a.example', property_ids: ['news_a'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 1);
    assert.strictEqual(result.inline_properties[0].property_id, 'news_a');
  });

  test('selection_type:by_tag — predicate filters within inline domain match', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'by_tag', publisher_domain: 'a.example', property_tags: ['news'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 1);
    assert.strictEqual(result.inline_properties[0].property_id, 'news_a');
  });

  test('compact-form publisher_domains[] fans out and resolves per-domain', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domains: ['a.example', 'b.example'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 3);
    assert.strictEqual(result.unresolved_selectors.length, 0);
  });

  test('case-insensitive publisher_domain match', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domain: 'A.EXAMPLE' },
    ]);
    assert.strictEqual(result.inline_properties.length, 2);
  });
});

describe('resolveInlinePublisherProperties — unresolved (federated needed)', () => {
  const adAgents = {
    properties: [makeProperty('home_a', 'home.a.example', 'a.example')],
    authorized_agents: [],
  };

  test('selector domain not in parent properties[] flows to unresolved', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domain: 'unknown.example' },
    ]);
    assert.strictEqual(result.inline_properties.length, 0);
    assert.strictEqual(result.unresolved_selectors.length, 1);
    assert.strictEqual(result.unresolved_selectors[0].publisher_domain, 'unknown.example');
    assert.strictEqual(result.revoked_selectors.length, 0);
  });

  test('compact-form with mixed inline-match and miss splits correctly', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domains: ['a.example', 'unknown.example'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 1);
    assert.strictEqual(result.unresolved_selectors.length, 1);
    assert.strictEqual(result.unresolved_selectors[0].publisher_domain, 'unknown.example');
  });

  test('by_id with no property matches in the inline domain flows to unresolved', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'by_id', publisher_domain: 'a.example', property_ids: ['nonexistent'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 0);
    assert.strictEqual(result.unresolved_selectors.length, 1);
  });
});

describe('resolveInlinePublisherProperties — revocation', () => {
  const adAgents = {
    properties: [
      makeProperty('home_a', 'home.a.example', 'a.example'),
      makeProperty('home_b', 'home.b.example', 'b.example'),
    ],
    revoked_publisher_domains: ['a.example'],
    authorized_agents: [],
  };

  test('revoked domain drops the selector — no inline, no unresolved', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domain: 'a.example' },
    ]);
    assert.strictEqual(result.inline_properties.length, 0);
    assert.strictEqual(result.unresolved_selectors.length, 0);
    assert.strictEqual(result.revoked_selectors.length, 1);
    assert.strictEqual(result.revoked_selectors[0].publisher_domain, 'a.example');
  });

  test('compact-form with one revoked and one matching domain — revoked dropped, other resolves', () => {
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domains: ['a.example', 'b.example'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 1);
    assert.strictEqual(result.inline_properties[0].publisher_domain, 'b.example');
    assert.strictEqual(result.revoked_selectors.length, 1);
  });

  test('revocation list is case-insensitive', () => {
    const file = { ...adAgents, revoked_publisher_domains: ['A.EXAMPLE'] };
    const result = resolveInlinePublisherProperties(file, [{ selection_type: 'all', publisher_domain: 'a.example' }]);
    assert.strictEqual(result.revoked_selectors.length, 1);
  });

  test('schema-valid revocation objects are honored', () => {
    const file = {
      ...adAgents,
      revoked_publisher_domains: [{ publisher_domain: 'a.example', revoked_at: '2026-01-01T00:00:00Z' }],
    };
    const result = resolveInlinePublisherProperties(file, [{ selection_type: 'all', publisher_domain: 'a.example' }]);
    assert.strictEqual(result.inline_properties.length, 0);
    assert.strictEqual(result.unresolved_selectors.length, 0);
    assert.strictEqual(result.revoked_selectors.length, 1);
  });
});

describe('resolveInlinePublisherProperties — input defensiveness', () => {
  test('missing properties[] on adAgents — all selectors flow to unresolved', () => {
    const result = resolveInlinePublisherProperties({ authorized_agents: [] }, [
      { selection_type: 'all', publisher_domain: 'a.example' },
    ]);
    assert.strictEqual(result.inline_properties.length, 0);
    assert.strictEqual(result.unresolved_selectors.length, 1);
  });

  test('properties without publisher_domain are not matched', () => {
    const adAgents = {
      properties: [{ property_id: 'no_domain', property_type: 'website', name: 'x', identifiers: [] }],
      authorized_agents: [],
    };
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domain: 'a.example' },
    ]);
    assert.strictEqual(result.inline_properties.length, 0);
    assert.strictEqual(result.unresolved_selectors.length, 1);
  });

  test('de-duplicates inline matches by property_id across selectors', () => {
    const adAgents = {
      properties: [makeProperty('home_a', 'home.a.example', 'a.example', ['x', 'y'])],
      authorized_agents: [],
    };
    const result = resolveInlinePublisherProperties(adAgents, [
      { selection_type: 'all', publisher_domain: 'a.example' },
      { selection_type: 'by_tag', publisher_domain: 'a.example', property_tags: ['x'] },
    ]);
    assert.strictEqual(result.inline_properties.length, 1);
  });
});

describe('resolveSingularInline', () => {
  const properties = [
    makeProperty('home_a', 'home.a.example', 'a.example', ['news']),
    makeProperty('home_b', 'home.b.example', 'b.example'),
  ];

  test('matched — returns reason matched', () => {
    const result = resolveSingularInline(properties, {
      selection_type: 'all',
      publisher_domain: 'a.example',
    });
    assert.strictEqual(result.reason, 'matched');
    assert.strictEqual(result.properties.length, 1);
  });

  test('domain_not_inline — selector domain absent from properties[]', () => {
    const result = resolveSingularInline(properties, {
      selection_type: 'all',
      publisher_domain: 'unknown.example',
    });
    assert.strictEqual(result.reason, 'domain_not_inline');
    assert.strictEqual(result.properties.length, 0);
  });

  test('no_predicate_match — domain present, predicate fails', () => {
    const result = resolveSingularInline(properties, {
      selection_type: 'by_tag',
      publisher_domain: 'a.example',
      property_tags: ['nonexistent'],
    });
    assert.strictEqual(result.reason, 'no_predicate_match');
    assert.strictEqual(result.properties.length, 0);
  });
});

describe('detectInlineFederatedDivergence', () => {
  test('reports differing fields when inline and federated disagree', () => {
    const inline = [makeProperty('home_a', 'home.a.example', 'a.example')];
    const federated = [makeProperty('home_a', 'CHANGED.a.example', 'a.example', ['new-tag'])];
    const divergences = detectInlineFederatedDivergence(inline, federated);
    assert.strictEqual(divergences.length, 1);
    assert.strictEqual(divergences[0].publisher_domain, 'a.example');
    assert.strictEqual(divergences[0].property_id, 'home_a');
    assert.ok(divergences[0].differing_fields.includes('name'));
    assert.ok(divergences[0].differing_fields.includes('tags'));
  });

  test('returns empty when inline and federated agree exactly', () => {
    const inline = [makeProperty('home_a', 'home.a.example', 'a.example')];
    const federated = [makeProperty('home_a', 'home.a.example', 'a.example')];
    const divergences = detectInlineFederatedDivergence(inline, federated);
    assert.strictEqual(divergences.length, 0);
  });

  test('skips federated entries lacking property_id or publisher_domain', () => {
    const inline = [makeProperty('home_a', 'home.a.example', 'a.example')];
    const federated = [{ property_type: 'website', name: 'x', identifiers: [] }];
    const divergences = detectInlineFederatedDivergence(inline, federated);
    assert.strictEqual(divergences.length, 0);
  });
});

describe('resolveAgentProperties — publisher_properties inline integration', () => {
  test('inline resolution fills properties; cross_publisher_expanded shrinks accordingly', () => {
    const adAgents = {
      properties: [
        makeProperty('home_a', 'home.a.example', 'a.example'),
        makeProperty('news_a', 'news.a.example', 'a.example', ['news']),
      ],
      authorized_agents: [
        {
          url: 'https://broker.example/agent',
          authorized_for: 'a + unknown',
          authorization_type: 'publisher_properties',
          publisher_properties: [
            { selection_type: 'all', publisher_domain: 'a.example' },
            { selection_type: 'all', publisher_domain: 'unknown.example' },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(adAgents, 'https://broker.example/agent');
    assert.strictEqual(scope.properties.length, 2);
    // Only the unmatched domain flows through to federated.
    assert.strictEqual(scope.cross_publisher_expanded.length, 1);
    assert.strictEqual(scope.cross_publisher_expanded[0].publisher_domain, 'unknown.example');
    // `cross_publisher` preserves the raw wire shape (per existing contract).
    assert.strictEqual(scope.cross_publisher.length, 2);
  });

  test('revoked domain neither resolves inline nor cross-publishes', () => {
    const adAgents = {
      properties: [makeProperty('home_a', 'home.a.example', 'a.example')],
      revoked_publisher_domains: ['a.example'],
      authorized_agents: [
        {
          url: 'https://broker.example/agent',
          authorized_for: 'a (revoked)',
          authorization_type: 'publisher_properties',
          publisher_properties: [{ selection_type: 'all', publisher_domain: 'a.example' }],
        },
      ],
    };
    const scope = resolveAgentProperties(adAgents, 'https://broker.example/agent');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.cross_publisher_expanded.length, 0);
  });
});
