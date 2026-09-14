const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const sdkA2AClient = require('../../dist/lib/protocols/a2a').legacyA2AClientTestShim;
const { callA2ATool, closeA2AConnections } = require('../../dist/lib/protocols/a2a.js');
const { createA2AClient } = require('../../dist/lib/index.js');

const originalFromCardUrl = sdkA2AClient.fromCardUrl;

function stubClient() {
  return {
    sendMessage: async () => ({
      result: {
        kind: 'message',
        messageId: 'response-message',
        role: 'agent',
        parts: [{ kind: 'data', data: { ok: true } }],
      },
    }),
  };
}

describe('A2A client cache', () => {
  beforeEach(() => closeA2AConnections());

  afterEach(() => {
    sdkA2AClient.fromCardUrl = originalFromCardUrl;
    closeA2AConnections();
  });

  test('caps completed clients at 20 and refreshes LRU hits', async () => {
    let discoveries = 0;
    sdkA2AClient.fromCardUrl = async () => {
      discoveries++;
      return stubClient();
    };

    for (let index = 0; index < 20; index++) {
      await callA2ATool(`https://agent-${index}.example`, 'get_products', {});
    }
    await callA2ATool('https://agent-0.example', 'get_products', {}); // touch oldest
    await callA2ATool('https://agent-20.example', 'get_products', {}); // evicts agent-1
    await callA2ATool('https://agent-0.example', 'get_products', {}); // still cached
    await callA2ATool('https://agent-1.example', 'get_products', {}); // rediscover

    assert.strictEqual(discoveries, 22);
  });

  test('teardown prevents a late discovery from repopulating the cache', async () => {
    let finishDiscovery;
    let discoveries = 0;
    sdkA2AClient.fromCardUrl = () => {
      discoveries++;
      return new Promise(resolve => {
        finishDiscovery = resolve;
      });
    };

    const pending = callA2ATool('https://late.example', 'get_products', {});
    await new Promise(resolve => setImmediate(resolve));
    closeA2AConnections();
    finishDiscovery(stubClient());
    await assert.rejects(pending, /completed after connection teardown/);

    sdkA2AClient.fromCardUrl = async () => {
      discoveries++;
      return stubClient();
    };
    await callA2ATool('https://late.example', 'get_products', {});
    assert.strictEqual(discoveries, 2);
  });

  test('does not reuse a client across private-network policy boundaries', async () => {
    let discoveries = 0;
    sdkA2AClient.fromCardUrl = async () => {
      discoveries++;
      return stubClient();
    };

    const args = ['https://policy.example', 'get_products', {}, undefined, [], undefined, undefined, undefined];
    await callA2ATool(...args, undefined, undefined, undefined, undefined, true);
    await callA2ATool(...args, undefined, undefined, undefined, undefined, false);
    await callA2ATool(...args, undefined, undefined, undefined, undefined, true);

    assert.strictEqual(discoveries, 2);
  });

  test('policy tuple cannot collide with an attacker-controlled URL suffix', async () => {
    let discoveries = 0;
    sdkA2AClient.fromCardUrl = async () => {
      discoveries++;
      return stubClient();
    };

    const args = ['get_products', {}, undefined, [], undefined, undefined, undefined];
    await callA2ATool('https://collision.example/agent', ...args, undefined, undefined, undefined, undefined, true);
    await callA2ATool(
      'https://collision.example/agent::private-ip:1',
      ...args,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    await callA2ATool('https://collision.example/agent', ...args, undefined, undefined, undefined, undefined, true);

    assert.strictEqual(discoveries, 2);
  });

  test('does not reuse clients across legacy compatibility policies', async () => {
    const policies = [];
    sdkA2AClient.fromCardUrl = async (_cardUrl, options) => {
      policies.push(options.legacyCompat.enabled);
      return stubClient();
    };

    await createA2AClient('https://policy.example', undefined, undefined, undefined, undefined, {
      legacyCompat: { enabled: false },
    }).callTool('get_products', {});
    await createA2AClient('https://policy.example', undefined, undefined, undefined, undefined, {
      legacyCompat: { enabled: true },
    }).callTool('get_products', {});
    await createA2AClient('https://policy.example', undefined, undefined, undefined, undefined, {
      legacyCompat: { enabled: false },
    }).callTool('get_products', {});

    assert.deepStrictEqual(policies, [false, true]);
  });
});
