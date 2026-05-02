/**
 * Tests for `@adcp/sdk/upstream-recorder` (issue adcp-client#1290).
 *
 * Producer-side companion to the runner-output-contract v2.0.0
 * `upstream_traffic` storyboard check. Pins:
 *   - `enabled: false` short-circuits to no-op (zero-overhead production).
 *   - Cross-principal isolation (security HIGH from spec-side review).
 *   - Record-time redaction (plaintext secrets never sit in memory).
 *   - Ring buffer + TTL eviction.
 *   - `endpointPattern` + `sinceTimestamp` filtering.
 *   - `limit` + `truncated` flag.
 *   - `wrapFetch` records actual round-trips.
 *   - `purpose` classifier tagging (adcp#3830 item 3 hook).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createUpstreamRecorder } = require('../../dist/lib/upstream-recorder');

// ────────────────────────────────────────────────────────────
// enabled: false fast-path
// ────────────────────────────────────────────────────────────

describe('createUpstreamRecorder({ enabled: false })', () => {
  test('returns a no-op recorder', async () => {
    const r = createUpstreamRecorder({ enabled: false });
    assert.equal(r.enabled, false);
    // wrapFetch returns input fetch unchanged.
    const fakeFetch = async () => new Response('ok', { status: 200 });
    assert.equal(r.wrapFetch(fakeFetch), fakeFetch);
    // record() is a no-op.
    r.record({ method: 'POST', url: 'https://x', content_type: 'application/json' }, 'p');
    const result = r.query({ principal: 'p' });
    assert.deepEqual(result.items, []);
    assert.equal(result.total, 0);
    assert.equal(result.truncated, false);
  });

  test('runWithPrincipal still invokes the function (passthrough)', async () => {
    const r = createUpstreamRecorder({ enabled: false });
    let ran = false;
    await r.runWithPrincipal('p', async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});

// ────────────────────────────────────────────────────────────
// Cross-principal isolation
// ────────────────────────────────────────────────────────────

describe('cross-principal isolation (security HIGH)', () => {
  test('query({ principal: A }) MUST NOT return calls recorded under principal B', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('alice', async () => {
      r.record({
        method: 'POST',
        url: 'https://api.test/v1/upload',
        content_type: 'application/json',
        payload: { secret_payload_for_alice: 'a-1' },
      });
    });
    await r.runWithPrincipal('bob', async () => {
      r.record({
        method: 'POST',
        url: 'https://api.test/v1/upload',
        content_type: 'application/json',
        payload: { secret_payload_for_bob: 'b-1' },
      });
    });

    const aliceView = r.query({ principal: 'alice' });
    const bobView = r.query({ principal: 'bob' });
    assert.equal(aliceView.total, 1);
    assert.equal(bobView.total, 1);
    assert.deepEqual(aliceView.items[0].payload, { secret_payload_for_alice: 'a-1' });
    assert.deepEqual(bobView.items[0].payload, { secret_payload_for_bob: 'b-1' });
    // Bob's principal must NOT see Alice's data.
    assert.ok(!JSON.stringify(bobView).includes('secret_payload_for_alice'));
  });

  test('record() called outside runWithPrincipal without explicit principal is dropped', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    r.record({ method: 'GET', url: 'https://x', content_type: 'application/json' });
    const result = r.query({ principal: 'anyone' });
    assert.equal(result.total, 0);
  });

  test('record() with explicit principal overrides the active scope', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('alice', async () => {
      r.record(
        { method: 'POST', url: 'https://x', content_type: 'application/json', payload: { v: 1 } },
        'bob' // explicit principal wins
      );
    });
    assert.equal(r.query({ principal: 'alice' }).total, 0);
    assert.equal(r.query({ principal: 'bob' }).total, 1);
  });
});

// ────────────────────────────────────────────────────────────
// Record-time redaction
// ────────────────────────────────────────────────────────────

describe('record-time redaction', () => {
  test('redacts secret-shaped keys recursively in JSON payload', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('p', async () => {
      r.record({
        method: 'POST',
        url: 'https://api.test/v1/upload',
        content_type: 'application/json',
        payload: {
          users: [{ hashed_email: 'real-vec' }],
          authorization: 'Bearer SECRET_TOKEN_VALUE',
          api_key: 'SK_LIVE_xxx',
          nested: { refresh_token: 'REFRESH_xxx' },
        },
      });
    });
    const { items } = r.query({ principal: 'p' });
    const payload = items[0].payload;
    assert.equal(payload.authorization, '[redacted]');
    assert.equal(payload.api_key, '[redacted]');
    assert.equal(payload.nested.refresh_token, '[redacted]');
    // Hashed-PII identifiers are NOT redacted — they're the load-bearing
    // assertion targets per the spec's payload description.
    assert.equal(payload.users[0].hashed_email, 'real-vec');
  });

  test('redacts secret-shaped headers (lowercased keys)', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    let capturedHeaders;
    const purpose = ({ headers }) => {
      capturedHeaders = headers;
      return undefined;
    };
    const r2 = createUpstreamRecorder({ enabled: true, purpose });
    await r2.runWithPrincipal('p', async () => {
      r2.record({
        method: 'POST',
        url: 'https://x',
        content_type: 'application/json',
        headers: { Authorization: 'Bearer xyz', 'X-Trace-Id': 'trace-123' },
      });
    });
    assert.equal(capturedHeaders.authorization, '[redacted]');
    assert.equal(capturedHeaders['x-trace-id'], 'trace-123');
  });

  test('honors a wider custom redactPattern (adopters MAY extend the contract floor)', async () => {
    const r = createUpstreamRecorder({
      enabled: true,
      redactPattern: /^(authorization|x-internal-vendor-secret)$/i,
    });
    await r.runWithPrincipal('p', async () => {
      r.record({
        method: 'POST',
        url: 'https://x',
        content_type: 'application/json',
        payload: { 'x-internal-vendor-secret': 'leak', other: 'fine' },
      });
    });
    const { items } = r.query({ principal: 'p' });
    assert.equal(items[0].payload['x-internal-vendor-secret'], '[redacted]');
    assert.equal(items[0].payload.other, 'fine');
  });
});

// ────────────────────────────────────────────────────────────
// Ring buffer + TTL eviction
// ────────────────────────────────────────────────────────────

describe('ring buffer + TTL eviction', () => {
  test('evicts oldest entries when bufferSize is exceeded', async () => {
    const r = createUpstreamRecorder({ enabled: true, bufferSize: 3 });
    await r.runWithPrincipal('p', async () => {
      for (let i = 0; i < 5; i++) {
        r.record({
          method: 'POST',
          url: `https://x/${i}`,
          content_type: 'application/json',
          payload: { i },
        });
      }
    });
    const { items, total } = r.query({ principal: 'p' });
    assert.equal(total, 3, 'only 3 retained');
    assert.deepEqual(
      items.map(c => c.payload.i),
      [2, 3, 4],
      'oldest 2 evicted'
    );
  });

  test('TTL evicts entries older than ttlMs at next record() / query()', async () => {
    const r = createUpstreamRecorder({ enabled: true, ttlMs: 10 });
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'GET', url: 'https://x/old', content_type: 'application/json' });
    });
    // Wait past the TTL window.
    await new Promise(res => setTimeout(res, 30));
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'GET', url: 'https://x/new', content_type: 'application/json' });
    });
    const { items } = r.query({ principal: 'p' });
    assert.equal(items.length, 1);
    assert.match(items[0].url, /new/);
  });
});

// ────────────────────────────────────────────────────────────
// Query filters
// ────────────────────────────────────────────────────────────

describe('query filters', () => {
  test('endpointPattern filters by glob (* matches /)', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'POST', url: 'https://api.test/v1/audience/upload', content_type: 'application/json' });
      r.record({ method: 'GET', url: 'https://api.test/v1/health', content_type: 'application/json' });
      r.record({ method: 'POST', url: 'https://api.test/v1/events/log', content_type: 'application/json' });
    });
    const { items } = r.query({ principal: 'p', endpointPattern: 'POST *audience*' });
    assert.equal(items.length, 1);
    assert.match(items[0].url, /audience/);
  });

  test('sinceTimestamp filters out earlier calls', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'GET', url: 'https://x/early', content_type: 'application/json' });
    });
    await new Promise(res => setTimeout(res, 5));
    const cutoff = new Date().toISOString();
    await new Promise(res => setTimeout(res, 5));
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'GET', url: 'https://x/late', content_type: 'application/json' });
    });
    const { items } = r.query({ principal: 'p', sinceTimestamp: cutoff });
    assert.equal(items.length, 1);
    assert.match(items[0].url, /late/);
  });

  test('limit + truncated flag set when total exceeds limit', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('p', async () => {
      for (let i = 0; i < 5; i++) {
        r.record({ method: 'GET', url: `https://x/${i}`, content_type: 'application/json' });
      }
    });
    const { items, total, truncated } = r.query({ principal: 'p', limit: 2 });
    assert.equal(items.length, 2);
    assert.equal(total, 5);
    assert.equal(truncated, true);
  });
});

// ────────────────────────────────────────────────────────────
// wrapFetch end-to-end
// ────────────────────────────────────────────────────────────

describe('wrapFetch end-to-end', () => {
  test('records the method/url/content_type/payload from a real fetch round-trip', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    const fakeFetch = async (input, init) => {
      // No actual network — assert wrapped fetch passes args through.
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const wrapped = r.wrapFetch(fakeFetch);
    await r.runWithPrincipal('alice', async () => {
      await wrapped('https://api.test/v1/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret-xyz' },
        body: JSON.stringify({ users: [{ hashed_email: 'vec-1' }] }),
      });
    });
    const { items } = r.query({ principal: 'alice' });
    assert.equal(items.length, 1);
    const call = items[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.test/v1/upload');
    assert.equal(call.host, 'api.test');
    assert.equal(call.path, '/v1/upload');
    assert.equal(call.content_type, 'application/json');
    assert.equal(call.status_code, 201);
    assert.deepEqual(call.payload, { users: [{ hashed_email: 'vec-1' }] });
    // Authorization header should never have leaked through to the recorded
    // call's payload via any path — it was a header, not a payload key.
    assert.ok(!JSON.stringify(call).includes('secret-xyz'), 'no plaintext bearer in record');
  });

  test('passes through unchanged when called outside runWithPrincipal', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    let upstreamCalled = false;
    const fakeFetch = async () => {
      upstreamCalled = true;
      return new Response('ok');
    };
    const wrapped = r.wrapFetch(fakeFetch);
    await wrapped('https://x');
    assert.equal(upstreamCalled, true);
    assert.equal(r.query({ principal: 'anyone' }).total, 0);
  });

  test('still records on fetch error (no status_code)', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    const fakeFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const wrapped = r.wrapFetch(fakeFetch);
    let threw;
    await r.runWithPrincipal('p', async () => {
      try {
        await wrapped('https://api.test/v1/upload', { method: 'POST' });
      } catch (e) {
        threw = e;
      }
    });
    assert.ok(threw, 'error should propagate to caller');
    const { items } = r.query({ principal: 'p' });
    assert.equal(items.length, 1, 'attempt is still recorded');
    assert.equal(items[0].status_code, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// purpose classifier
// ────────────────────────────────────────────────────────────

describe('purpose classifier (adcp#3830 item 3 hook)', () => {
  test('purpose tag attached when classifier returns a string', async () => {
    const purpose = ({ host }) => (host === 'api.measurement.test' ? 'measurement' : 'platform_primary');
    const r = createUpstreamRecorder({ enabled: true, purpose });
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'POST', url: 'https://api.platform.test/v1/x', content_type: 'application/json' });
      r.record({ method: 'POST', url: 'https://api.measurement.test/v1/y', content_type: 'application/json' });
    });
    const { items } = r.query({ principal: 'p' });
    assert.equal(items[0].purpose, 'platform_primary');
    assert.equal(items[1].purpose, 'measurement');
  });

  test('classifier exception is swallowed — purpose left absent (recorder MUST NOT crash)', async () => {
    const purpose = () => {
      throw new Error('boom');
    };
    const r = createUpstreamRecorder({ enabled: true, purpose });
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'GET', url: 'https://x', content_type: 'application/json' });
    });
    const { items } = r.query({ principal: 'p' });
    assert.equal(items[0].purpose, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// clear()
// ────────────────────────────────────────────────────────────

describe('clear()', () => {
  test('drops every recorded call', async () => {
    const r = createUpstreamRecorder({ enabled: true });
    await r.runWithPrincipal('p', async () => {
      r.record({ method: 'GET', url: 'https://x', content_type: 'application/json' });
    });
    assert.equal(r.query({ principal: 'p' }).total, 1);
    r.clear();
    assert.equal(r.query({ principal: 'p' }).total, 0);
  });
});
