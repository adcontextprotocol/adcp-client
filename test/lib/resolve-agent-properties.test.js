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
