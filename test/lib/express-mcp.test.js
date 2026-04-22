// Unit tests for the @adcp/client/express-mcp Accept-header middleware.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { mcpAcceptHeaderMiddleware } = require('../../dist/lib/express-mcp/index.js');

/**
 * Build a minimal IncomingMessage-shaped stub. The middleware only reads
 * and writes `req.headers.accept`; no actual HTTP machinery is needed.
 */
function makeReq(acceptHeader) {
  const headers = {};
  if (acceptHeader !== undefined) headers.accept = acceptHeader;
  return { headers };
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
});
