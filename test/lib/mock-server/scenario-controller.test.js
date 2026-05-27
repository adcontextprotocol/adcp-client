const { createServer } = require('node:http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootMockServer } = require('../../../dist/lib/mock-server/index.js');
const { DEFAULT_API_KEY, NETWORKS } = require('../../../dist/lib/mock-server/sales-non-guaranteed/seed-data.js');

const NETWORK = NETWORKS[0].network_code;

describe('mock-server scenario controller', () => {
  let handle;

  before(async () => {
    handle = await bootMockServer({ specialism: 'sales-non-guaranteed', port: 0 });
  });

  after(async () => {
    if (handle) await handle.close();
  });

  function authHeaders(body = false) {
    const headers = {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      'X-Network-Code': NETWORK,
    };
    if (body) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function controlHeaders(body = false) {
    const headers = {
      'X-Mock-Control-Token': handle.scenario.controlToken,
    };
    if (body) headers['Content-Type'] = 'application/json';
    return headers;
  }

  it('exposes programmatic and HTTP scenario state, then resets fixture state', async () => {
    assert.ok(handle.scenario);
    assert.ok(handle.scenario.controlToken);
    assert.equal(handle.scenario.state().specialism, 'sales-non-guaranteed');

    const unauthorized = await fetch(`${handle.url}/_scenario/state`);
    assert.equal(unauthorized.status, 404);

    const create = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({
        name: 'scenario reset',
        advertiser_id: 'adv_test',
        budget: 1000,
        currency: 'USD',
        line_items: [],
      }),
    });
    assert.equal(create.status, 201);

    const stateBefore = await (
      await fetch(`${handle.url}/_scenario/state`, {
        headers: controlHeaders(),
      })
    ).json();
    assert.equal(stateBefore.snapshot.orders, 1);

    const reset = await fetch(`${handle.url}/_scenario/reset`, {
      method: 'POST',
      headers: controlHeaders(),
    });
    assert.equal(reset.status, 200);
    const stateAfter = await (
      await fetch(`${handle.url}/_scenario/state`, {
        headers: controlHeaders(),
      })
    ).json();
    assert.equal(stateAfter.snapshot.orders, 0);
  });

  it('serves one-shot scripted fault responses before normal routes', async () => {
    await handle.scenario.reset();

    const script = await fetch(`${handle.url}/_scenario/script`, {
      method: 'POST',
      headers: controlHeaders(true),
      body: JSON.stringify({
        match: { method: 'GET', path: '/v1/products' },
        response: {
          status: 503,
          body: { code: 'scripted_outage', message: 'planned fixture outage' },
        },
        times: 1,
      }),
    });
    assert.equal(script.status, 201);

    const first = await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
    assert.equal(first.status, 503);
    assert.equal((await first.json()).code, 'scripted_outage');

    const second = await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
    assert.equal(second.status, 200);
    assert.ok((await second.json()).products.length > 0);

    const traffic = await (await fetch(`${handle.url}/_debug/traffic`)).json();
    assert.ok((traffic.traffic['GET /v1/products'] ?? 0) >= 1, 'scripted hits should still count as traffic');
  });

  it('serves scripted fault responses matched by path_regex', async () => {
    await handle.scenario.reset();

    const script = await fetch(`${handle.url}/_scenario/script`, {
      method: 'POST',
      headers: controlHeaders(true),
      body: JSON.stringify({
        match: { method: 'GET', path_regex: '^/v1/prod' },
        response: {
          status: 502,
          body: { code: 'regex_scripted_outage', message: 'regex fixture outage' },
        },
        times: 1,
      }),
    });
    assert.equal(script.status, 201);

    const first = await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
    assert.equal(first.status, 502);
    assert.equal((await first.json()).code, 'regex_scripted_outage');

    const second = await fetch(`${handle.url}/v1/products`, { headers: authHeaders() });
    assert.equal(second.status, 200);
  });

  it('replays idempotency_key requests with the identical status and body', async () => {
    await handle.scenario.reset();

    const body = {
      name: 'idempotency-key replay',
      advertiser_id: 'adv_test',
      budget: 1500,
      currency: 'USD',
      idempotency_key: 'scenario-idem-key-0001',
      line_items: [],
    };
    const first = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    const second = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(await second.json(), await first.json());

    const conflict = await fetch(`${handle.url}/v1/orders`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ ...body, budget: 2500 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'idempotency_conflict');
  });

  it('emits and records webhook stubs', async () => {
    await handle.scenario.reset();

    const received = [];
    const receivedHeaders = [];
    const receiver = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        receivedHeaders.push(req.headers);
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      });
    });

    await new Promise((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', () => {
        receiver.removeListener('error', reject);
        resolve();
      });
    });

    try {
      const port = receiver.address().port;
      const emit = await fetch(`${handle.url}/_scenario/webhooks/emit`, {
        method: 'POST',
        headers: controlHeaders(true),
        body: JSON.stringify({
          url: `http://127.0.0.1:${port}/callback`,
          payload: { task_id: 'task_1', status: 'completed' },
          headers: {
            authorization: 'Bearer should-not-forward',
            cookie: 'session=should-not-forward',
            host: 'should-not-forward',
            'x-forwarded-host': 'should-not-forward.example',
            'x-real-ip': '203.0.113.10',
            'x-original-url': '/admin',
            'x-request-id': 'req-1',
            'x-idempotency-key': 'idem-1',
          },
        }),
      });
      assert.equal(emit.status, 200);
      const attempt = await emit.json();
      assert.equal(attempt.status, 202);
      assert.deepEqual(received, [{ task_id: 'task_1', status: 'completed' }]);
      assert.equal(receivedHeaders[0]['x-request-id'], 'req-1');
      assert.equal(receivedHeaders[0]['x-idempotency-key'], 'idem-1');
      assert.equal(receivedHeaders[0]['authorization'], undefined);
      assert.equal(receivedHeaders[0]['cookie'], undefined);
      assert.notEqual(receivedHeaders[0]['host'], 'should-not-forward');
      assert.equal(receivedHeaders[0]['x-forwarded-host'], undefined);
      assert.equal(receivedHeaders[0]['x-real-ip'], undefined);
      assert.equal(receivedHeaders[0]['x-original-url'], undefined);

      const webhooks = await (
        await fetch(`${handle.url}/_scenario/webhooks`, {
          headers: controlHeaders(),
        })
      ).json();
      assert.equal(webhooks.webhooks.length, 1);
      assert.equal(webhooks.webhooks[0].status, 202);
    } finally {
      await new Promise((resolve, reject) => receiver.close(err => (err ? reject(err) : resolve())));
    }
  });

  it('records webhook redirects without following them', async () => {
    await handle.scenario.reset();

    const receiver = createServer((_req, res) => {
      res.writeHead(302, { location: 'https://example.com/escaped' });
      res.end();
    });

    await new Promise((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', () => {
        receiver.removeListener('error', reject);
        resolve();
      });
    });

    try {
      const port = receiver.address().port;
      const emit = await fetch(`${handle.url}/_scenario/webhooks/emit`, {
        method: 'POST',
        headers: controlHeaders(true),
        body: JSON.stringify({
          url: `http://127.0.0.1:${port}/callback`,
          payload: { task_id: 'task_redirect', status: 'completed' },
        }),
      });
      assert.equal(emit.status, 200);
      const attempt = await emit.json();
      assert.equal(attempt.status, 302);
    } finally {
      await new Promise((resolve, reject) => receiver.close(err => (err ? reject(err) : resolve())));
    }
  });

  it('rejects non-loopback webhook targets without recording a request attempt', async () => {
    await handle.scenario.reset();

    const emit = await fetch(`${handle.url}/_scenario/webhooks/emit`, {
      method: 'POST',
      headers: controlHeaders(true),
      body: JSON.stringify({
        url: 'https://example.com/callback',
        payload: { task_id: 'task_2', status: 'completed' },
      }),
    });
    assert.equal(emit.status, 400);
    assert.equal((await emit.json()).code, 'invalid_webhook_target');

    const webhooks = await (
      await fetch(`${handle.url}/_scenario/webhooks`, {
        headers: controlHeaders(),
      })
    ).json();
    assert.equal(webhooks.webhooks.length, 0);
  });

  it('rejects localhost webhook targets to avoid hostname rebinding', async () => {
    await handle.scenario.reset();

    const emit = await fetch(`${handle.url}/_scenario/webhooks/emit`, {
      method: 'POST',
      headers: controlHeaders(true),
      body: JSON.stringify({
        url: 'http://localhost:9999/callback',
        payload: { task_id: 'task_3', status: 'completed' },
      }),
    });
    assert.equal(emit.status, 400);
    assert.equal((await emit.json()).code, 'invalid_webhook_target');

    const webhooks = await (
      await fetch(`${handle.url}/_scenario/webhooks`, {
        headers: controlHeaders(),
      })
    ).json();
    assert.equal(webhooks.webhooks.length, 0);
  });

  it('rejects loopback-like webhook hostnames that are not literal allowlisted loopback', async () => {
    await handle.scenario.reset();

    for (const url of [
      'http://[::ffff:127.0.0.2]:9999/callback',
      'http://0.0.0.0:9999/callback',
      'http://2130706433:9999/callback',
      'http://user:pass@127.0.0.1:9999/callback',
    ]) {
      const emit = await fetch(`${handle.url}/_scenario/webhooks/emit`, {
        method: 'POST',
        headers: controlHeaders(true),
        body: JSON.stringify({
          url,
          payload: { task_id: 'task_rejected', status: 'completed' },
        }),
      });
      assert.equal(emit.status, 400, url);
      assert.equal((await emit.json()).code, 'invalid_webhook_target');
    }

    const webhooks = await (
      await fetch(`${handle.url}/_scenario/webhooks`, {
        headers: controlHeaders(),
      })
    ).json();
    assert.equal(webhooks.webhooks.length, 0);
  });
});
