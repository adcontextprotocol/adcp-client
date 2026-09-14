const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createA2AClientFromCardUrl } = require('../../dist/lib/index.js');

function legacyCard() {
  return {
    name: 'Legacy Agent',
    description: 'A2A 0.3 agent',
    url: 'https://legacy.example/a2a',
    preferredTransport: 'JSONRPC',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    capabilities: { streaming: false, pushNotifications: false },
    skills: [],
  };
}

function nativeCardWithLegacyInterface() {
  return {
    name: 'Versioned Agent',
    description: 'A v1-shaped card advertising a legacy interface',
    supportedInterfaces: [
      {
        url: 'https://legacy.example/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '0.3',
      },
    ],
    version: '1.0.0',
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    skills: [],
    securitySchemes: {},
    securityRequirements: [],
    signatures: [],
  };
}

function cardFetch(card) {
  return async () =>
    new Response(JSON.stringify(card), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('A2A client legacy compatibility override', () => {
  test('keeps compatibility enabled by default but lets callers require a native 1.0 card', async () => {
    const cardUrl = 'https://legacy.example/.well-known/agent.json';

    const compatible = await createA2AClientFromCardUrl(cardUrl, cardFetch(legacyCard()));
    assert.strictEqual(compatible.protocolVersion, '0.3');

    await assert.rejects(
      createA2AClientFromCardUrl(cardUrl, cardFetch(legacyCard()), { enabled: false }),
      /No compatible transport found/
    );
  });

  test('forwards the override to the official JSON-RPC transport factory', async () => {
    const cardUrl = 'https://legacy.example/.well-known/agent-card.json';
    const card = nativeCardWithLegacyInterface();

    const compatible = await createA2AClientFromCardUrl(cardUrl, cardFetch(card));
    const nativeOnly = await createA2AClientFromCardUrl(cardUrl, cardFetch(card), { enabled: false });

    assert.strictEqual(compatible.protocolVersion, '0.3');
    assert.strictEqual(nativeOnly.protocolVersion, '1.0');
  });
});
