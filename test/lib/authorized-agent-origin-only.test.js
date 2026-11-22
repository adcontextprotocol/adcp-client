/**
 * Origin-only `authorized_agents[].url` matching (adcp-client#3695).
 *
 * adcontextprotocol/adcp#8939 (for adcp#8862, under DR-0023) documents the
 * 3.3 rule: an entry whose canonical form has the root path and no query
 * authorizes the agent at that origin whatever its path; an entry with a path
 * matches that canonical URL only. 3.2 and earlier keep exact canonical-URL
 * matching. The server counterpart is adcontextprotocol/adcp#8943.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  agentUrlMatchesAuthorizedEntry,
  usesOriginOnlyAgentMatching,
  resolveAgentProperties,
} = require('../../dist/lib/discovery/resolve-agent-properties.js');
const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
const { getPropertyIndex, resetPropertyIndex } = require('../../dist/lib/discovery/property-index.js');
const { evaluateSupplyPath } = require('../../dist/lib/supply-path/evaluate.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const V33 = '3.3';
const V32 = '3.2';

function matches(entryUrl, agentUrl, adcpVersion) {
  return agentUrlMatchesAuthorizedEntry(entryUrl, agentUrl, { adcpVersion });
}

function property(id) {
  return {
    property_id: id,
    property_type: 'website',
    name: `${id}.example`,
    identifiers: [{ type: 'domain', value: `${id}.example` }],
  };
}

function entry(url, propertyIds) {
  return { url, authorized_for: 'test', authorization_type: 'property_ids', property_ids: propertyIds };
}

describe('usesOriginOnlyAgentMatching', () => {
  test('3.3 releases and prereleases use the origin-only rule', () => {
    for (const v of ['3.3', '3.3.0', '3.3.1', '3.3-rc.0', '3.3.0-rc.0', '3.3.0-rc.1', '3.4', '4.0.0']) {
      assert.strictEqual(usesOriginOnlyAgentMatching(v), true, v);
    }
  });

  test('3.2 and earlier keep exact matching', () => {
    for (const v of ['3.2', '3.2.8', '3.2.0-beta.6', '3.1', '3.0.1', '3.0']) {
      assert.strictEqual(usesOriginOnlyAgentMatching(v), false, v);
    }
  });

  test('an unparseable version fails closed to exact matching', () => {
    for (const v of ['v3', 'latest', '', 'not-a-version']) {
      assert.strictEqual(usesOriginOnlyAgentMatching(v), false, JSON.stringify(v));
    }
  });

  test('omitted version follows the SDK pin', () => {
    assert.strictEqual(usesOriginOnlyAgentMatching(), usesOriginOnlyAgentMatching(ADCP_VERSION));
    assert.strictEqual(usesOriginOnlyAgentMatching(), true, `SDK pin ${ADCP_VERSION} targets 3.3`);
  });
});

describe('agentUrlMatchesAuthorizedEntry — origin-only entry, agent at a deeper path', () => {
  test('matches under 3.3', () => {
    assert.strictEqual(matches('https://agent.example.com', 'https://agent.example.com/mcp', V33), true);
    assert.strictEqual(matches('https://agent.example.com/', 'https://agent.example.com/a2a', V33), true);
    assert.strictEqual(matches('https://agent.example.com', 'https://agent.example.com/tenants/acme/mcp/', V33), true);
    assert.strictEqual(matches('https://agent.example.com', 'https://agent.example.com/mcp?x=1', V33), true);
  });

  test('does not match under 3.2', () => {
    assert.strictEqual(matches('https://agent.example.com', 'https://agent.example.com/mcp', V32), false);
    assert.strictEqual(matches('https://agent.example.com/', 'https://agent.example.com/a2a', V32), false);
  });

  test('still matches an agent served at the root under both', () => {
    for (const v of [V32, V33]) {
      assert.strictEqual(matches('https://agent.example.com', 'https://agent.example.com', v), true, v);
      assert.strictEqual(matches('https://agent.example.com', 'https://agent.example.com/', v), true, v);
      assert.strictEqual(matches('https://agent.example.com/', 'https://agent.example.com', v), true, v);
    }
  });

  test('defaults to the SDK pin (3.3) when no version is given', () => {
    assert.strictEqual(
      agentUrlMatchesAuthorizedEntry('https://agent.example.com', 'https://agent.example.com/mcp'),
      true
    );
  });
});

describe('agentUrlMatchesAuthorizedEntry — a different origin never matches', () => {
  const cases = [
    ['https://agent.example.com', 'https://other.example.com/mcp', 'different host'],
    ['https://agent.example.com', 'https://sub.agent.example.com/mcp', 'subdomain'],
    ['https://example.com', 'https://agent.example.com/mcp', 'parent domain'],
    ['https://agent.example.com', 'http://agent.example.com/mcp', 'different scheme'],
    ['http://agent.example.com', 'https://agent.example.com/mcp', 'different scheme (reverse)'],
    ['https://agent.example.com', 'https://agent.example.com:8443/mcp', 'non-default port on agent'],
    ['https://agent.example.com:8443', 'https://agent.example.com/mcp', 'non-default port on entry'],
    ['https://agent.example.com:8443', 'https://agent.example.com:9443/mcp', 'different non-default ports'],
    ['https://agent.example.com', 'https://agent.example.com.evil.example/mcp', 'suffix host'],
  ];
  for (const [entryUrl, agentUrl, label] of cases) {
    test(label, () => {
      assert.strictEqual(matches(entryUrl, agentUrl, V33), false);
      assert.strictEqual(matches(entryUrl, agentUrl, V32), false);
    });
  }
});

describe('agentUrlMatchesAuthorizedEntry — an entry with a path matches exactly only', () => {
  for (const v of [V32, V33]) {
    test(`at ${v}`, () => {
      assert.strictEqual(
        matches('https://platform.example/tenants/acme/mcp', 'https://platform.example/tenants/acme/mcp', v),
        true
      );
      // Another tenant on the same host stays distinct.
      assert.strictEqual(
        matches('https://platform.example/tenants/acme/mcp', 'https://platform.example/tenants/beta/mcp', v),
        false
      );
      // A path entry never widens to deeper paths or to the bare origin.
      assert.strictEqual(
        matches('https://platform.example/tenants/acme', 'https://platform.example/tenants/acme/mcp', v),
        false
      );
      assert.strictEqual(matches('https://platform.example/mcp', 'https://platform.example', v), false);
      // Trailing slash, path case and query stay significant for a path entry.
      assert.strictEqual(matches('https://platform.example/mcp', 'https://platform.example/mcp/', v), false);
      assert.strictEqual(matches('https://platform.example/mcp/', 'https://platform.example/mcp', v), false);
      assert.strictEqual(matches('https://platform.example/mcp', 'https://platform.example/MCP', v), false);
      assert.strictEqual(matches('https://platform.example/mcp?tenant=a', 'https://platform.example/mcp', v), false);
    });
  }

  test('an entry with a root path and a query is not origin-only', () => {
    assert.strictEqual(matches('https://agent.example.com/?tenant=acme', 'https://agent.example.com/mcp', V33), false);
    assert.strictEqual(
      matches('https://agent.example.com/?tenant=acme', 'https://agent.example.com/?tenant=acme', V33),
      true
    );
  });

  test('an entry with an empty query marker is not origin-only', () => {
    assert.strictEqual(matches('https://agent.example.com/?', 'https://agent.example.com/mcp', V33), false);
    assert.strictEqual(matches('https://agent.example.com?', 'https://agent.example.com/mcp', V33), false);
  });
});

describe('agentUrlMatchesAuthorizedEntry — normalization', () => {
  for (const v of [V32, V33]) {
    test(`exact matches canonicalize both sides at ${v}`, () => {
      // Scheme and host case.
      assert.strictEqual(matches('HTTPS://Agent.Example.COM/mcp', 'https://agent.example.com/mcp', v), true);
      // Default ports.
      assert.strictEqual(matches('https://agent.example.com:443/mcp', 'https://agent.example.com/mcp', v), true);
      assert.strictEqual(matches('http://agent.example.com:80/mcp', 'http://agent.example.com/mcp', v), true);
      // Unreserved percent-encoding and dot segments.
      assert.strictEqual(matches('https://agent.example.com/%6Dcp', 'https://agent.example.com/mcp', v), true);
      assert.strictEqual(matches('https://agent.example.com/a/../mcp', 'https://agent.example.com/mcp', v), true);
      // Fragments never participate.
      assert.strictEqual(matches('https://agent.example.com/mcp#x', 'https://agent.example.com/mcp', v), true);
    });
  }

  test('origin-only detection runs on the canonical form at 3.3', () => {
    const agent = 'https://agent.example.com/mcp';
    // Trailing slash or none, scheme and host case, default port, fragment, dot segments.
    for (const entryUrl of [
      'https://agent.example.com',
      'https://agent.example.com/',
      'HTTPS://AGENT.example.com',
      'https://Agent.Example.Com:443',
      'https://agent.example.com:443/',
      'https://agent.example.com/#frag',
      'https://agent.example.com/./',
      'https://agent.example.com/mcp/..',
    ]) {
      assert.strictEqual(matches(entryUrl, agent, V33), true, entryUrl);
      assert.strictEqual(matches(entryUrl, agent, V32), false, entryUrl);
    }
    // Agent side is canonicalized too.
    assert.strictEqual(matches('https://agent.example.com', 'HTTPS://Agent.Example.COM:443/mcp', V33), true);
    // A non-default port is part of the origin.
    assert.strictEqual(matches('https://agent.example.com:8443', 'https://agent.example.com:8443/mcp', V33), true);
    assert.strictEqual(matches('http://agent.example.com:80', 'http://agent.example.com/mcp', V33), true);
  });

  test('IDN hosts compare in A-label form', () => {
    assert.strictEqual(matches('https://bücher.example', 'https://xn--bcher-kva.example/mcp', V33), true);
    assert.strictEqual(matches('https://bücher.example', 'https://xn--bcher-kva.example/mcp', V32), false);
  });

  test('unparseable or credentialed URLs never match', () => {
    assert.strictEqual(matches('not a url', 'https://agent.example.com/mcp', V33), false);
    assert.strictEqual(matches('https://agent.example.com', 'not a url', V33), false);
    assert.strictEqual(matches('https://user@agent.example.com', 'https://agent.example.com/mcp', V33), false);
    assert.strictEqual(matches('https://agent.example.com', 'https://user:pw@agent.example.com/mcp', V33), false);
    assert.strictEqual(matches('ftp://agent.example.com', 'ftp://agent.example.com/mcp', V33), false);
  });
});

describe('agentUrlMatchesAuthorizedEntry — trailing root dot on a DNS host (adcp#9011)', () => {
  test('one trailing dot is removed on both sides at 3.3', () => {
    assert.strictEqual(matches('https://a.example.', 'https://a.example/mcp', V33), true);
    assert.strictEqual(matches('https://a.example', 'https://a.example./mcp', V33), true);
    assert.strictEqual(matches('https://A.Example.:443/', 'https://a.example/mcp', V33), true);
    assert.strictEqual(matches('https://a.example.:8443', 'https://a.example:8443/mcp', V33), true);
    // Exact (path) entries compare dotless too.
    assert.strictEqual(matches('https://a.example./mcp', 'https://a.example/mcp', V33), true);
    assert.strictEqual(matches('https://a.example./mcp', 'https://a.example/a2a', V33), false);
    // The dot never widens across origins.
    assert.strictEqual(matches('https://a.example.', 'https://b.example/mcp', V33), false);
    assert.strictEqual(matches('https://a.example.', 'https://a.example:8443/mcp', V33), false);
  });

  test('more than one trailing dot matches nothing at 3.3', () => {
    for (const [entryUrl, agentUrl] of [
      ['https://a.example..', 'https://a.example/mcp'],
      ['https://a.example..', 'https://a.example../mcp'],
      ['https://a.example..', 'https://a.example..'],
      ['https://a.example', 'https://a.example../mcp'],
      ['https://a.example../mcp', 'https://a.example../mcp'],
    ]) {
      assert.strictEqual(matches(entryUrl, agentUrl, V33), false, `${entryUrl} vs ${agentUrl}`);
    }
  });

  test('3.2 stays exact on the canonical URL, dot included', () => {
    // A dotted entry matches a dotted agent at the same URL and nothing else.
    assert.strictEqual(matches('https://a.example./mcp', 'https://a.example./mcp', V32), true);
    assert.strictEqual(matches('https://a.example.', 'https://a.example.', V32), true);
    assert.strictEqual(matches('https://a.example./mcp', 'https://a.example/mcp', V32), false);
    assert.strictEqual(matches('https://a.example.', 'https://a.example/', V32), false);
    assert.strictEqual(matches('https://a.example.', 'https://a.example./mcp', V32), false);
    // Pre-3.3 behaviour for a doubled dot is unchanged: same canonical URL, same answer.
    assert.strictEqual(matches('https://a.example../mcp', 'https://a.example../mcp', V32), true);
  });

  test('IPv6 literals are untouched', () => {
    assert.strictEqual(matches('https://[2001:db8::1]', 'https://[2001:DB8::1]/mcp', V33), true);
    assert.strictEqual(matches('https://[2001:db8::1]/mcp', 'https://[2001:db8::1]/mcp', V32), true);
  });
});

describe('userinfo is rejected, never stripped', () => {
  for (const v of [V32, V33]) {
    test(`an entry or agent with userinfo matches nothing at ${v}`, () => {
      assert.strictEqual(matches('https://user@a.example', 'https://a.example/mcp', v), false);
      assert.strictEqual(matches('https://user:pw@a.example/mcp', 'https://a.example/mcp', v), false);
      assert.strictEqual(matches('https://a.example', 'https://user@a.example/mcp', v), false);
      assert.strictEqual(matches('https://a.example/mcp', 'https://user:pw@a.example/mcp', v), false);
      assert.strictEqual(matches('https://user@a.example/mcp', 'https://user@a.example/mcp', v), false);
      assert.strictEqual(
        resolveAgentProperties(
          { properties: [property('home')], authorized_agents: [entry('https://user:pw@a.example', ['home'])] },
          'https://a.example/mcp',
          { adcpVersion: v }
        ).unresolvable,
        'agent_not_listed'
      );
      assert.strictEqual(
        resolveAgentProperties(
          { properties: [property('home')], authorized_agents: [entry('https://a.example', ['home'])] },
          'https://user@a.example/mcp',
          { adcpVersion: v }
        ).unresolvable,
        'agent_not_listed'
      );
    });
  }
});

describe('resolveAgentProperties — origin-only entries', () => {
  const file = {
    properties: [property('home'), property('news')],
    authorized_agents: [entry('https://agent.example.com', ['home'])],
  };

  test('an origin-only entry authorizes an agent at a deeper path under 3.3', () => {
    const scope = resolveAgentProperties(file, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['home']
    );
    assert.strictEqual(scope.matched_entry, file.authorized_agents[0]);
    assert.strictEqual(scope.unresolvable, undefined);
  });

  test('the same file does not authorize that agent under 3.2', () => {
    const scope = resolveAgentProperties(file, 'https://agent.example.com/mcp', { adcpVersion: V32 });
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'agent_not_listed');
  });

  test('defaults to the SDK pin', () => {
    const scope = resolveAgentProperties(file, 'https://agent.example.com/mcp');
    assert.strictEqual(scope.properties.length, 1);
  });

  test('a different origin is never authorized', () => {
    for (const v of [V32, V33]) {
      const scope = resolveAgentProperties(file, 'https://other.example.com/mcp', { adcpVersion: v });
      assert.strictEqual(scope.unresolvable, 'agent_not_listed', v);
    }
  });

  test('an exact entry and an origin-only entry both authorize the agent at 3.3: the scope is their union', () => {
    const both = {
      properties: [property('home'), property('news'), property('sports')],
      authorized_agents: [
        entry('https://agent.example.com', ['home', 'sports']),
        entry('https://agent.example.com/mcp', ['news', 'sports']),
      ],
    };
    const scope = resolveAgentProperties(both, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['home', 'sports', 'news']
    );
    assert.strictEqual(scope.unresolvable, undefined);
    assert.strictEqual(scope.matched_entry, both.authorized_agents[0]);
    assert.deepStrictEqual(scope.matched_entries, both.authorized_agents);
    // A narrower exact entry never removes scope the origin-only entry grants, whatever the order.
    const reversed = { ...both, authorized_agents: [...both.authorized_agents].reverse() };
    assert.deepStrictEqual(
      resolveAgentProperties(reversed, 'https://agent.example.com/mcp', { adcpVersion: V33 })
        .properties.map(p => p.property_id)
        .sort(),
      ['home', 'news', 'sports']
    );
    // A sibling path on the same origin gets only the origin-only entry's scope.
    assert.deepStrictEqual(
      resolveAgentProperties(both, 'https://agent.example.com/a2a', { adcpVersion: V33 }).properties.map(
        p => p.property_id
      ),
      ['home', 'sports']
    );
  });

  test('3.2 is unchanged: only the exact entry matches', () => {
    const both = {
      properties: [property('home'), property('news')],
      authorized_agents: [
        entry('https://agent.example.com', ['home']),
        entry('https://agent.example.com/mcp', ['news']),
      ],
    };
    const scope = resolveAgentProperties(both, 'https://agent.example.com/mcp', { adcpVersion: V32 });
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['news']
    );
    assert.strictEqual(scope.matched_entries, undefined);
    assert.strictEqual(
      resolveAgentProperties(both, 'https://agent.example.com/a2a', { adcpVersion: V32 }).unresolvable,
      'agent_not_listed'
    );
  });

  test('two origin-only entries for the same origin combine at 3.3', () => {
    const dup = {
      properties: [property('home'), property('news')],
      authorized_agents: [
        entry('https://agent.example.com', ['home']),
        entry('https://Agent.Example.com:443/', ['news']),
      ],
    };
    const scope = resolveAgentProperties(dup, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.strictEqual(scope.unresolvable, undefined);
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['home', 'news']
    );
    assert.strictEqual(scope.matched_entries.length, 2);
  });

  test('union combines different authorization types and cross-publisher selectors', () => {
    const file = {
      properties: [property('home')],
      authorized_agents: [
        entry('https://agent.example.com', ['home']),
        {
          url: 'https://agent.example.com/mcp',
          authorized_for: 'inline',
          authorization_type: 'inline_properties',
          properties: [property('inline')],
        },
        {
          url: 'https://agent.example.com/mcp',
          authorized_for: 'network',
          authorization_type: 'publisher_properties',
          publisher_properties: [{ publisher_domain: 'other.example', selection_type: 'all' }],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['home', 'inline']
    );
    assert.deepStrictEqual(scope.cross_publisher, [{ publisher_domain: 'other.example', selection_type: 'all' }]);
    assert.strictEqual(scope.cross_publisher_expanded.length, 1);
    assert.strictEqual(scope.unresolvable, undefined);
  });

  test("an empty union reports the first matching entry's reason", () => {
    const file = {
      properties: [property('home')],
      authorized_agents: [
        entry('https://agent.example.com', ['ghost']),
        {
          url: 'https://agent.example.com/mcp',
          authorized_for: 'signals',
          authorization_type: 'signal_ids',
          signal_ids: ['s1'],
        },
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.strictEqual(scope.properties.length, 0);
    assert.strictEqual(scope.unresolvable, 'no_match');
    assert.strictEqual(scope.matched_entries.length, 2);
  });

  test("a matching entry with a selector problem does not hide another entry's scope", () => {
    const file = {
      properties: [property('home')],
      authorized_agents: [
        { url: 'https://agent.example.com', authorized_for: 'broken', authorization_type: 'property_ids' },
        entry('https://agent.example.com/mcp', ['home']),
      ],
    };
    const scope = resolveAgentProperties(file, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.deepStrictEqual(
      scope.properties.map(p => p.property_id),
      ['home']
    );
    assert.strictEqual(scope.unresolvable, undefined);
  });

  test('an entry with a path keeps exact matching under 3.3', () => {
    const pathFile = {
      properties: [property('home')],
      authorized_agents: [entry('https://platform.example/tenants/acme/mcp', ['home'])],
    };
    assert.strictEqual(
      resolveAgentProperties(pathFile, 'https://platform.example/tenants/acme/mcp', { adcpVersion: V33 }).properties
        .length,
      1
    );
    for (const agentUrl of [
      'https://platform.example/tenants/acme/mcp/',
      'https://platform.example/tenants/beta/mcp',
      'https://platform.example',
    ]) {
      assert.strictEqual(
        resolveAgentProperties(pathFile, agentUrl, { adcpVersion: V33 }).unresolvable,
        'agent_not_listed',
        agentUrl
      );
    }
  });
});

describe('PropertyCrawler — origin-only matching follows the negotiated or targeted release', () => {
  const ORIGIN_ONLY_FILE = {
    properties: [property('home')],
    authorized_agents: [entry('https://agent.example.com', ['home'])],
  };

  function crawlerFor(config, servedVersion, adAgents = ORIGIN_ONLY_FILE) {
    class TestCrawler extends PropertyCrawler {
      async crawlAgent(agentInfo) {
        if (servedVersion) this.servedVersions.set(agentInfo.agent_url, servedVersion);
        return ['publisher.example'];
      }
      async fetchPublisherProperties() {
        return {
          properties: { 'publisher.example': adAgents.properties },
          adAgents: { 'publisher.example': adAgents },
          warnings: [],
        };
      }
    }
    return new TestCrawler({ logLevel: 'silent', ...config });
  }

  async function crawledProperties(crawler) {
    resetPropertyIndex();
    try {
      await crawler.crawlAgents([{ agent_url: 'https://agent.example.com/mcp' }]);
      return (getPropertyIndex().getAgentAuthorizations('https://agent.example.com/mcp')?.properties ?? []).map(
        p => p.property_id
      );
    } finally {
      resetPropertyIndex();
    }
  }

  test('targeting 3.3 attributes the origin-only entry to an agent at /mcp', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.3.0-rc.3' })), ['home']);
  });

  test('targeting 3.2 does not', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.2' })), []);
  });

  test('a 3.2 release negotiated with the agent overrides a 3.3 target', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({}, '3.2')), []);
  });

  test('a 3.3 release negotiated with the agent overrides a 3.2 target', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.2' }, '3.3-rc.3')), ['home']);
  });

  test('at 3.3 an agent matched by an exact and an origin-only entry is attributed their union', async () => {
    const file = {
      properties: [property('home'), property('news')],
      authorized_agents: [
        entry('https://agent.example.com', ['home']),
        entry('https://agent.example.com/mcp', ['news']),
      ],
    };
    assert.deepStrictEqual(
      (await crawledProperties(crawlerFor({ adcpVersion: '3.3.0-rc.3' }, undefined, file))).sort(),
      ['home', 'news']
    );
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.2' }, undefined, file)), ['news']);
  });
});

describe('supply-path verification stays exact (adcp#8943)', () => {
  const corpus = require('../fixtures/supply-path/vectors.json');
  const vector = corpus.vectors.find(v => v.id === 'case-sensitive-agent-path');

  test('an origin-only owner entry does not declare an agent at a path (semantics v1)', () => {
    assert.ok(vector, 'case-sensitive-agent-path vector is present');
    assert.strictEqual(vector.input.ownerManifest.authorized_agents[0].url, 'https://sales.channel-owner.example');
    const verdict = evaluateSupplyPath(structuredClone(vector.input));
    assert.deepStrictEqual(verdict.legs.owner_agent_declared, { ok: false, failure: 'agent_not_declared_by_owner' });
  });

  test('control: the same owner entry naming the exact agent URL declares it', () => {
    const input = structuredClone(vector.input);
    input.ownerManifest.authorized_agents[0].url = input.agentUrl;
    assert.deepStrictEqual(evaluateSupplyPath(input).legs.owner_agent_declared, { ok: true });
  });
});

describe('resolveAgentProperties — trailing root dot', () => {
  test('a dotted origin-only entry authorizes an agent at a path at 3.3 only', () => {
    const file = { properties: [property('home')], authorized_agents: [entry('https://a.example.', ['home'])] };
    assert.strictEqual(
      resolveAgentProperties(file, 'https://a.example/mcp', { adcpVersion: V33 }).properties.length,
      1
    );
    assert.strictEqual(
      resolveAgentProperties(file, 'https://a.example/mcp', { adcpVersion: V32 }).unresolvable,
      'agent_not_listed'
    );
  });

  test('a doubled dot authorizes nothing at 3.3', () => {
    const file = { properties: [property('home')], authorized_agents: [entry('https://a.example..', ['home'])] };
    for (const agentUrl of ['https://a.example/mcp', 'https://a.example../mcp', 'https://a.example..']) {
      assert.strictEqual(
        resolveAgentProperties(file, agentUrl, { adcpVersion: V33 }).unresolvable,
        'agent_not_listed',
        agentUrl
      );
    }
  });

  test('dotted and dotless spellings of one origin-only entry combine at 3.3', () => {
    const file = {
      properties: [property('home'), property('news')],
      authorized_agents: [entry('https://a.example', ['home']), entry('https://a.example.', ['news'])],
    };
    assert.deepStrictEqual(
      resolveAgentProperties(file, 'https://a.example/mcp', { adcpVersion: V33 }).properties.map(p => p.property_id),
      ['home', 'news']
    );
  });
});
