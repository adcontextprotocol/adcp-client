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

describe('responseSizeLimit — SSE pass-through', () => {
  it('passes text/event-stream responses through without applying the cap', async () => {
    // SSE is unbounded by design. The MCP transport opens a long-lived
    // GET /mcp for server-initiated messages; cumulative frame bytes must
    // never trip the cap. A response with Content-Type: text/event-stream
    // must return unchanged — no Content-Length pre-check, no streaming
    // counter.
    const sseChunks = [new TextEncoder().encode('data: frame1\n\n'), new TextEncoder().encode('data: frame2\n\n')];
    const upstream = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            sseChunks.forEach(c => controller.enqueue(c));
            controller.close();
          },
        }),
        {
          status: 200,
          // Cap is 10 bytes; declared Content-Length is 50 KB — both
          // pre-check and streaming counter would fire if SSE weren't exempt.
          headers: { 'content-type': 'text/event-stream', 'content-length': '51200' },
        }
      );
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const response = await withResponseSizeLimit(10, () => wrapped('https://example.invalid/mcp'));
    assert.strictEqual(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text();
    assert.ok(text.includes('data: frame1'), 'SSE body must be readable after pass-through');
  });

  it('still caps non-SSE responses when the cap is active', async () => {
    // Regression guard: the SSE exemption must not disable the cap for
    // regular JSON/binary responses that happen to arrive on the same
    // fetch wrapper.
    const upstream = makeFetch(new Uint8Array(5000), { 'content-length': '5000' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(100, () => wrapped('https://example.invalid/').then(r => r.arrayBuffer())),
      err => err instanceof ResponseTooLargeError
    );
  });

  it('treats text/event-stream with charset param as SSE', async () => {
    const upstream = async () =>
      new Response(new Uint8Array(50_000), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    // Must not throw despite 50 KB body with a 100-byte cap.
    const response = await withResponseSizeLimit(100, () => wrapped('https://example.invalid/mcp'));
    assert.ok(response.headers.get('content-type')?.startsWith('text/event-stream'));
  });
});

describe('responseSizeLimit — gzip-bomb defense', () => {
  it("forces Accept-Encoding: identity when the cap is active so the byte counter sees what's on the wire", async () => {
    // Without this, undici's default `Accept-Encoding: gzip, deflate, br`
    // would let a hostile vendor ship a 5 KB compressed blob that
    // decompresses to GBs and burn asymmetric CPU before the streaming
    // counter trips. Forcing identity moves the bomb to the network where
    // Content-Length pre-check catches it.
    let observedHeader;
    const upstream = async (_input, init) => {
      const headers = new Headers(init?.headers);
      observedHeader = headers.get('accept-encoding');
      return new Response(new Uint8Array(64));
    };
    const wrapped = wrapFetchWithSizeLimit(upstream);
    await withResponseSizeLimit(1000, async () => {
      await wrapped('https://example.invalid/');
    });
    assert.strictEqual(observedHeader, 'identity');
  });

  it('respects a caller-set Accept-Encoding (signing fetches need stable signed bytes)', async () => {
    // The signing wrapper signs over the exact request bytes it's about to
    // send. If we overwrote a caller's `Accept-Encoding`, the signature
    // base would diverge from what the server validates. Only set the
    // header when no caller value is present.
    let observedHeader;
    const upstream = async (_input, init) => {
      observedHeader = new Headers(init?.headers).get('accept-encoding');
      return new Response(new Uint8Array(64));
    };
    const wrapped = wrapFetchWithSizeLimit(upstream);
    await withResponseSizeLimit(1000, async () => {
      await wrapped('https://example.invalid/', {
        headers: { 'Accept-Encoding': 'gzip' },
      });
    });
    assert.strictEqual(observedHeader, 'gzip');
  });

  it('does not touch outgoing headers when no slot is active', async () => {
    let observedHeader;
    const upstream = async (_input, init) => {
      observedHeader = new Headers(init?.headers).get('accept-encoding');
      return new Response(new Uint8Array(64));
    };
    const wrapped = wrapFetchWithSizeLimit(upstream);
    // No `withResponseSizeLimit` — production callers without the option
    // should pay no header cost.
    await wrapped('https://example.invalid/');
    assert.strictEqual(observedHeader, null);
  });
});

describe('responseSizeLimit — URL redaction in errors', () => {
  it('strips the query string from ResponseTooLargeError.url so bearer-in-query tokens do not leak to logs', async () => {
    // Some agents publish manifests with auth tokens in the query string
    // (`?api_key=…`). The error object is logged, returned to ticket
    // sinks, surfaced in `error.message`. Strip the search component at
    // construction time.
    const upstream = makeFetch(new Uint8Array(2000), { 'content-length': '2000' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://example.invalid/mcp?api_key=secret&trace=abc');
        return response.arrayBuffer();
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError);
        assert.strictEqual(err.url, 'https://example.invalid/mcp');
        assert.ok(!err.message.includes('secret'), 'error message must not contain query-string secret');
        assert.ok(!err.message.includes('api_key'), 'error message must not contain query-string param names');
        return true;
      }
    );
  });

  it('preserves the URL unchanged when the input is not a parseable URL (test stubs, relative paths)', async () => {
    // Defensive: if the input doesn't parse as a URL, surface the original
    // string rather than swallow the error. The diagnostic value of "what
    // URL did this come from" is more important than the redaction
    // guarantee in this fallback case (relative paths shouldn't carry
    // bearer tokens anyway).
    const upstream = makeFetch(new Uint8Array(2000), { 'content-length': '2000' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    // Use a Request object built from a relative path through `new URL()`
    // base — undici will reject it, so we use a custom stub here.
    const stubUpstream = async () =>
      new Response(new Uint8Array(2000), { status: 200, headers: { 'content-length': '2000' } });
    const stubWrapped = wrapFetchWithSizeLimit(stubUpstream);
    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        // Pass a non-URL string (the wrapper just stores it; upstream is stubbed).
        const response = await stubWrapped('not-a-url-at-all');
        return response.arrayBuffer();
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError);
        assert.strictEqual(err.url, 'not-a-url-at-all');
        return true;
      }
    );
  });
});

describe('responseSizeLimit — wrap-order regression guard', () => {
  it("composes correctly with wrapFetchWithCapture: clones see the size-limited body, can't blow memory", async () => {
    // The wrap-order claim is: size-limit innermost so capture clones the
    // bounded body. If a future refactor flipped the order
    // (`wrapFetchWithSizeLimit(wrapFetchWithCapture(...))`), capture would
    // clone the unbounded body and `response.text()` would buffer the
    // hostile reply in memory before the cap fires.
    //
    // Direct test: use both wrappers in the right order, exercise the
    // capture slot + size slot together, assert the size error
    // propagates through the cloned read path.
    const { wrapFetchWithCapture, withRawResponseCapture } = require('../../dist/lib/protocols/rawResponseCapture');

    const oversized = new Uint8Array(50_000); // 50 KB
    const upstream = makeFetch(oversized);

    // Composition order matches `mcp.ts` / `a2a.ts`: size-limit innermost,
    // capture outermost.
    const sized = wrapFetchWithSizeLimit(upstream);
    const captured = wrapFetchWithCapture(sized);

    await assert.rejects(
      withRawResponseCapture(
        () =>
          withResponseSizeLimit(1024, async () => {
            const response = await captured('https://example.invalid/');
            // Read the body — this is what the SDK would do. The cap
            // should fire during the read because the underlying stream
            // (shared between capture's clone and SDK's read via tee) is
            // the size-limited one.
            return response.arrayBuffer();
          }),
        { maxBodyBytes: 1024 }
      ),
      err => err instanceof ResponseTooLargeError
    );
  });
});

describe('responseSizeLimit — connection-cache reuse', () => {
  it('two different caps on the same wrapped fetch each apply to their own call', async () => {
    // The MCP / A2A connection cache hands the same wrapped fetch to
    // multiple calls. The wrapper reads the cap from the per-request ALS
    // slot, not from a closure captured at wrapper-creation time, so two
    // calls with different caps share the same wrapped fetch safely.
    // This pins that contract — a refactor that moves the slot lookup
    // to wrapper construction would break it.
    const upstream = makeFetch(new Uint8Array(2000));
    const sharedWrapped = wrapFetchWithSizeLimit(upstream);

    // Call 1: cap 1000 — should reject 2000-byte body.
    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await sharedWrapped('https://example.invalid/');
        return response.arrayBuffer();
      }),
      err => err instanceof ResponseTooLargeError
    );

    // Call 2: cap 5000 — same wrapper, same upstream. Should succeed.
    const out = await withResponseSizeLimit(5000, async () => {
      const response = await sharedWrapped('https://example.invalid/');
      return new Uint8Array(await response.arrayBuffer());
    });
    assert.strictEqual(out.byteLength, 2000);
  });

  it('reverts to no-cap behavior immediately after the slot scope exits', async () => {
    // ALS hygiene: once the `withResponseSizeLimit(...)` scope exits, the
    // next call against the same wrapper must see no cap. Otherwise an
    // ALS leak across awaits would silently cap subsequent calls.
    const upstream = makeFetch(new Uint8Array(50_000));
    const sharedWrapped = wrapFetchWithSizeLimit(upstream);

    // Inside scope: cap fires.
    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await sharedWrapped('https://example.invalid/');
        return response.arrayBuffer();
      }),
      err => err instanceof ResponseTooLargeError
    );

    // Outside scope: same wrapper, no cap, full read.
    const response = await sharedWrapped('https://example.invalid/');
    const buf = new Uint8Array(await response.arrayBuffer());
    assert.strictEqual(buf.byteLength, 50_000);
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
