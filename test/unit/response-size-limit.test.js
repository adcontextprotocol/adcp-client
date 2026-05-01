/**
 * Unit tests for the response-body byte cap (`maxResponseBytes`).
 *
 * Covers `wrapFetchWithSizeLimit` + `withResponseSizeLimit` from
 * `src/lib/protocols/responseSizeLimit.ts`, exercised through the
 * built `dist/` so the test pins compiled behavior, not source.
 *
 * What we're protecting: a hostile vendor publishing a large reply that
 * gets fully buffered before any application-layer schema validation runs.
 * The cap aborts the body read at the limit and surfaces a typed error.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  wrapFetchWithSizeLimit,
  withResponseSizeLimit,
  responseSizeLimitStorage,
} = require('../../dist/lib/protocols/responseSizeLimit');
const { ResponseTooLargeError, ADCPError, isADCPError } = require('../../dist/lib/errors');

function makeFetch(body, headers = {}) {
  // Returns a function with the fetch shape that yields a Response built
  // from the supplied bytes. Headers default to omitting Content-Length so
  // the streaming path is exercised; tests can opt in by passing it.
  return async () =>
    new Response(body, {
      status: 200,
      headers,
    });
}

describe('responseSizeLimit — wrapFetchWithSizeLimit', () => {
  it('passes responses through when no slot is active', async () => {
    const upstream = makeFetch(new Uint8Array(1024));
    const wrapped = wrapFetchWithSizeLimit(upstream);

    // No `withResponseSizeLimit` around the call — the wrapper must be a
    // no-op so production callers without the option pay nothing.
    const response = await wrapped('https://example.invalid/');
    const buf = new Uint8Array(await response.arrayBuffer());

    assert.strictEqual(buf.byteLength, 1024);
  });

  it('refuses to read the body when Content-Length exceeds the cap', async () => {
    // Pre-check: when the server declares a body bigger than the cap, the
    // wrapper throws before constructing a streamed Response, and cancels
    // the upstream body so the socket can be released. (Runtimes may start
    // buffering before our wrapper observes the Response — the cancel is
    // what bounds memory in that race, not blocking the first read.)
    const upstream = async () =>
      new Response(new Uint8Array(1024), {
        status: 200,
        headers: { 'content-length': '5000' },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://hostile.invalid/');
        return response.arrayBuffer();
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError, 'expected ResponseTooLargeError');
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 1000);
        assert.strictEqual(err.declaredContentLength, 5000);
        assert.strictEqual(err.bytesRead, 0, 'pre-check reports zero bytes-read on the error');
        return true;
      }
    );
  });

  it('aborts mid-stream when the body exceeds the cap without Content-Length', async () => {
    // Server lies about size or chunks the response with no Content-Length.
    // The streaming counter is the authoritative defense: each chunk lands
    // in the TransformStream, the running total compares to the cap, and
    // overflow errors the readable side.
    const upstream = async () => {
      const body = new ReadableStream({
        start(controller) {
          // Two 600-byte chunks; cap is 1000 → overflow on the second chunk.
          controller.enqueue(new Uint8Array(600));
          controller.enqueue(new Uint8Array(600));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    };
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://hostile.invalid/');
        return response.arrayBuffer();
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError, 'expected ResponseTooLargeError');
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 1000);
        assert.ok(err.bytesRead > 1000, `bytesRead ${err.bytesRead} should exceed limit`);
        assert.strictEqual(err.declaredContentLength, undefined);
        return true;
      }
    );
  });

  it('reads under-cap bodies through to completion unchanged', async () => {
    const payload = new Uint8Array(512).fill(0x41); // 'A'
    const upstream = makeFetch(payload, { 'content-length': '512' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const out = await withResponseSizeLimit(1000, async () => {
      const response = await wrapped('https://friendly.invalid/');
      return new Uint8Array(await response.arrayBuffer());
    });

    assert.strictEqual(out.byteLength, 512);
    assert.strictEqual(out[0], 0x41);
    assert.strictEqual(out[511], 0x41);
  });

  it('counts bytes exactly at the limit boundary as success', async () => {
    // Boundary case: bytesRead === limit must NOT trip. Only strict overflow
    // (> limit) is an error. Off-by-one here would reject every response
    // that happens to match the cap, which is a real fleet-config foot-gun.
    const upstream = makeFetch(new Uint8Array(1000));
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const out = await withResponseSizeLimit(1000, async () => {
      const response = await wrapped('https://example.invalid/');
      return new Uint8Array(await response.arrayBuffer());
    });

    assert.strictEqual(out.byteLength, 1000);
  });

  it('treats invalid Content-Length headers as "not declared" and falls through to streaming', async () => {
    // Servers occasionally send malformed headers (whitespace, multi-values
    // pre-coalesce, "chunked" instead of a digit). We must not abort on a
    // bad header — let the streaming counter make the call.
    const upstream = makeFetch(new Uint8Array(500), { 'content-length': 'not-a-number' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const out = await withResponseSizeLimit(1000, async () => {
      const response = await wrapped('https://example.invalid/');
      return new Uint8Array(await response.arrayBuffer());
    });

    assert.strictEqual(out.byteLength, 500);
  });

  it('does not enter the ALS slot when the cap is unset, zero, or non-finite', async () => {
    // `withResponseSizeLimit` short-circuits for invalid caps so a misuse
    // (e.g., passing `Number.NaN` from a parsed env var) doesn't silently
    // disable enforcement by entering an ALS slot with a bad value.
    for (const cap of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let storeWasSet = false;
      await withResponseSizeLimit(cap, async () => {
        storeWasSet = responseSizeLimitStorage.getStore() !== undefined;
      });
      assert.strictEqual(storeWasSet, false, `cap=${cap} must not enter the ALS slot`);
    }
  });

  it('per-call override beats a surrounding constructor-level cap', async () => {
    // The SDK threads a constructor cap by entering the ALS slot once at
    // the top of the call. A per-call override reruns `.run({...}, fn)` so
    // the inner store wins for the duration of the call — same pattern the
    // `signingContextStorage` uses. Verify the ALS semantics directly.
    const payload = new Uint8Array(2000);
    const upstream = makeFetch(payload);
    const wrapped = wrapFetchWithSizeLimit(upstream);

    // Outer cap (1000) would reject; inner cap (5000) lets it through.
    const out = await withResponseSizeLimit(1000, () =>
      withResponseSizeLimit(5000, async () => {
        const response = await wrapped('https://example.invalid/');
        return new Uint8Array(await response.arrayBuffer());
      })
    );
    assert.strictEqual(out.byteLength, 2000);

    // Inverse: outer cap (5000) would allow; inner cap (1000) rejects.
    await assert.rejects(
      withResponseSizeLimit(5000, () =>
        withResponseSizeLimit(1000, async () => {
          const response = await wrapped('https://example.invalid/');
          return response.arrayBuffer();
        })
      ),
      err => err instanceof ResponseTooLargeError
    );
  });

  it('preserves status, status text, and headers on the size-limited response', async () => {
    // The wrapper rebuilds the Response so it can swap out the body. Status
    // line and headers must be carried over verbatim — anything that
    // depends on them (e.g., MCP SDK auth-challenge parsing on 401) breaks
    // silently otherwise.
    const upstream = async () =>
      new Response(new Uint8Array(64), {
        status: 418,
        statusText: "I'm a teapot",
        headers: { 'x-trace-id': 'abc-123', 'content-type': 'application/json' },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const response = await withResponseSizeLimit(1000, () => wrapped('https://example.invalid/'));
    assert.strictEqual(response.status, 418);
    assert.strictEqual(response.statusText, "I'm a teapot");
    assert.strictEqual(response.headers.get('x-trace-id'), 'abc-123');
    assert.strictEqual(response.headers.get('content-type'), 'application/json');
  });
});

describe('responseSizeLimit — ResponseTooLargeError shape', () => {
  it('extends ADCPError, carries code RESPONSE_TOO_LARGE, and registers with isADCPError', () => {
    const err = new ResponseTooLargeError(1000, 1500, 'https://example.invalid/');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ADCPError, 'must extend ADCPError so callers can branch on the base class');
    assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
    assert.strictEqual(err.limit, 1000);
    assert.strictEqual(err.bytesRead, 1500);
    assert.strictEqual(err.url, 'https://example.invalid/');
    assert.strictEqual(err.declaredContentLength, undefined);
    assert.ok(isADCPError(err));
    // details payload doubles as the wire-error body so logs/tickets
    // surface the cap and observed size without re-parsing the message.
    assert.deepStrictEqual(err.details, {
      limit: 1000,
      bytesRead: 1500,
      url: 'https://example.invalid/',
      declaredContentLength: undefined,
    });
  });

  it('uses the declared-length message branch when the pre-check trips', () => {
    const err = new ResponseTooLargeError(1000, 0, 'https://example.invalid/', 5000);
    assert.match(err.message, /declared 5000 bytes/);
    assert.match(err.message, /1000/);
  });
});
