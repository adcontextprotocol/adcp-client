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
 *
 * The cap is **on by default** (adcp-client#3253): 4 MiB per response, with
 * `text/event-stream` bounded per event and cumulatively per call. Several
 * assertions below fail if either default is removed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  wrapFetchWithSizeLimit,
  withResponseSizeLimit,
  responseSizeLimitStorage,
  DEFAULT_MAX_RESPONSE_BYTES,
  SSE_CUMULATIVE_BUDGET_MULTIPLIER,
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
  it('passes under-cap responses through when no slot is active', async () => {
    const upstream = makeFetch(new Uint8Array(1024));
    const wrapped = wrapFetchWithSizeLimit(upstream);

    // No `withResponseSizeLimit` around the call — the implicit default
    // applies and a 1 KiB body is nowhere near it.
    const response = await wrapped('https://example.invalid/');
    const buf = new Uint8Array(await response.arrayBuffer());

    assert.strictEqual(buf.byteLength, 1024);
  });

  it('enforces the 4 MiB default when no cap was configured anywhere', async () => {
    // The regression this whole change exists for: an agent answered
    // `get_products` with ~17.8 MB and OOM-killed the hosted grader, which
    // had not opted into a cap. The wrapper must cap by default — with no
    // ALS slot and no caller-supplied number.
    assert.strictEqual(DEFAULT_MAX_RESPONSE_BYTES, 4 * 1024 * 1024);

    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES + 1)));

    await assert.rejects(
      (async () => {
        const response = await wrapped('https://hostile.invalid/mcp');
        return response.arrayBuffer();
      })(),
      err => err instanceof ResponseTooLargeError && err.limit === DEFAULT_MAX_RESPONSE_BYTES
    );
  });

  it('enforces the 4 MiB default inside a scope opened with an unset cap', async () => {
    // `withResponseSizeLimit(transport?.maxResponseBytes, ...)` is how every
    // SDK call path opens the scope; `undefined` is the common case.
    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES + 1)));

    await assert.rejects(
      withResponseSizeLimit(undefined, async () => {
        const response = await wrapped('https://hostile.invalid/mcp');
        return response.arrayBuffer();
      }),
      err => err instanceof ResponseTooLargeError && err.limit === DEFAULT_MAX_RESPONSE_BYTES
    );
  });

  it('pre-rejects an over-default Content-Length with no cap configured', async () => {
    const upstream = async () =>
      new Response(new Uint8Array(16), {
        status: 200,
        headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      (async () => {
        const response = await wrapped('https://hostile.invalid/mcp');
        return response.arrayBuffer();
      })(),
      err =>
        err instanceof ResponseTooLargeError &&
        err.limit === DEFAULT_MAX_RESPONSE_BYTES &&
        err.contentLengthHeader === DEFAULT_MAX_RESPONSE_BYTES + 1 &&
        err.bytesRead === 0
    );
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
        assert.strictEqual(err.contentLengthHeader, 5000);
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
        assert.strictEqual(err.contentLengthHeader, undefined);
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

  it('falls back to the default for an unset or non-finite cap', async () => {
    // A misuse (e.g., passing `Number.NaN` from a parsed env var) must fail
    // closed onto the default rather than silently disabling enforcement.
    for (const cap of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      let observed;
      await withResponseSizeLimit(cap, async () => {
        observed = responseSizeLimitStorage.getStore()?.maxResponseBytes;
      });
      assert.strictEqual(observed, DEFAULT_MAX_RESPONSE_BYTES, `cap=${cap} must resolve to the default`);
    }
  });

  it('treats exactly 0 as the explicit opt-out, and nothing else', async () => {
    // An adopter with a legitimately huge catalog can turn the cap off, but
    // only by asking for it. The slot is still entered so the opt-out also
    // suppresses the implicit default inside the scope.
    let optOutSlot;
    await withResponseSizeLimit(0, async () => {
      optOutSlot = responseSizeLimitStorage.getStore();
    });
    assert.notStrictEqual(optOutSlot, undefined, 'cap=0 must enter an opt-out slot');
    assert.strictEqual(optOutSlot.maxResponseBytes, null, 'cap=0 must disable enforcement');

    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES + 1)));
    const out = await withResponseSizeLimit(0, async () => {
      const response = await wrapped('https://huge-catalog.invalid/mcp');
      return new Uint8Array(await response.arrayBuffer());
    });
    assert.strictEqual(out.byteLength, DEFAULT_MAX_RESPONSE_BYTES + 1);

    // A negative number is a mistake, not an intention — a misparsed env var
    // or a remaining-budget subtraction that went below zero. Failing open on
    // it would disable the cap exactly when the caller least expects it.
    let negativeSlot;
    await withResponseSizeLimit(-1, async () => {
      negativeSlot = responseSizeLimitStorage.getStore();
    });
    assert.strictEqual(negativeSlot.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'cap=-1 must fail closed');
  });

  it('narrows, never widens, when a nested scope passes a larger cap', async () => {
    // Nesting is how the SDK threads a cap down through its own layers. An
    // inner layer must not be able to hand a caller more allowance than the
    // scope they are inside asked for.
    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(5000)));

    await assert.rejects(
      withResponseSizeLimit(1000, () =>
        withResponseSizeLimit(10_000_000, async () => {
          const response = await wrapped('https://example.invalid/');
          return response.arrayBuffer();
        })
      ),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );
  });

  it('inherits an enclosing cap when a nested scope passes an unset cap', async () => {
    // Nested SDK layers re-enter the helper on the way down (`callTool` →
    // `callMCPToolWithTasks`). An inner layer that wasn't handed the
    // caller's `transport` must not widen a tight outer cap back to 4 MiB.
    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(2000)));

    await assert.rejects(
      withResponseSizeLimit(1000, () =>
        withResponseSizeLimit(undefined, async () => {
          const response = await wrapped('https://example.invalid/');
          return response.arrayBuffer();
        })
      ),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );
  });

  it('nested scopes tighten the cap, in either direction', async () => {
    // The SDK resolves per-call vs constructor with `??` *before* entering the
    // slot, so nesting is only ever SDK layers threading the same value down.
    // Treating a nested scope as "narrow only" means an inner layer can never
    // hand back more allowance than the scope it is inside asked for.
    const payload = new Uint8Array(2000);
    const wrapped = wrapFetchWithSizeLimit(makeFetch(payload));

    // Outer cap (1000) binds even though the inner scope asks for more.
    await assert.rejects(
      withResponseSizeLimit(1000, () =>
        withResponseSizeLimit(5000, async () => {
          const response = await wrapped('https://example.invalid/');
          return response.arrayBuffer();
        })
      ),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );

    // Inner cap (1000) binds when it is the tighter of the two.
    await assert.rejects(
      withResponseSizeLimit(5000, () =>
        withResponseSizeLimit(1000, async () => {
          const response = await wrapped('https://example.invalid/');
          return response.arrayBuffer();
        })
      ),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );

    // And a single scope wide enough for the body still lets it through.
    const out = await withResponseSizeLimit(5000, async () => {
      const response = await wrapped('https://example.invalid/');
      return new Uint8Array(await response.arrayBuffer());
    });
    assert.strictEqual(out.byteLength, 2000);
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

describe('responseSizeLimit — SSE enforcement', () => {
  // Builds an SSE body as a stream of discrete chunks so the transform sees
  // realistic framing rather than one giant buffer.
  function sseFetch(chunks, headers = {}) {
    return async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }
      );
  }

  async function drain(response) {
    return new Uint8Array(await response.arrayBuffer()).byteLength;
  }

  // MCP and A2A deliver tool responses over a POST stream, which is the
  // call-scoped case. A bare `fetch(url)` is a GET, and GET event-streams
  // meter per connection — see the connection-scoped suite below.
  const POST = { method: 'POST' };

  it('rejects a single SSE event larger than the per-response cap', async () => {
    // The memory bound: an SSE consumer buffers one frame before dispatching
    // it, so one multi-gigabyte frame is the memory bomb the cap exists for.
    // Previously `Content-Type: text/event-stream` was a free opt-out.
    // Sized to stay inside the cumulative allowance so this asserts the
    // per-event bound specifically, not the stream bound.
    const wrapped = wrapFetchWithSizeLimit(sseFetch([`data: ${'x'.repeat(1200)}\n\n`]));

    await assert.rejects(
      withResponseSizeLimit(1000, async () => drain(await wrapped('https://hostile.invalid/mcp', POST))),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );
  });

  it('rejects a single oversized SSE event split across many chunks', async () => {
    // Chunk boundaries must not reset the per-event counter: 8 chunks of
    // 150 bytes with no blank line between them is still one 1,200-byte
    // event, and 1,200 is over the per-event cap but under the stream one.
    const chunks = ['data: '];
    for (let i = 0; i < 8; i += 1) chunks.push('y'.repeat(150));
    chunks.push('\n\n');
    const wrapped = wrapFetchWithSizeLimit(sseFetch(chunks));

    await assert.rejects(
      withResponseSizeLimit(1000, async () => drain(await wrapped('https://hostile.invalid/mcp', POST))),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );
  });

  it('rejects an endless drip of individually legal SSE frames once the call budget is spent', async () => {
    // The liveness bound. Each frame is well under the per-event cap, but
    // the cumulative allowance for one call is bounded too, so a peer can't
    // stream forever in small, legal frames.
    const cap = 1000;
    const frame = `: ${'z'.repeat(500)}\n\n`;
    const frameCount = Math.ceil((cap * SSE_CUMULATIVE_BUDGET_MULTIPLIER * 2) / frame.length);
    const wrapped = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: frameCount }, () => frame)));

    await assert.rejects(
      withResponseSizeLimit(cap, async () => drain(await wrapped('https://hostile.invalid/mcp', POST))),
      err => err instanceof ResponseTooLargeError && err.limit === cap * SSE_CUMULATIVE_BUDGET_MULTIPLIER
    );
  });

  it('spends the cumulative SSE budget across every stream read in one call', async () => {
    // "Cumulative per call", not "cumulative per response": a peer must not
    // reset its allowance by splitting the flood over several SSE replies on
    // the same call.
    const cap = 1000;
    const frame = `: ${'z'.repeat(400)}\n\n`;
    const perResponse = Math.ceil((cap * SSE_CUMULATIVE_BUDGET_MULTIPLIER) / (frame.length * 2));
    const wrapped = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: perResponse }, () => frame)));

    await assert.rejects(
      withResponseSizeLimit(cap, async () => {
        // Each individual response is under the budget; repeating it is not.
        for (let i = 0; i < 4; i += 1) {
          await drain(await wrapped('https://hostile.invalid/mcp', POST));
        }
      }),
      err => err instanceof ResponseTooLargeError && err.limit === cap * SSE_CUMULATIVE_BUDGET_MULTIPLIER
    );
  });

  it('pre-rejects an SSE response whose declared Content-Length exceeds the call budget', async () => {
    const upstream = async () =>
      new Response(new Uint8Array(16), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-length': String(1000 * SSE_CUMULATIVE_BUDGET_MULTIPLIER + 1),
        },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => drain(await wrapped('https://hostile.invalid/mcp', POST))),
      err =>
        err instanceof ResponseTooLargeError &&
        err.contentLengthHeader === 1000 * SSE_CUMULATIVE_BUDGET_MULTIPLIER + 1 &&
        err.bytesRead === 0
    );
  });

  it('lets a normal multi-frame tool call through untouched', async () => {
    // The thing the old bypass was protecting: a tool call that emits many
    // status frames plus a final result must still complete.
    const frames = [];
    for (let i = 0; i < 50; i += 1) frames.push(`event: status\ndata: {"n":${i}}\n\n`);
    frames.push(`event: result\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const expected = new TextEncoder().encode(frames.join('')).byteLength;
    const wrapped = wrapFetchWithSizeLimit(sseFetch(frames));

    const read = await withResponseSizeLimit(1000, async () =>
      drain(await wrapped('https://example.invalid/mcp', POST))
    );
    assert.strictEqual(read, expected);
  });

  it('recognises every SSE line-ending style when resetting the per-event counter', async () => {
    // SSE allows CRLF, LF, and bare CR. If the scanner only understood LF, a
    // CRLF-framed stream would look like one unbounded event and legitimate
    // traffic would be rejected.
    for (const eol of ['\n', '\r\n', '\r']) {
      const frames = [];
      // Three frames of ~608 B stays inside the cumulative allowance, so a
      // failure here means the per-event counter never reset.
      for (let i = 0; i < 3; i += 1) frames.push(`data: ${'a'.repeat(600)}${eol}${eol}`);
      const expected = new TextEncoder().encode(frames.join('')).byteLength;
      const wrapped = wrapFetchWithSizeLimit(sseFetch(frames));

      const read = await withResponseSizeLimit(1000, async () =>
        drain(await wrapped('https://example.invalid/mcp', POST))
      );
      assert.strictEqual(read, expected, `eol=${JSON.stringify(eol)} must frame correctly`);
    }
  });

  it('keeps framing state across empty and newline-free chunks', async () => {
    // The per-byte scanner has a fast path for chunks with no line ending at
    // all, and an empty chunk must not take it: clearing the carried-over
    // line-ending state there would merge two events into one and reject a
    // perfectly legal stream.
    const empty = new Uint8Array(0);
    const frames = [];
    for (let i = 0; i < 3; i += 1) {
      frames.push('data: ', 'a'.repeat(600), empty, '\r', empty, '\n', '\r\n');
    }
    const expected = frames.reduce(
      (n, c) => n + (typeof c === 'string' ? new TextEncoder().encode(c).byteLength : c.byteLength),
      0
    );
    const wrapped = wrapFetchWithSizeLimit(sseFetch(frames));

    const read = await withResponseSizeLimit(1000, async () =>
      drain(await wrapped('https://example.invalid/mcp', POST))
    );
    assert.strictEqual(read, expected);
  });

  it('does not charge a CRLF separator to the event that follows it', async () => {
    // The separator's trailing LF belongs to the separator. Charging it to the
    // next event docks one byte from its allowance, so two identical
    // CRLF-framed events of exactly `maxBytes` would see the first pass and
    // the second rejected. Each `body` below is exactly `cap` octets
    // including its own separator.
    const cap = 256;
    const eol = '\r\n';
    const body = `data: ${'a'.repeat(cap - 'data: '.length - eol.length * 2)}${eol}${eol}`;
    assert.strictEqual(new TextEncoder().encode(body).byteLength, cap);

    // Whole-frame chunks, and splits placed on each byte of the separator so
    // the boundary state has to survive a chunk edge.
    const splits = [null, cap - 4, cap - 3, cap - 2, cap - 1];
    for (const splitAt of splits) {
      const chunks = [];
      // Two frames is all the cumulative allowance (cap * 2) permits — this
      // test is about the per-event boundary, not the stream bound.
      for (let i = 0; i < 2; i += 1) {
        if (splitAt === null) chunks.push(body);
        else chunks.push(body.slice(0, splitAt), body.slice(splitAt));
      }
      const expected = new TextEncoder().encode(body).byteLength * 2;
      const wrapped = wrapFetchWithSizeLimit(sseFetch(chunks));

      const read = await withResponseSizeLimit(cap, async () =>
        drain(await wrapped('https://example.invalid/mcp', POST))
      );
      assert.strictEqual(read, expected, `splitAt=${splitAt} must not dock the next event`);
    }
  });

  it('still rejects a CRLF-framed event one byte over the cap', async () => {
    // The companion to the test above: the separator fix must not hand out a
    // free byte in the other direction.
    const cap = 256;
    const eol = '\r\n';
    const body = `data: ${'a'.repeat(cap - 'data: '.length - eol.length * 2 + 1)}${eol}${eol}`;
    const wrapped = wrapFetchWithSizeLimit(sseFetch([body]));

    await assert.rejects(
      withResponseSizeLimit(cap, async () => drain(await wrapped('https://hostile.invalid/mcp', POST))),
      err => err instanceof ResponseTooLargeError && err.limit === cap
    );
  });

  it('frames identically however the stream is chopped into chunks', async () => {
    // The scanner carries CR / LF / CRLF state across chunk edges, and the
    // deferred-reset bookkeeping for a separator's trailing LF is the easiest
    // part to get wrong. Differential test: for each framing style, the bytes
    // read must not depend on where the chunk boundaries fall.
    const bodies = [
      'data: one\n\ndata: two\n\n',
      'data: one\r\n\r\ndata: two\r\n\r\n',
      'data: one\r\rdata: two\r\r',
      'event: a\r\ndata: 1\r\n\r\nevent: b\ndata: 2\n\n',
      ': keepalive\n\n: keepalive\r\n\r\n',
      'data: trailing-cr\r\n\r',
      'data: mixed\n\r\ndata: more\r\n\n',
    ];
    const splitters = [
      body => [body],
      body => [...body],
      body => body.match(/.{1,3}/gs) ?? [],
      body => body.match(/.{1,7}/gs) ?? [],
      // Zero-length chunks between every byte: the guard for carried-over state.
      body => [...body].flatMap(ch => [new Uint8Array(0), ch]),
    ];

    for (const body of bodies) {
      const expected = new TextEncoder().encode(body).byteLength;
      for (const [index, split] of splitters.entries()) {
        const wrapped = wrapFetchWithSizeLimit(sseFetch(split(body)));
        const read = await withResponseSizeLimit(1000, async () =>
          drain(await wrapped('https://example.invalid/mcp', POST))
        );
        assert.strictEqual(read, expected, `splitter=${index} body=${JSON.stringify(body)}`);
      }
    }
  });

  it('applies SSE enforcement for every content-type spelling', async () => {
    // Some servers send `text/event-stream; charset=utf-8` or
    // `Text/Event-Stream`. A case-sensitive match would be a free opt-out.
    for (const contentType of [
      'text/event-stream',
      'text/event-stream; charset=utf-8',
      'Text/Event-Stream',
      'TEXT/EVENT-STREAM; charset=utf-8',
    ]) {
      const wrapped = wrapFetchWithSizeLimit(
        sseFetch([`data: ${'x'.repeat(1200)}\n\n`], { 'content-type': contentType })
      );

      await assert.rejects(
        withResponseSizeLimit(1000, async () => drain(await wrapped('https://hostile.invalid/mcp', POST))),
        err => err instanceof ResponseTooLargeError,
        `content-type=${contentType} must still be capped`
      );
    }
  });

  it('bounds SSE by default when no cap was configured', async () => {
    const frame = `: ${'z'.repeat(64 * 1024)}\n\n`;
    const budget = DEFAULT_MAX_RESPONSE_BYTES * SSE_CUMULATIVE_BUDGET_MULTIPLIER;
    const frameCount = Math.ceil((budget * 1.25) / frame.length);
    const wrapped = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: frameCount }, () => frame)));

    await assert.rejects(
      (async () => drain(await wrapped('https://hostile.invalid/mcp', POST)))(),
      err => err instanceof ResponseTooLargeError && err.limit === budget
    );
  });

  it('shares one cumulative allowance across nested scopes that pass an explicit cap', async () => {
    // `callTool` and `callMCPToolWithTasks` both re-enter
    // `withResponseSizeLimit` with the same explicit number. If each layer
    // minted a fresh allowance, the cumulative bound would scale with nesting
    // depth — leaving the adopter who configured a cap *less* protected than
    // the one who configured nothing.
    const cap = 1000;
    const frame = `: ${'z'.repeat(400)}\n\n`;
    const wrapped = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: 2 }, () => frame)));

    await assert.rejects(
      withResponseSizeLimit(cap, async () => {
        for (let i = 0; i < 4; i += 1) {
          // Each iteration re-enters with the same explicit cap, exactly as
          // the nested SDK layers do.
          await withResponseSizeLimit(cap, async () => drain(await wrapped('https://hostile.invalid/mcp', POST)));
        }
      }),
      err => err instanceof ResponseTooLargeError && err.limit === cap * SSE_CUMULATIVE_BUDGET_MULTIPLIER
    );
  });

  it('nesting narrows the cumulative allowance and never widens it', async () => {
    const frame = `: ${'z'.repeat(400)}\n\n`;
    const wrapped = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: 2 }, () => frame)));

    await assert.rejects(
      // Outer 1 KiB → 2 KiB allowance. The inner scope asks for far more; the
      // enclosing allowance still binds.
      withResponseSizeLimit(1000, () =>
        withResponseSizeLimit(1024 * 1024, async () => {
          for (let i = 0; i < 4; i += 1) {
            await drain(await wrapped('https://hostile.invalid/mcp', POST));
          }
        })
      ),
      err => err instanceof ResponseTooLargeError && err.limit === 1000 * SSE_CUMULATIVE_BUDGET_MULTIPLIER
    );
  });

  it('meters a connection-scoped GET event-stream per connection, not per call', async () => {
    // MCP's standalone notification listener and the legacy SSE transport
    // open one GET stream that outlives the call that established it. Charging
    // a whole session to one call's allowance would kill the listener
    // mid-session through no fault of any single response — so a GET stream
    // gets its own allowance, still bounded, just bounded per stream.
    const cap = 1000;
    const frame = `: ${'z'.repeat(400)}\n\n`;
    const wrapped = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: 2 }, () => frame)));

    // Four GET streams that would blow a shared per-call allowance twice over.
    const total = await withResponseSizeLimit(cap, async () => {
      let read = 0;
      for (let i = 0; i < 4; i += 1) read += await drain(await wrapped('https://example.invalid/mcp'));
      return read;
    });
    assert.strictEqual(total, frame.length * 2 * 4);

    // Still bounded within one stream, though.
    const flood = wrapFetchWithSizeLimit(sseFetch(Array.from({ length: 20 }, () => frame)));
    await assert.rejects(
      withResponseSizeLimit(cap, async () => drain(await flood('https://hostile.invalid/mcp'))),
      err => err instanceof ResponseTooLargeError && err.limit === cap * SSE_CUMULATIVE_BUDGET_MULTIPLIER
    );
  });

  it('still enforces the cap on application/json responses 10× the cap (regression check)', async () => {
    // Negative case: SSE handling must not weaken the cap on the one-shot
    // JSON discovery path it was designed for.
    const oversized = new Uint8Array(10_000);
    const upstream = makeFetch(oversized, { 'content-type': 'application/json' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://hostile.invalid/');
        return response.arrayBuffer();
      }),
      err => err instanceof ResponseTooLargeError
    );
  });
});

describe('responseSizeLimit — content-encoding', () => {
  it('leaves Accept-Encoding alone so honest peers keep compressing', async () => {
    // The SDK used to force `Accept-Encoding: identity` whenever a cap was
    // active. That does not stop decompression — a runtime decodes on the
    // *response's* `Content-Encoding` regardless of what was asked for — so
    // with the cap now on by default it would have cost every adopter their
    // response compression in exchange for nothing. The bound that does not
    // depend on the peer is the counter itself; see the next test.
    let observed = 'unset';
    const upstream = async (_input, init) => {
      observed = init?.headers === undefined ? 'unset' : new Headers(init.headers).get('accept-encoding');
      return new Response(new Uint8Array(64));
    };
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await withResponseSizeLimit(1000, () => wrapped('https://example.invalid/'));
    assert.strictEqual(observed, 'unset');

    await wrapped('https://example.invalid/');
    assert.strictEqual(observed, 'unset');
  });

  it("passes the caller's init through untouched", async () => {
    // The SDK's OAuth client-credentials flow reads `init.headers` back as a
    // plain object. Reshaping it to a `Headers` instance broke that, and any
    // adopter-supplied `trustedFetchFn` doing the same.
    let observedInit;
    const upstream = async (_input, init) => {
      observedInit = init;
      return new Response(new Uint8Array(64));
    };
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const init = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: 'x=1' };
    await withResponseSizeLimit(1000, () => wrapped('https://example.invalid/', init));
    assert.strictEqual(observedInit, init, 'init must be forwarded by reference');
    assert.deepStrictEqual(observedInit.headers, { authorization: 'Bearer tok' });
  });

  it('counts decompressed octets, so a gzip bomb trips the cap on its output', async () => {
    // A hostile peer ships a few KB that inflate to far more. The counter
    // sits downstream of the decoder, so it measures what actually lands in
    // memory and errors at the cap rather than at the wire size.
    const { gzipSync } = require('node:zlib');
    const inflated = Buffer.alloc(512 * 1024, 0x41);
    const compressed = gzipSync(inflated);
    assert.ok(compressed.byteLength < 4096, 'the fixture must actually be a bomb');

    // Model what a runtime hands back: the decoded body, with the original
    // encoding headers still attached.
    const upstream = async () =>
      new Response(inflated, {
        status: 200,
        headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.byteLength) },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(64 * 1024, async () => {
        const response = await wrapped('https://hostile.invalid/mcp');
        return response.arrayBuffer();
      }),
      err => err instanceof ResponseTooLargeError && err.limit === 64 * 1024 && err.bytesRead > 64 * 1024
    );
  });
});

describe('responseSizeLimit — URL redaction in errors', () => {
  it('strips query string, userinfo and fragment from ResponseTooLargeError.url', async () => {
    // Some agents publish manifests with auth tokens in the query string
    // (`?api_key=…`) or Basic credentials in the authority
    // (`https://user:pass@…`, a supported SDK configuration). The error
    // object is logged, returned to ticket sinks, and surfaced in
    // `error.message` — and now that the cap is on by default it fires on
    // ordinary calls rather than only for adopters who opted in.
    const upstream = makeFetch(new Uint8Array(2000), { 'content-length': '2000' });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://user:sup3rs3cret@example.invalid/mcp?api_key=secret#frag');
        return response.arrayBuffer();
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError);
        assert.strictEqual(err.url, 'https://example.invalid/mcp');
        for (const leak of ['sup3rs3cret', 'secret', 'api_key', 'frag']) {
          assert.ok(!err.message.includes(leak), `error message must not contain ${leak}`);
          assert.ok(!JSON.stringify(err.details).includes(leak), `error details must not contain ${leak}`);
        }
        return true;
      }
    );
  });

  it('reports invalid_url rather than echoing an unparseable input', async () => {
    // Fail closed: an input the URL parser rejects can't be redacted, so it
    // isn't surfaced at all. Shares `sanitizeTransportUrl` with the
    // transport-diagnostics redactor so there is one rule, not two.
    const stubUpstream = async () =>
      new Response(new Uint8Array(2000), { status: 200, headers: { 'content-length': '2000' } });
    const stubWrapped = wrapFetchWithSizeLimit(stubUpstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await stubWrapped('not-a-url-at-all');
        return response.arrayBuffer();
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError);
        assert.strictEqual(err.url, 'invalid_url');
        return true;
      }
    );
  });
});

describe('responseSizeLimit — bodiless responses', () => {
  it('does not reject a HEAD reply whose Content-Length describes the absent body', async () => {
    // A HEAD response declares the length of the body it *would* have sent.
    // Treating that as an oversized body would fail a request that moved no
    // bytes at all.
    const upstream = async () =>
      new Response(null, { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    const response = await withResponseSizeLimit(1000, () =>
      wrapped('https://example.invalid/mcp', { method: 'HEAD' })
    );
    assert.strictEqual(response.status, 200);
  });

  it('still counts a body a peer sends on a HEAD request', async () => {
    // Skipping the pre-check for HEAD is right — the declared length describes
    // a body that was never sent. Skipping the counter is not: a peer that
    // answers a HEAD with a body would otherwise get an unbounded read.
    const upstream = async () =>
      new Response(new Uint8Array(5000), {
        status: 200,
        headers: { 'content-length': String(5 * 1024 * 1024) },
      });
    const wrapped = wrapFetchWithSizeLimit(upstream);

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://hostile.invalid/mcp', { method: 'HEAD' });
        return response.arrayBuffer();
      }),
      // The pre-check was skipped, so this is the streaming counter talking:
      // no `contentLengthHeader`, and bytes actually read.
      err => err instanceof ResponseTooLargeError && err.contentLengthHeader === undefined && err.bytesRead > 1000
    );
  });

  it('returns 204/304 untouched instead of rebuilding a Response the constructor rejects', async () => {
    // `new Response(stream, { status: 204 })` throws. undici never hands us a
    // body on a null-body status, but an adopter `trustedFetchFn` or a test
    // double can — and an untyped TypeError escaping the transport is worse
    // than anything the cap was protecting against.
    for (const status of [204, 304]) {
      const upstream = async () =>
        new Response(null, { status, headers: { 'content-length': String(5 * 1024 * 1024) } });
      const wrapped = wrapFetchWithSizeLimit(upstream);

      const response = await withResponseSizeLimit(1000, () => wrapped('https://example.invalid/mcp'));
      assert.strictEqual(response.status, status);
    }
  });
});

describe('responseSizeLimit — re-surfacing a swallowed violation', () => {
  it('replaces a transport error with the typed error when the cap tripped in the same scope', async () => {
    // Erroring a `TransformStream` reaches whoever reads the body, and not
    // every transport propagates it: the MCP SDK classifies a failed SSE read
    // as a stream disconnect, reconnects, and lets the request time out. The
    // buyer must still see `ResponseTooLargeError` — a timeout tells them
    // nothing about raising the cap or flagging the agent.
    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(5000)));
    const transportError = new Error('Request timed out');

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://hostile.invalid/mcp');
        await response.arrayBuffer().catch(() => {}); // transport swallows it
        throw transportError;
      }),
      err => {
        assert.ok(err instanceof ResponseTooLargeError, 'the typed error must reach the caller');
        assert.strictEqual(err.limit, 1000);
        assert.strictEqual(err.cause, transportError, 'the transport error survives as the cause');
        return true;
      }
    );
  });

  it('leaves an unrelated rejection alone when no cap was tripped', async () => {
    const wrapped = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(10)));
    const transportError = new Error('Request timed out');

    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await wrapped('https://example.invalid/mcp');
        await response.arrayBuffer();
        throw transportError;
      }),
      err => err === transportError
    );
  });

  it('does not fail a scope that tripped the cap on a best-effort sub-fetch', async () => {
    // Several SDK paths deliberately treat a failed sub-fetch as "no result,
    // carry on" — `discoverOAuthMetadata` returns null after exhausting its
    // candidate URLs. Making the violation terminal for the whole scope would
    // fail their caller with RESPONSE_TOO_LARGE and point an operator at the
    // wrong knob. The rewrite only ever replaces a rejection.
    const big = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(5000)));
    const small = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(10)));

    const out = await withResponseSizeLimit(1000, async () => {
      const first = await big('https://hostile.invalid/mcp');
      await first.arrayBuffer().catch(() => {});
      const second = await small('https://example.invalid/mcp');
      return new Uint8Array(await second.arrayBuffer()).byteLength;
    });
    assert.strictEqual(out, 10);
  });

  it('does not record a violation from a connection-scoped listener against the call', async () => {
    // A long-lived GET listener runs in whichever call's async context opened
    // the connection. A breach on it must not fail some unrelated later call
    // that happens to share that scope.
    const listener = wrapFetchWithSizeLimit(
      async () =>
        new Response(new Uint8Array(32 * 1024), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );
    const call = wrapFetchWithSizeLimit(makeFetch(new Uint8Array(10)));

    const out = await withResponseSizeLimit(1000, async () => {
      // The listener's stream blows its own allowance...
      await listener('https://example.invalid/mcp').then(r => r.arrayBuffer().catch(() => {}));
      // ...and the call it is nested inside still completes.
      const response = await call('https://example.invalid/mcp');
      return new Uint8Array(await response.arrayBuffer()).byteLength;
    });
    assert.strictEqual(out, 10);
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

  it('reverts to the default cap immediately after the slot scope exits', async () => {
    // ALS hygiene: once the `withResponseSizeLimit(...)` scope exits, the
    // next call against the same wrapper must see the default rather than
    // the scope's tighter cap. Otherwise an ALS leak across awaits would
    // silently cap subsequent calls.
    const upstream = makeFetch(new Uint8Array(50_000));
    const sharedWrapped = wrapFetchWithSizeLimit(upstream);

    // Inside scope: the tight cap fires.
    await assert.rejects(
      withResponseSizeLimit(1000, async () => {
        const response = await sharedWrapped('https://example.invalid/');
        return response.arrayBuffer();
      }),
      err => err instanceof ResponseTooLargeError && err.limit === 1000
    );

    // Outside scope: same wrapper, default cap, full read of a 50 KiB body.
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
    assert.strictEqual(err.contentLengthHeader, undefined);
    assert.ok(isADCPError(err));
    // details payload doubles as the wire-error body so logs/tickets
    // surface the cap and observed size without re-parsing the message.
    assert.deepStrictEqual(err.details, {
      limit: 1000,
      bytesRead: 1500,
      url: 'https://example.invalid/',
      contentLengthHeader: undefined,
    });
  });

  it('uses the declared-length message branch when the pre-check trips', () => {
    const err = new ResponseTooLargeError(1000, 0, 'https://example.invalid/', 5000);
    assert.match(err.message, /declared 5000 bytes/);
    assert.match(err.message, /1000/);
  });
});
