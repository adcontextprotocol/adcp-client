// Unit tests for the @adcp/sdk/express-mcp Accept-header middleware.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { mcpAcceptHeaderMiddleware } = require('../../dist/lib/express-mcp/index.js');

/**
 * Build a minimal IncomingMessage-shaped stub. The middleware reads and
 * writes BOTH `req.headers.accept` and matching entries in `req.rawHeaders`
 * (the transport path MCP uses reads `rawHeaders`, not the parsed map).
 */
function makeReq(acceptHeader, options = {}) {
  const headers = {};
  if (acceptHeader !== undefined) headers.accept = acceptHeader;
  const req = { headers };
  if (options.rawHeaders !== undefined) {
    req.rawHeaders = options.rawHeaders;
  } else if (acceptHeader !== undefined) {
    // Default: mirror the parsed `accept` into `rawHeaders` with the
    // header name in its wire-level casing (Express / Node preserve it).
    req.rawHeaders = [options.rawHeaderName ?? 'Accept', acceptHeader];
  }
  return req;
}

function runMiddleware(req) {
  const middleware = mcpAcceptHeaderMiddleware();
  let nextCalled = false;
  let nextErr;
  middleware(req, /* res */ {}, err => {
    nextCalled = true;
    nextErr = err;
  });
  return { nextCalled, nextErr };
}

describe('mcpAcceptHeaderMiddleware', () => {
  test('rewrites Accept: application/json to include text/event-stream', () => {
    const req = makeReq('application/json');
    const { nextCalled, nextErr } = runMiddleware(req);

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(nextErr, undefined);
    assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
  });

  test('rewrites JSON-only Accept with quality params', () => {
    const req = makeReq('application/json;q=0.9');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
  });

  test('leaves Accept untouched when both types are already present', () => {
    const req = makeReq('application/json, text/event-stream');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
  });

  test('leaves Accept untouched when both types present in reverse order', () => {
    const req = makeReq('text/event-stream, application/json');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, 'text/event-stream, application/json');
  });

  test('leaves Accept untouched when header is absent', () => {
    const req = makeReq(undefined);
    const { nextCalled } = runMiddleware(req);

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.headers.accept, undefined);
  });

  test('leaves Accept untouched when header is empty string', () => {
    const req = makeReq('');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, '');
  });

  test('leaves Accept untouched for wildcard (*/*)', () => {
    const req = makeReq('*/*');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, '*/*');
  });

  test('leaves Accept untouched for non-MCP media types', () => {
    const req = makeReq('text/html, application/xhtml+xml');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, 'text/html, application/xhtml+xml');
  });

  test('leaves Accept untouched for text/event-stream alone', () => {
    const req = makeReq('text/event-stream');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, 'text/event-stream');
  });

  test('is case-insensitive on media-type detection', () => {
    const req = makeReq('Application/JSON');
    runMiddleware(req);
    assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
  });

  test('always invokes next() without error', () => {
    for (const header of [
      'application/json',
      'application/json, text/event-stream',
      '*/*',
      'text/html',
      '',
      undefined,
    ]) {
      const { nextCalled, nextErr } = runMiddleware(makeReq(header));
      assert.strictEqual(nextCalled, true, `next should run for header: ${header}`);
      assert.strictEqual(nextErr, undefined, `next should get no error for header: ${header}`);
    }
  });

  // `StreamableHTTPServerTransport` rebuilds its Fetch `Headers` from
  // `req.rawHeaders` via `@hono/node-server` — patching only `req.headers`
  // is a no-op for that path. These tests pin that the rewrite moves in
  // lockstep across BOTH surfaces.
  describe('rawHeaders (MCP StreamableHTTPServerTransport path)', () => {
    test('rewrites a JSON-only rawHeaders entry alongside req.headers.accept', () => {
      const req = makeReq('application/json');
      runMiddleware(req);
      assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
      assert.deepStrictEqual(req.rawHeaders, ['Accept', 'application/json, text/event-stream']);
    });

    test('matches case-insensitively on the rawHeaders name (ACCEPT / accept / Accept)', () => {
      for (const name of ['Accept', 'ACCEPT', 'accept']) {
        const req = makeReq('application/json', { rawHeaderName: name });
        runMiddleware(req);
        assert.strictEqual(req.rawHeaders[1], 'application/json, text/event-stream', `failed for name=${name}`);
        // Name casing is preserved (middleware only rewrites the VALUE).
        assert.strictEqual(req.rawHeaders[0], name);
      }
    });

    test('rewrites every Accept entry when rawHeaders has duplicates', () => {
      // HTTP permits duplicate header entries; a late copy must not shadow
      // the patched one. All copies get the same rewritten value.
      const req = makeReq('application/json', {
        rawHeaders: ['Accept', 'application/json', 'Accept', 'application/json'],
      });
      runMiddleware(req);
      assert.deepStrictEqual(req.rawHeaders, [
        'Accept',
        'application/json, text/event-stream',
        'Accept',
        'application/json, text/event-stream',
      ]);
    });

    test('leaves rawHeaders untouched when Accept already advertises both types', () => {
      const req = makeReq('application/json, text/event-stream');
      runMiddleware(req);
      assert.deepStrictEqual(req.rawHeaders, ['Accept', 'application/json, text/event-stream']);
    });

    test('leaves rawHeaders untouched when Accept does not advertise JSON', () => {
      const req = makeReq('*/*');
      runMiddleware(req);
      assert.deepStrictEqual(req.rawHeaders, ['Accept', '*/*']);
    });

    test('does not append Accept when rawHeaders has no entry for it', () => {
      // Defence against silent divergence from the pre-middleware request
      // shape — other middleware may read rawHeaders directly and get
      // confused by a phantom entry.
      const req = {
        headers: { accept: 'application/json' },
        rawHeaders: ['Content-Type', 'application/json'],
      };
      runMiddleware(req);
      assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
      assert.deepStrictEqual(req.rawHeaders, ['Content-Type', 'application/json']);
    });

    test('is a no-op when rawHeaders is missing entirely', () => {
      // Some test harnesses / adapters don't synthesize rawHeaders. The
      // middleware must still patch req.headers.accept and invoke next.
      const req = { headers: { accept: 'application/json' } };
      runMiddleware(req);
      assert.strictEqual(req.headers.accept, 'application/json, text/event-stream');
      assert.strictEqual(req.rawHeaders, undefined);
    });
  });
});
