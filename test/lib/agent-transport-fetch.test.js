const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentTransportFetch } = require('../../dist/lib/net');

test('agent transport refuses a public hostname that resolves to a private address', async () => {
  let calls = 0;
  const guarded = createAgentTransportFetch('https://agent.example.com/mcp', {
    lookup: async () => [{ address: '10.0.0.7', family: 4 }],
    networkFetch: async () => {
      calls += 1;
      return new Response('{}');
    },
  });

  await assert.rejects(() => guarded('https://agent.example.com/mcp'), /private or loopback/);
  assert.equal(calls, 0, 'the network fetch must not run after a denied resolution');
});

test('agent transport revalidates redirects and does not forward credentials to an internal hop', async () => {
  const calls = [];
  const guarded = createAgentTransportFetch('https://agent.example.com/mcp', {
    lookup: async hostname =>
      hostname === 'agent.example.com'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
    networkFetch: async (url, init) => {
      calls.push({ url: url.toString(), headers: new Headers(init.headers) });
      return new Response('', { status: 302, headers: { location: 'http://internal.example/metadata' } });
    },
  });

  await assert.rejects(
    () => guarded('https://agent.example.com/mcp', { headers: { authorization: 'Bearer secret' } }),
    /private or loopback/
  );
  assert.equal(calls.length, 1, 'the redirect target must be rejected before dispatch');
});

test('agent transport preserves caller-requested manual redirect handling', async () => {
  let lookups = 0;
  const guarded = createAgentTransportFetch('https://virtual.invalid/mcp', {
    lookup: async () => {
      lookups += 1;
      throw new Error('trusted transports must own DNS');
    },
    trustedFetchFn: async () =>
      new Response('', { status: 307, headers: { location: 'https://virtual.invalid/next' } }),
  });

  const response = await guarded('https://virtual.invalid/mcp', { redirect: 'manual' });
  assert.equal(response.status, 307);
  assert.equal(lookups, 0);
});

test('local-agent trust does not extend to a different private redirect origin', async () => {
  const calls = [];
  const guarded = createAgentTransportFetch('http://localhost:3000/mcp', {
    lookup: async hostname =>
      hostname === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.7', family: 4 }],
    networkFetch: async url => {
      calls.push(url.toString());
      return new Response('', { status: 302, headers: { location: 'http://internal.example/admin' } });
    },
  });

  await assert.rejects(() => guarded('http://localhost:3000/mcp'), /private or loopback/);
  assert.deepEqual(calls, ['http://localhost:3000/mcp']);
});

test('agent transport preserves Request bodies and signals', async () => {
  const controller = new AbortController();
  let observed;
  const guarded = createAgentTransportFetch('https://agent.example.com/mcp', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    trustedFetchFn: async (_url, init) => {
      observed = init;
      return new Response('{}');
    },
  });
  const request = new Request('https://agent.example.com/mcp', {
    method: 'POST',
    body: 'hello',
    signal: controller.signal,
  });

  await guarded(request);

  assert.equal(new TextDecoder().decode(observed.body), 'hello');
  assert.equal(observed.signal, request.signal);
});

test('agent transport supports an explicit per-client private DNS opt-in', async () => {
  let called = false;
  const guarded = createAgentTransportFetch('https://agent.corp/mcp', {
    allowPrivateIp: true,
    lookup: async () => [{ address: '10.0.0.7', family: 4 }],
    networkFetch: async () => {
      called = true;
      return new Response('{}');
    },
  });

  await guarded('https://agent.corp/mcp');
  assert.equal(called, true);
});
