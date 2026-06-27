/**
 * Per-agent property resolution from `adagents.json` (adcp-client#1721).
 *
 * Pins the spec-required dispatch on `authorization_type` + matching
 * selector. Mirrors the Python SDK's `_resolve_agent_properties` so
 * the two SDKs agree on the same input file.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  resolveAgentProperties,
  listAgentPropertyMap,
  getAllProperties,
  canonicalizeAgentUrl,
} = require('../../dist/lib/discovery/resolve-agent-properties.js');

function makeProperty(id, name, tags) {
  const out = {
    property_id: id,
    property_type: 'website',
    name,
    identifiers: [{ type: 'domain', value: name }],
  };
  if (tags) out.tags = tags;
  return out;
}

describe('canonicalizeAgentUrl', () => {
  test('lowercases scheme and host', () => {
    assert.strictEqual(canonicalizeAgentUrl('HTTPS://Example.COM/mcp'), 'https://example.com/mcp');
    assert.strictEqual(canonicalizeAgentUrl('http://Example.COM/mcp'), 'http://example.com/mcp');
  });

  test('strips default port (443 for https, 80 for http)', () => {
    assert.strictEqual(canonicalizeAgentUrl('https://example.com:443/mcp'), 'https://example.com/mcp');
    assert.strictEqual(canonicalizeAgentUrl('http://example.com:80/mcp'), 'http://example.com/mcp');
  });

  test('preserves non-default port', () => {
    assert.strictEqual(canonicalizeAgentUrl('https://example.com:8443/mcp'), 'https://example.com:8443/mcp');
  });

  test('decodes percent-encoded unreserved chars in path', () => {
    // %7E is `~`, %2D is `-`, %2E is `.`
    assert.strictEqual(canonicalizeAgentUrl('https://example.com/%7Efoo'), 'https://example.com/~foo');
    assert.strictEqual(canonicalizeAgentUrl('https://example.com/%2Dfoo'), 'https://example.com/-foo');
  });

  test('strips fragment', () => {
    assert.strictEqual(canonicalizeAgentUrl('https://example.com/mcp#foo'), 'https://example.com/mcp');
  });

  test('preserves trailing slash in the public canonical URL', () => {
    assert.strictEqual(canonicalizeAgentUrl('https://example.com/mcp/'), 'https://example.com/mcp/');
    assert.strictEqual(canonicalizeAgentUrl('https://example.com/'), 'https://example.com/');
  });

  test('rejects userinfo', () => {
    assert.strictEqual(canonicalizeAgentUrl('https://user:pass@example.com/'), null);
  });

  test('rejects unsupported scheme', () => {
    assert.strictEqual(canonicalizeAgentUrl('ftp://example.com/'), null);
    assert.strictEqual(canonicalizeAgentUrl('file:///etc/passwd'), null);
  });

  test('rejects unparseable input', () => {
    assert.strictEqual(canonicalizeAgentUrl(''), null);
    assert.strictEqual(canonicalizeAgentUrl('not a url'), null);
    assert.strictEqual(canonicalizeAgentUrl(null), null);
  });
});

describe('resolveAgentProperties — authorization_type: property_ids', () => {
  const adAgents = {
    properties: [makeProperty('home', 'home.example'), makeProperty('news', 'news.example')],
    authorized_agents: [
      {
        url: 'https://agent-news.example/mcp',
        authorized_for: 'news only',
        authorization_type: 'property_ids',
        property_ids: ['news'],
      },
    ],
  };

  test('filters top-level properties to those whose property_id is listed', () => {
    const scope = resolveAgentProperties(adAgents, 'https://agent-news.example/mcp');
    assert.strictEqual(scope.properties.length, 1);
    assert.strictEqual(scope.properties[0].property_id, 'news');
    assert.strictEqual(scope.unresolvable, undefined);
  });

  test('canonical-URL match: trailing port-443 still matches', () => {
    const scope = resolveAgentProperties(adAgents, 'https://agent-news.example:443/mcp');
    assert.strictEqual(scope.properties.length, 1);
  });

  test('canonical-URL match: scheme differences do not match', () => {
    const file = {
      ...adAgents,
      authorized_agents: [{ ...adAgents.authorized_agents[0], url: 'http://agent-news.example/mcp' }],
    };
    const scope = resolveAgentProperties(file, 'https://agent-news.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'agent_not_listed');
  });

  test('canonical-URL match: trailing slash differences do not match', () => {
    const file = {
      ...adAgents,
      authorized_agents: [{ ...adAgents.authorized_agents[0], url: 'https://agent-news.example/mcp/' }],
    };
    const scope = resolveAgentProperties(file, 'https://agent-news.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'agent_not_listed');
  });

  test('listAgentPropertyMap keeps public canonical URL keys', () => {
    const result = listAgentPropertyMap(adAgents);
    assert.ok(result.byAgent.has('https://agent-news.example/mcp'));
  });

  test('external URL lookup fails closed when canonical-equivalent entries are ambiguous', () => {
    const file = {
      properties: [makeProperty('home', 'home.example'), makeProperty('news', 'news.example')],
      authorized_agents: [
        {
          url: 'https://agent-news.example/mcp',
          authorized_for: 'home',
          authorization_type: 'property_ids',
          property_ids: ['home'],
        },
        {
          url: 'https://agent-news.example:443/mcp',
          authorized_for: 'news',
          authorization_type: 'property_ids',
          property_ids: ['news'],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent-news.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'ambiguous_agent_url');
  });

  test('returns no_match when none of the property_ids resolve', () => {
    const file = {
      ...adAgents,
      authorized_agents: [
        {
          ...adAgents.authorized_agents[0],
          property_ids: ['ghost'],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent-news.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'no_match');
  });
});

describe('resolveAgentProperties — authorization_type: property_tags', () => {
  const adAgents = {
    properties: [
      makeProperty('home', 'home.example', ['sports']),
      makeProperty('news', 'news.example', ['news']),
      makeProperty('biz', 'biz.example', ['finance', 'business']),
    ],
    authorized_agents: [
      {
        url: 'https://agent.example/mcp',
        authorized_for: 'business + sports',
        authorization_type: 'property_tags',
        property_tags: ['sports', 'business'],
      },
    ],
  };

  test('filters by tag intersection (any tag matches)', () => {
    const scope = resolveAgentProperties(adAgents, 'https://agent.example/mcp');
    assert.deepStrictEqual(scope.properties.map(p => p.property_id).sort(), ['biz', 'home']);
  });

  test('properties with no `tags` field are skipped, not crashed', () => {
    const file = {
      properties: [makeProperty('untagged', 'untagged.example'), ...adAgents.properties],
      authorized_agents: adAgents.authorized_agents,
    };
    const scope = resolveAgentProperties(file, 'https://agent.example/mcp');
    assert.ok(!scope.properties.some(p => p.property_id === 'untagged'));
  });
});

describe('resolveAgentProperties — authorization_type: inline_properties', () => {
  test("returns the agent entry's own properties[] verbatim", () => {
    const file = {
      properties: [makeProperty('main', 'main.example')],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'inline test',
          authorization_type: 'inline_properties',
          properties: [makeProperty('inline_a', 'a.example'), makeProperty('inline_b', 'b.example')],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example/mcp');
    assert.deepStrictEqual(scope.properties.map(p => p.property_id).sort(), ['inline_a', 'inline_b']);
    // Top-level `main` is NOT included — inline overrides top-level.
    assert.ok(!scope.properties.some(p => p.property_id === 'main'));
  });

  test('filters revoked inline properties', () => {
    const file = {
      revoked_publisher_domains: ['a.example'],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'inline test',
          authorization_type: 'inline_properties',
          properties: [
            { ...makeProperty('inline_a', 'a.example'), publisher_domain: 'a.example' },
            { ...makeProperty('inline_b', 'b.example'), publisher_domain: 'b.example' },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example/mcp');
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['inline_b']
    );
  });
});

describe('resolveAgentProperties — legacy bare inline properties[]', () => {
  test('treats an entry without authorization_type but with properties[] as inline_properties', () => {
    const file = {
      properties: [makeProperty('top', 'top.example')],
      authorized_agents: [
        {
          url: 'https://legacy.example/mcp',
          authorized_for: 'legacy inline',
          properties: [makeProperty('inline_a', 'a.example'), makeProperty('inline_b', 'b.example')],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://legacy.example/mcp');
    assert.deepStrictEqual(scope.properties.map(p => p.property_id).sort(), ['inline_a', 'inline_b']);
    assert.strictEqual(scope.unresolvable, undefined);
  });

  test('applies revoked_publisher_domains to legacy bare inline properties', () => {
    const file = {
      revoked_publisher_domains: ['a.example'],
      authorized_agents: [
        {
          url: 'https://legacy.example/mcp',
          authorized_for: 'legacy inline',
          properties: [
            { ...makeProperty('inline_a', 'a.example'), publisher_domain: 'a.example' },
            { ...makeProperty('inline_b', 'b.example'), publisher_domain: 'b.example' },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://legacy.example/mcp');
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['inline_b']
    );
  });

  test('schema-declared files do not enable legacy bare inline compatibility', () => {
    const file = {
      $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
      authorized_agents: [
        {
          url: 'https://legacy.example/mcp',
          authorized_for: 'legacy inline',
          properties: [makeProperty('inline_a', 'a.example')],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://legacy.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'missing_authorization_type');
  });
});

describe('resolveAgentProperties — authorization_type: publisher_properties', () => {
  test('returns cross-publisher selectors for caller to resolve', () => {
    const file = {
      properties: [],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'cross-pub',
          authorization_type: 'publisher_properties',
          publisher_properties: [
            { publisher_domain: 'other.example', selection_type: 'all' },
            { publisher_domain: 'third.example', selection_type: 'by_id', property_ids: ['x'] },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.cross_publisher.length, 2);
    assert.strictEqual(scope.cross_publisher[0].publisher_domain, 'other.example');
    // Singular entries pass through to `_expanded` unchanged.
    assert.strictEqual(scope.cross_publisher_expanded.length, 2);
    assert.deepStrictEqual(
      scope.cross_publisher_expanded.map(s => s.publisher_domain),
      ['other.example', 'third.example']
    );
  });

  test('compact publisher_domains[] entries fan out in cross_publisher_expanded (adcp#4504)', () => {
    const file = {
      properties: [],
      authorized_agents: [
        {
          url: 'https://network.example/mcp',
          authorized_for: 'managed network',
          authorization_type: 'publisher_properties',
          publisher_properties: [
            {
              publisher_domains: ['site1.example', 'site2.example', 'site3.example'],
              selection_type: 'by_tag',
              property_tags: ['managed_network'],
            },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://network.example/mcp');
    // Wire form preserved as authored.
    assert.strictEqual(scope.cross_publisher.length, 1);
    assert.deepStrictEqual(scope.cross_publisher[0].publisher_domains, [
      'site1.example',
      'site2.example',
      'site3.example',
    ]);
    // Expanded form fans out per publisher, carrying the by_tag predicate.
    assert.strictEqual(scope.cross_publisher_expanded.length, 3);
    for (const entry of scope.cross_publisher_expanded) {
      assert.strictEqual(entry.selection_type, 'by_tag');
      assert.deepStrictEqual(entry.property_tags, ['managed_network']);
    }
    assert.deepStrictEqual(
      scope.cross_publisher_expanded.map(s => s.publisher_domain),
      ['site1.example', 'site2.example', 'site3.example']
    );
  });

  test('mixed singular + compact selectors expand in order', () => {
    const file = {
      properties: [],
      authorized_agents: [
        {
          url: 'https://mixed.example/mcp',
          authorized_for: 'mixed',
          authorization_type: 'publisher_properties',
          publisher_properties: [
            { publisher_domain: 'first.example', selection_type: 'all' },
            { publisher_domains: ['second.example', 'third.example'], selection_type: 'all' },
            { publisher_domain: 'fourth.example', selection_type: 'by_id', property_ids: ['x'] },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://mixed.example/mcp');
    assert.deepStrictEqual(
      scope.cross_publisher_expanded.map(s => s.publisher_domain),
      ['first.example', 'second.example', 'third.example', 'fourth.example']
    );
  });
});

describe('resolveAgentProperties — managed network scale (Raptive/Cafe Media shape)', () => {
  test('handles 6,800-domain compact selector without performance cliff', () => {
    // Real-world shape from Raptive/Cafe Media's production adagents.json
    // (https://cafemedia.com/.well-known/adagents.json as of 2026-05).
    // One authorized agent, one publisher_properties[] entry with a single
    // by_tag selector carrying 6,800 publisher domains. Validates that the
    // fanout is O(n) and doesn't choke at production scale.
    const domains = Array.from({ length: 6800 }, (_, i) => `site${i}.example`);
    const file = {
      authorized_agents: [
        {
          url: 'https://interchange.io',
          authorized_for: 'managed network',
          authorization_type: 'publisher_properties',
          publisher_properties: [
            {
              publisher_domains: domains,
              selection_type: 'by_tag',
              property_tags: ['raptive_managed'],
            },
          ],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://interchange.io');
    assert.strictEqual(scope.cross_publisher.length, 1);
    assert.strictEqual(scope.cross_publisher_expanded.length, 6800);
    // Spot-check first and last to confirm order preservation + predicate propagation.
    assert.strictEqual(scope.cross_publisher_expanded[0].publisher_domain, 'site0.example');
    assert.strictEqual(scope.cross_publisher_expanded[6799].publisher_domain, 'site6799.example');
    assert.deepStrictEqual(scope.cross_publisher_expanded[0].property_tags, ['raptive_managed']);
  });
});

describe('listAgentPropertyMap — compact publisher_properties (adcp#4504)', () => {
  test('exposes both wire-shape selectors and expanded singular form per agent', () => {
    const file = {
      authorized_agents: [
        {
          url: 'https://network.example/mcp',
          authorized_for: 'managed network',
          authorization_type: 'publisher_properties',
          publisher_properties: [
            {
              publisher_domains: ['a.example', 'b.example'],
              selection_type: 'by_tag',
              property_tags: ['ctv'],
            },
          ],
        },
      ],
    };
    const result = listAgentPropertyMap(file);
    assert.strictEqual(result.cross_publisher.length, 1);
    const entry = result.cross_publisher[0];
    // Wire shape preserved.
    assert.deepStrictEqual(entry.selectors[0].publisher_domains, ['a.example', 'b.example']);
    // Expanded shape ready for indexing.
    assert.deepStrictEqual(
      entry.expanded.map(s => s.publisher_domain),
      ['a.example', 'b.example']
    );
  });
});

describe('resolveAgentProperties — authorization_type: signal_ids / signal_tags', () => {
  test('signals authorization_type produces no property output', () => {
    const file = {
      properties: [makeProperty('main', 'main.example')],
      authorized_agents: [
        {
          url: 'https://signals.example/mcp',
          authorized_for: 'signals',
          authorization_type: 'signal_ids',
          signal_ids: ['sig1'],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://signals.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'signals_only');
  });
});

describe('resolveAgentProperties — fail-closed behavior (#1721 spec parity with Python SDK)', () => {
  test('agent not in authorized_agents → unresolvable: agent_not_listed', () => {
    const file = {
      properties: [makeProperty('main', 'main.example')],
      authorized_agents: [
        {
          url: 'https://other.example/mcp',
          authorized_for: 'other',
          authorization_type: 'property_ids',
          property_ids: ['main'],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://not-listed.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'agent_not_listed');
  });

  test('missing authorization_type → unresolvable: missing_authorization_type (issue example)', () => {
    // The Wonderstruck/Interchange production case from #1721:
    // both agents listed, neither has authorization_type. Python SDK
    // resolves to 0 properties. TS SDK (post-fix) must agree.
    const file = {
      properties: [
        {
          property_id: 'main_site',
          property_type: 'website',
          name: 'main',
          identifiers: [{ type: 'domain', value: 'main.example' }],
        },
      ],
      authorized_agents: [
        { url: 'https://wonderstruck.sales-agent.scope3.com', authorized_for: '...' },
        { url: 'https://interchange.io', authorized_for: '...' },
      ],
    };
    for (const agent of ['https://wonderstruck.sales-agent.scope3.com', 'https://interchange.io']) {
      const scope = resolveAgentProperties(file, agent);
      assert.strictEqual(scope.properties.length, 0, `expected 0 properties for ${agent}`);
      assert.strictEqual(scope.unresolvable, 'missing_authorization_type');
    }
  });

  test('revoked top-level publisher domains are filtered from property_ids and property_tags scopes', () => {
    const file = {
      revoked_publisher_domains: [{ publisher_domain: 'a.example', revoked_at: '2026-01-01T00:00:00Z' }],
      properties: [
        { ...makeProperty('revoked', 'a.example', ['news']), publisher_domain: 'a.example' },
        { ...makeProperty('kept', 'b.example', ['news']), publisher_domain: 'b.example' },
      ],
      authorized_agents: [
        {
          url: 'https://ids.example/mcp',
          authorized_for: 'ids',
          authorization_type: 'property_ids',
          property_ids: ['revoked', 'kept'],
        },
        {
          url: 'https://tags.example/mcp',
          authorized_for: 'tags',
          authorization_type: 'property_tags',
          property_tags: ['news'],
        },
      ],
    };
    const idsScope = resolveAgentProperties(file, 'https://ids.example/mcp');
    const tagsScope = resolveAgentProperties(file, 'https://tags.example/mcp');
    assert.deepStrictEqual(
      idsScope.properties.map(p => p.property_id),
      ['kept']
    );
    assert.deepStrictEqual(
      tagsScope.properties.map(p => p.property_id),
      ['kept']
    );
  });

  test('revoked publisher domains also match domain identifiers when publisher_domain is absent', () => {
    const file = {
      revoked_publisher_domains: [{ publisher_domain: 'a.example', revoked_at: '2026-01-01T00:00:00Z' }],
      properties: [makeProperty('revoked', 'a.example'), makeProperty('kept', 'b.example')],
      authorized_agents: [
        {
          url: 'https://ids.example/mcp',
          authorized_for: 'ids',
          authorization_type: 'property_ids',
          property_ids: ['revoked', 'kept'],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://ids.example/mcp');
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['kept']
    );
  });

  test('unknown authorization_type → unresolvable: unknown_authorization_type', () => {
    const file = {
      properties: [makeProperty('main', 'main.example')],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'unknown',
          authorization_type: 'made_up_type',
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'unknown_authorization_type');
  });

  test('declared authorization_type but selector field missing → missing_selector', () => {
    const file = {
      properties: [makeProperty('main', 'main.example')],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'no selector',
          authorization_type: 'property_ids',
          // property_ids: [] omitted
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example/mcp');
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'missing_selector');
  });
});

describe('listAgentPropertyMap', () => {
  test('produces a per-agent property map skipping signals and malformed entries', () => {
    const file = {
      properties: [makeProperty('home', 'home.example'), makeProperty('news', 'news.example')],
      authorized_agents: [
        {
          url: 'https://news.example/mcp',
          authorized_for: 'news',
          authorization_type: 'property_ids',
          property_ids: ['news'],
        },
        {
          url: 'https://legacy.example/mcp',
          authorized_for: 'legacy (no authorization_type)',
        },
        {
          url: 'https://signals.example/mcp',
          authorized_for: 'signals',
          authorization_type: 'signal_ids',
          signal_ids: ['s1'],
        },
      ],
    };
    const result = listAgentPropertyMap(file);
    assert.strictEqual(result.byAgent.size, 1);
    assert.deepStrictEqual(
      result.byAgent.get('https://news.example/mcp').map(p => p.property_id),
      ['news']
    );
    assert.strictEqual(result.unresolved.length, 2);
    assert.ok(result.unresolved.some(u => u.reason === 'missing_authorization_type'));
    assert.ok(result.unresolved.some(u => u.reason === 'signals_only'));
  });
});

describe('getAllProperties', () => {
  test(
    'is exported from the root SDK entry point',
    { skip: Number(process.versions.node.split('.')[0]) < 20 ? 'root CJS entry requires Node 20+ dev stack' : false },
    () => {
      const { getAllProperties: rootGetAllProperties } = require('../../dist/lib/index.js');
      assert.strictEqual(rootGetAllProperties, getAllProperties);
    }
  );

  test('sums per-agent resolved properties instead of returning the top-level catalog length', () => {
    const file = {
      properties: [
        makeProperty('p1', 'one.example'),
        makeProperty('p2', 'two.example'),
        makeProperty('p3', 'three.example'),
      ],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'subset',
          authorization_type: 'property_ids',
          property_ids: ['p1', 'p2'],
        },
      ],
    };
    assert.deepStrictEqual(
      getAllProperties(file).map(p => p.property_id),
      ['p1', 'p2']
    );
  });

  test('preserves duplicate properties across multiple agent scopes', () => {
    const file = {
      properties: [makeProperty('p1', 'one.example')],
      authorized_agents: [
        {
          url: 'https://agent-a.example/mcp',
          authorized_for: 'one',
          authorization_type: 'property_ids',
          property_ids: ['p1'],
        },
        {
          url: 'https://agent-b.example/mcp',
          authorized_for: 'one',
          authorization_type: 'property_ids',
          property_ids: ['p1'],
        },
      ],
    };
    assert.deepStrictEqual(
      getAllProperties(file).map(p => p.property_id),
      ['p1', 'p1']
    );
  });

  test('falls back to top-level properties when no agent resolves locally, filtering revoked domains', () => {
    const file = {
      revoked_publisher_domains: [{ publisher_domain: 'revoked.example', revoked_at: '2026-01-01T00:00:00Z' }],
      properties: [
        { ...makeProperty('revoked', 'revoked.example'), publisher_domain: 'revoked.example' },
        { ...makeProperty('kept', 'kept.example'), publisher_domain: 'kept.example' },
      ],
      authorized_agents: [
        {
          url: 'https://signals.example/mcp',
          authorized_for: 'signals',
          authorization_type: 'signal_ids',
          signal_ids: ['s1'],
        },
      ],
    };
    assert.deepStrictEqual(
      getAllProperties(file).map(p => p.property_id),
      ['kept']
    );
  });

  test('resolves canonical-equivalent duplicate entries independently', () => {
    const file = {
      properties: [makeProperty('p1', 'one.example'), makeProperty('p2', 'two.example')],
      authorized_agents: [
        {
          url: 'https://agent.example/mcp',
          authorized_for: 'first',
          authorization_type: 'property_ids',
          property_ids: ['p1'],
        },
        {
          url: 'https://agent.example:443/mcp',
          authorized_for: 'second',
          authorization_type: 'property_ids',
          property_ids: ['p2'],
        },
      ],
    };
    assert.deepStrictEqual(
      getAllProperties(file).map(p => p.property_id),
      ['p1', 'p2']
    );
  });
});
