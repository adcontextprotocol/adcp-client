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
    for (const v of ['3.3', '3.3.0', '3.3.1', '3.3-beta.6', '3.3.0-beta.6', '3.3.0-rc.1', '3.4', '4.0.0']) {
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

  test('an exact entry wins over an origin-only entry for the same agent', () => {
    const both = {
      properties: [property('home'), property('news')],
      authorized_agents: [
        entry('https://agent.example.com', ['home']),
        entry('https://agent.example.com/mcp', ['news']),
      ],
    };
    for (const v of [V32, V33]) {
      const scope = resolveAgentProperties(both, 'https://agent.example.com/mcp', { adcpVersion: v });
      assert.deepStrictEqual(
        scope.properties.map(p => p.property_id),
        ['news'],
        v
      );
    }
    // A sibling path on the same origin falls back to the origin-only entry at 3.3 only.
    assert.deepStrictEqual(
      resolveAgentProperties(both, 'https://agent.example.com/a2a', { adcpVersion: V33 }).properties.map(
        p => p.property_id
      ),
      ['home']
    );
    assert.strictEqual(
      resolveAgentProperties(both, 'https://agent.example.com/a2a', { adcpVersion: V32 }).unresolvable,
      'agent_not_listed'
    );
  });

  test('two origin-only entries for the same origin fail closed', () => {
    const dup = {
      properties: [property('home'), property('news')],
      authorized_agents: [
        entry('https://agent.example.com', ['home']),
        entry('https://Agent.Example.com:443/', ['news']),
      ],
    };
    const scope = resolveAgentProperties(dup, 'https://agent.example.com/mcp', { adcpVersion: V33 });
    assert.strictEqual(scope.unresolvable, 'ambiguous_agent_url');
    assert.strictEqual(scope.properties.length, 0);
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
  function crawlerFor(config, servedVersion) {
    class TestCrawler extends PropertyCrawler {
      async crawlAgent(agentInfo) {
        if (servedVersion) this.servedVersions.set(agentInfo.agent_url, servedVersion);
        return ['publisher.example'];
      }
      async fetchPublisherProperties() {
        const adAgents = {
          properties: [property('home')],
          authorized_agents: [entry('https://agent.example.com', ['home'])],
        };
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
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.3.0-beta.6' })), ['home']);
  });

  test('targeting 3.2 does not', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.2' })), []);
  });

  test('a 3.2 release negotiated with the agent overrides a 3.3 target', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({}, '3.2')), []);
  });

  test('a 3.3 release negotiated with the agent overrides a 3.2 target', async () => {
    assert.deepStrictEqual(await crawledProperties(crawlerFor({ adcpVersion: '3.2' }, '3.3-beta.6')), ['home']);
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
