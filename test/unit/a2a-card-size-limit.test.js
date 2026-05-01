/**
 * Integration check that A2A agent-card discovery honors `maxResponseBytes`.
 *
 * The cap is installed in `buildFetchImpl` and handed to the A2A SDK's
 * `A2AClient.fromCardUrl(cardUrl, { fetchImpl })`. That path fetches
 * `/.well-known/agent.json` through our wrapped fetch, so an oversized
 * agent-card must abort with `ResponseTooLargeError` before the body is
 * parsed — which is what we want, because the JSON parse buffers the
 * full body in memory otherwise and is exactly the DoS surface the cap
 * defends against.
 *
 * We exercise this end-to-end against a real loopback HTTP server rather
 * than stubbing `fromCardUrl`, because the contract under test is "the
 * wrapped fetch composes correctly with the A2A SDK's discovery flow."
 * Stubbing `fromCardUrl` would skip the seam.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { wrapFetchWithSizeLimit, withResponseSizeLimit } = require('../../dist/lib/protocols/responseSizeLimit');
const { ResponseTooLargeError } = require('../../dist/lib/errors');

const { A2AClient } = require('@a2a-js/sdk/client');

let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/.well-known/agent.json') {
      // Minimum-viable agent card the A2A SDK will accept (`url` is required
      // for the service endpoint), padded with a hostile-vendor blob in a
      // free-form field. 5 MB is well over any reasonable discovery cap and
      // large enough that buffering it is observable as a DoS.
      const padding = 'x'.repeat(5 * 1024 * 1024);
      const body = JSON.stringify({
        name: 'oversized',
        url: `${baseUrl}/a2a`,
        description: padding,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('A2A agent-card discovery — maxResponseBytes', () => {
  it('aborts the agent-card fetch with ResponseTooLargeError when the card exceeds the cap', async () => {
    // Compose the same way `buildFetchImpl` does internally: the size-limit
    // wrapper goes innermost so the body is bounded before the A2A SDK's
    // `response.json()` reads it. (Capture / signing wrappers are layered
    // on top in production but neither affects this assertion.)
    const wrappedFetch = wrapFetchWithSizeLimit((input, init) => fetch(input, init));

    await assert.rejects(
      withResponseSizeLimit(64 * 1024, async () =>
        A2AClient.fromCardUrl(`${baseUrl}/.well-known/agent.json`, { fetchImpl: wrappedFetch })
      ),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}`
        );
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 64 * 1024);
        // Server emits Content-Length, so the pre-check trips before any
        // body bytes are read. `bytesRead` is 0, `contentLengthHeader`
        // is the server's announced size.
        assert.strictEqual(err.bytesRead, 0);
        assert.ok(err.contentLengthHeader > 64 * 1024);
        return true;
      }
    );
  });

  it('lets a small agent-card flow through unchanged when the cap is generous', async () => {
    // Same server, same wrapper, same path — but with a cap that comfortably
    // exceeds the 5 MB card. Pins the negative case so a future change that
    // tightens the wrapper doesn't silently start rejecting legitimate cards.
    const wrappedFetch = wrapFetchWithSizeLimit((input, init) => fetch(input, init));
    const card = await withResponseSizeLimit(16 * 1024 * 1024, () =>
      A2AClient.fromCardUrl(`${baseUrl}/.well-known/agent.json`, { fetchImpl: wrappedFetch })
    );
    // `fromCardUrl` returns an A2AClient instance built from the parsed card.
    // We don't care about the client beyond "construction succeeded" — the
    // assertion is "no ResponseTooLargeError thrown."
    assert.ok(card, 'A2AClient.fromCardUrl should resolve when the card fits the cap');
  });
});
