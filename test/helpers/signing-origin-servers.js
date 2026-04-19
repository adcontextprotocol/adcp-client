/**
 * Shared in-process HTTPS origins for request-signing tests.
 *
 * Tests drive the mutable `state` between requests to simulate a counterparty
 * rotating its JWKS / publishing a new revocation snapshot / going silent.
 * The server instances are ref-counted: `stop()` closes active sockets and
 * resolves when the listener is fully torn down so the event loop doesn't
 * stay alive after the assertion block returns.
 */

const http = require('node:http');

/**
 * JWKS server whose keyset + ETag + Cache-Control are mutable mid-run.
 *
 * Instruments request counts and the `If-None-Match` header sent on each
 * request so tests can assert the resolver actually refetched rather than
 * serving stale — the scenarios here are load-bearing for verifier behavior
 * and a test that passes against a stale cache would be worse than useless.
 */
async function startJwksServer(initial) {
  const state = {
    jwks: initial.jwks,
    etag: initial.etag ?? 'v1',
    cacheControl: initial.cacheControl ?? 'max-age=0',
    requestCount: 0,
    ifNoneMatchSeen: [],
  };
  const server = http.createServer((req, res) => {
    state.requestCount += 1;
    const ifNoneMatch = req.headers['if-none-match'];
    state.ifNoneMatchSeen.push(ifNoneMatch ?? null);
    if (ifNoneMatch && ifNoneMatch === state.etag) {
      res.writeHead(304, { etag: state.etag, 'cache-control': state.cacheControl });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/jwk-set+json',
      etag: state.etag,
      'cache-control': state.cacheControl,
    });
    res.end(JSON.stringify({ keys: state.jwks }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/jwks.json`,
    state,
    stop: () => new Promise(r => server.close(() => r())),
  };
}

/**
 * Revocation-list server whose served snapshot is mutable mid-run. Supports a
 * `state.responseOverride` hook so tests can simulate a misbehaving origin
 * (500s, non-JSON bodies, truncated snapshots) without rebuilding the server.
 */
async function startRevocationServer(initial) {
  const state = {
    snapshot: initial,
    requestCount: 0,
    /** When set, replaces the default 200-JSON response. Receives (req, res). */
    responseOverride: null,
  };
  const server = http.createServer((req, res) => {
    state.requestCount += 1;
    if (typeof state.responseOverride === 'function') {
      state.responseOverride(req, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.snapshot));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/revocation.json`,
    state,
    stop: () => new Promise(r => server.close(() => r())),
  };
}

/**
 * Build a well-formed RevocationSnapshot payload for tests.
 */
function revocationSnapshot({ issuer = 'urn:test', revoked = [], updatedAt, nextUpdateAt }) {
  return {
    issuer,
    updated: new Date(updatedAt * 1000).toISOString(),
    next_update: new Date(nextUpdateAt * 1000).toISOString(),
    revoked_kids: revoked,
    revoked_jtis: [],
  };
}

module.exports = {
  startJwksServer,
  startRevocationServer,
  revocationSnapshot,
};
