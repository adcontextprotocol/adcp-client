const test = require('node:test');
const assert = require('node:assert');

const { AgentClient } = require('../../dist/lib/core/AgentClient');

const AGENT_ORIGIN = 'https://seller.example';
const EXTENDED_ORIGIN = 'https://card-service.example';

function nativeExtendedCard() {
  return {
    protocolVersion: '1.0',
    name: 'extended-card-fixture',
    description: 'Cross-origin extended card fixture',
    version: '1.0.0',
    capabilities: { extendedAgentCard: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [],
    supportedInterfaces: [{ url: `${EXTENDED_ORIGIN}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  };
}

function credentialedClient(seenUrls) {
  const trustedFetchFn = async input => {
    const url = String(input);
    seenUrls.push(url);
    if (url.startsWith(AGENT_ORIGIN) && url.includes('/.well-known/')) {
      return new Response(JSON.stringify(nativeExtendedCard()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected network call: ${url}`);
  };
  return new AgentClient(
    {
      id: 'native-extended-card-origin',
      agent_uri: AGENT_ORIGIN,
      protocol: 'a2a',
      name: 'native-extended-card-origin',
      headers: { 'X-Session': 'custom-sentinel' },
    },
    { transport: { trustedFetchFn, legacyCompat: { enabled: false } } }
  );
}

async function assertCrossOriginExtendedCardRefused(invoke) {
  const seenUrls = [];
  const client = credentialedClient(seenUrls);
  await assert.rejects(invoke(client), error => {
    assert.match(error.message, /native discovery refused credentialed cross-origin dispatch/);
    assert.match(error.message, /x-session/);
    return true;
  });
  assert.ok(
    seenUrls.some(url => url.startsWith(AGENT_ORIGIN)),
    'same-origin public card must be fetched'
  );
  assert.ok(
    seenUrls.every(url => !url.startsWith(EXTENDED_ORIGIN)),
    'cross-origin extended-card endpoint must be refused before the network call'
  );
}

test('getAgentInfo refuses credentials on a native cross-origin extended-card request', async () => {
  await assertCrossOriginExtendedCardRefused(client => () => client.getAgentInfo());
});

test('canonical URL discovery refuses credentials on a native cross-origin extended-card request', async () => {
  await assertCrossOriginExtendedCardRefused(client => () => client.resolveCanonicalUrl());
});

test('getAgentInfo strips configured headers before following a native cross-origin redirect', async () => {
  const seenUrls = [];
  let redirectedSession;
  const trustedFetchFn = async (input, init = {}) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.startsWith(AGENT_ORIGIN) && url.includes('/.well-known/')) {
      return new Response(
        JSON.stringify({
          ...nativeExtendedCard(),
          supportedInterfaces: [{ url: `${AGENT_ORIGIN}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === `${AGENT_ORIGIN}/rpc`) {
      return new Response(null, { status: 307, headers: { location: `${EXTENDED_ORIGIN}/rpc` } });
    }
    if (url === `${EXTENDED_ORIGIN}/rpc`) {
      redirectedSession = new Headers(init.headers).get('x-session');
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: nativeExtendedCard() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected cross-origin network call: ${url}`);
  };
  const client = new AgentClient(
    {
      id: 'native-extended-card-redirect',
      agent_uri: AGENT_ORIGIN,
      protocol: 'a2a',
      name: 'native-extended-card-redirect',
      headers: { 'X-Session': 'redirect-sentinel' },
    },
    { transport: { trustedFetchFn, legacyCompat: { enabled: false } } }
  );

  await client.getAgentInfo();
  assert.ok(seenUrls.includes(`${AGENT_ORIGIN}/rpc`), 'same-origin extended-card endpoint must be attempted');
  assert.ok(seenUrls.includes(`${EXTENDED_ORIGIN}/rpc`), 'cross-origin redirect target must be followed safely');
  assert.strictEqual(redirectedSession, null, 'configured header must not cross the redirect origin');
});

test('same-origin native extended-card discovery preserves configured custom headers', async () => {
  const receivedSessions = [];
  const rpcUrl = `${AGENT_ORIGIN}/rpc`;
  const trustedFetchFn = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/.well-known/')) {
      return new Response(
        JSON.stringify({
          ...nativeExtendedCard(),
          supportedInterfaces: [{ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    assert.strictEqual(url, rpcUrl);
    receivedSessions.push(new Headers(init.headers).get('x-session'));
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: nativeExtendedCard() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const makeClient = () =>
    new AgentClient(
      {
        id: 'native-extended-card-same-origin',
        agent_uri: AGENT_ORIGIN,
        protocol: 'a2a',
        name: 'native-extended-card-same-origin',
        headers: { 'X-Session': 'same-origin-session' },
      },
      { transport: { trustedFetchFn, legacyCompat: { enabled: false } } }
    );

  await makeClient().getAgentInfo();
  await makeClient().resolveCanonicalUrl();
  assert.deepStrictEqual(receivedSessions, ['same-origin-session', 'same-origin-session']);
});

test('native canonical identity uses the selected JSONRPC interface URL including its path', async () => {
  const rpcUrl = `${AGENT_ORIGIN}/tenant/a/rpc`;
  const trustedFetchFn = async input => {
    const url = String(input);
    assert.match(url, /\.well-known\/agent-(?:card\.)?json/);
    return new Response(
      JSON.stringify({
        protocolVersion: '1.0',
        name: 'native-canonical-interface',
        description: 'Canonical interface fixture',
        version: '1.0.0',
        capabilities: {},
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
        supportedInterfaces: [
          {
            url: `${AGENT_ORIGIN}/tenant/a/rest`,
            protocolBinding: 'HTTP+JSON',
            protocolVersion: '1.0',
          },
          { url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        ],
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  };
  const client = new AgentClient(
    {
      id: 'native-canonical-interface',
      agent_uri: AGENT_ORIGIN,
      protocol: 'a2a',
      name: 'native-canonical-interface',
    },
    { transport: { trustedFetchFn, legacyCompat: { enabled: false } } }
  );

  assert.strictEqual(await client.resolveCanonicalUrl(), rpcUrl);
  assert.strictEqual(
    await client.isSameAgentResolved({
      id: 'native-canonical-rpc',
      agent_uri: rpcUrl,
      protocol: 'a2a',
      name: 'native-canonical-rpc',
    }),
    true
  );
  assert.strictEqual(
    await client.isSameAgentResolved({
      id: 'native-root-only',
      agent_uri: AGENT_ORIGIN,
      protocol: 'a2a',
      name: 'native-root-only',
    }),
    false
  );
});

test('legacy canonical identity continues to use agent card url', async () => {
  const legacyUrl = `${AGENT_ORIGIN}/legacy/a2a`;
  const trustedFetchFn = async input => {
    const url = String(input);
    assert.match(url, /\.well-known\/agent-(?:card\.)?json/);
    return new Response(
      JSON.stringify({
        protocolVersion: '0.3.0',
        name: 'legacy-canonical-url',
        description: 'Legacy canonical URL fixture',
        version: '1.0.0',
        url: legacyUrl,
        capabilities: {},
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  };
  const client = new AgentClient(
    {
      id: 'legacy-canonical-url',
      agent_uri: AGENT_ORIGIN,
      protocol: 'a2a',
      name: 'legacy-canonical-url',
    },
    { transport: { trustedFetchFn, legacyCompat: { enabled: true } } }
  );

  assert.strictEqual(await client.resolveCanonicalUrl(), legacyUrl);
});
