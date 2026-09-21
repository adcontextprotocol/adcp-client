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

test('agent transport revalidates a public redirect target before dispatch', async () => {
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

  await assert.rejects(() => guarded('https://agent.example.com/mcp'), /private or loopback/);
  assert.equal(calls.length, 1, 'the redirect target must be rejected before dispatch');
});

test('agent transport refuses credentialed cross-origin redirects before the second network call', async () => {
  const calls = [];
  const guarded = createAgentTransportFetch('https://seller.example/rpc', {
    crossOriginCredentialPolicy: 'refuse',
    trustedFetchFn: async (url, init) => {
      calls.push({ url: url.toString(), apiKey: new Headers(init.headers).get('x-api-key') });
      return new Response('', { status: 307, headers: { location: 'https://other.example/rpc' } });
    },
  });

  await assert.rejects(
    () => guarded('https://seller.example/rpc', { method: 'POST', headers: { 'x-api-key': 'secret' } }),
    error => {
      assert.match(error.message, /refused credentialed cross-origin redirect/);
      assert.match(error.message, /https:\/\/other\.example/);
      assert.match(error.message, /x-api-key/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    }
  );
  assert.deepEqual(calls, [{ url: 'https://seller.example/rpc', apiKey: 'secret' }]);
});

test('agent transport identifies but never exposes credentials on direct cross-origin refusal', async () => {
  let calls = 0;
  const guarded = createAgentTransportFetch('https://seller.example/rpc', {
    crossOriginCredentialPolicy: 'refuse',
    trustedFetchFn: async () => {
      calls += 1;
      return new Response('{}');
    },
  });

  await assert.rejects(
    () => guarded('https://rpc.example/a2a', { headers: { Authorization: 'Bearer never-log-this' } }),
    error => {
      assert.match(error.message, /cross-origin dispatch to https:\/\/rpc\.example/);
      assert.match(error.message, /authorization/);
      assert.doesNotMatch(error.message, /never-log-this/);
      return true;
    }
  );
  assert.equal(calls, 0);
});

test('agent transport strips credentials by default without leaking on direct or redirected dispatch', async () => {
  for (const mode of ['direct', 'redirect']) {
    const calls = [];
    const guarded = createAgentTransportFetch('https://seller.example/rpc', {
      originBoundHeaders: ['X-Session'],
      trustedFetchFn: async (url, init) => {
        const headers = new Headers(init.headers);
        calls.push({
          url: url.toString(),
          authorization: headers.get('authorization'),
          session: headers.get('x-session'),
        });
        if (mode === 'redirect' && calls.length === 1) {
          return new Response('', { status: 307, headers: { location: 'https://rpc.example/rpc' } });
        }
        return new Response('{}');
      },
    });
    const start = mode === 'direct' ? 'https://rpc.example/rpc' : 'https://seller.example/rpc';
    await guarded(start, {
      headers: { Authorization: 'Bearer origin-only', 'X-Session': 'origin-session' },
    });
    const crossOrigin = calls.at(-1);
    assert.equal(crossOrigin.url, 'https://rpc.example/rpc');
    assert.equal(crossOrigin.authorization, null);
    assert.equal(crossOrigin.session, null);
    if (mode === 'redirect') {
      assert.deepEqual(calls[0], {
        url: 'https://seller.example/rpc',
        authorization: 'Bearer origin-only',
        session: 'origin-session',
      });
    }
  }
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

test('agent transport preserves arbitrary origin-bound headers at the configured origin', async () => {
  let session;
  const guarded = createAgentTransportFetch('https://seller.example/rpc', {
    originBoundHeaders: ['X-Session'],
    trustedFetchFn: async (_url, init) => {
      session = new Headers(init.headers).get('x-session');
      return new Response('{}');
    },
  });

  await guarded('https://seller.example/rpc', { headers: { 'X-Session': 'same-origin' } });
  assert.equal(session, 'same-origin');
});

test('agent transport strips arbitrary origin-bound headers from a direct cross-origin target', async () => {
  const calls = [];
  const guarded = createAgentTransportFetch('https://seller.example/rpc', {
    originBoundHeaders: ['X-Session'],
    trustedFetchFn: async (url, init) => {
      calls.push({ url: url.toString(), session: new Headers(init.headers).get('x-session') });
      return new Response('{}');
    },
  });

  await guarded('https://rpc.example/rpc', { headers: { 'X-Session': 'must-not-drift' } });
  assert.deepEqual(calls, [{ url: 'https://rpc.example/rpc', session: null }]);
});

test('agent transport strips arbitrary origin-bound headers on a cross-origin redirect', async () => {
  const calls = [];
  const guarded = createAgentTransportFetch('https://seller.example/rpc', {
    originBoundHeaders: ['X-Session'],
    trustedFetchFn: async (url, init) => {
      calls.push({ url: url.toString(), session: new Headers(init.headers).get('x-session') });
      if (calls.length === 1) {
        return new Response('', { status: 307, headers: { location: 'https://rpc.example/rpc' } });
      }
      return new Response('{}');
    },
  });

  await guarded('https://seller.example/rpc', { headers: { 'X-Session': 'same-origin-only' } });
  assert.deepEqual(calls, [
    { url: 'https://seller.example/rpc', session: 'same-origin-only' },
    { url: 'https://rpc.example/rpc', session: null },
  ]);
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
