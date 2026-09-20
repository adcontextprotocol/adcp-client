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
      auth_token: 'bearer-sentinel',
      headers: { 'x-api-key': 'custom-sentinel' },
    },
    { transport: { trustedFetchFn, legacyCompat: { enabled: false } } }
  );
}

async function assertCrossOriginExtendedCardRefused(invoke) {
  const seenUrls = [];
  const client = credentialedClient(seenUrls);
  await assert.rejects(invoke(client), error => {
    assert.match(error.message, /native discovery refused credentialed cross-origin dispatch/);
    assert.match(error.message, /authorization/);
    assert.match(error.message, /x-api-key/);
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
