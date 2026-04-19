/**
 * Reference verifier test helper — stands up the #587 Express middleware on a
 * random localhost port, configured per the signed-requests-runner test-kit
 * contract. Used by request-signing grader tests.
 */

const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  createExpressVerifier,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
} = require('../../dist/lib/signing/index.js');

const KEYS_PATH = path.join(
  __dirname,
  '..',
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Minimal Express-shaped adapter so createExpressVerifier works atop the
 * stdlib node:http server. Extracted so tests can share it; the pattern
 * previously appeared verbatim in three test files.
 */
function makeExpressShim(req, res) {
  const reqShim = {
    method: req.method,
    url: req.url,
    originalUrl: req.url,
    headers: req.headers,
    protocol: 'http',
    get(name) {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : v;
    },
  };
  const resShim = {
    status(code) {
      res.statusCode = code;
      return {
        set(k, v) {
          res.setHeader(k, v);
          return {
            json(body) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            },
          };
        },
      };
    },
  };
  return { reqShim, resShim };
}

/**
 * Stand up a reference request-signing verifier on a random localhost port.
 *
 * `purpose` encodes the caps the caller needs — the replay-window +
 * rate-abuse contracts demand specific `maxEntriesPerKeyid` that conflict
 * with each other on a shared server, so tests spin up purpose-specific
 * instances.
 */
async function startReferenceVerifier({
  purpose = 'omnibus',
  replayCap,
  coversContentDigest = 'either',
  requiredFor = ['create_media_buy'],
} = {}) {
  // Omnibus tests sign every vector with the same keyid; replay cap must be
  // large enough that we don't trip rate_abuse on an unrelated vector.
  // Rate-abuse tests want a tight cap matched to the grader's target.
  const cap = replayCap ?? (purpose === 'rate_abuse' ? 10 : 1000);

  const publicKeys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys.map(k => {
    const pub = { ...k };
    delete pub._private_d_for_test_only;
    return pub;
  });
  const jwks = new StaticJwksResolver(publicKeys);
  const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: cap });
  const revocationStore = new InMemoryRevocationStore({
    issuer: 'http://127.0.0.1',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 3600_000).toISOString(),
    revoked_kids: ['test-revoked-2026'],
    revoked_jtis: [],
  });
  const middleware = createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: coversContentDigest,
      required_for: requiredFor,
    },
    jwks,
    replayStore,
    revocationStore,
    resolveOperation: req => new URL('http://x' + req.originalUrl).pathname.split('/').filter(Boolean).pop(),
  });

  const server = http.createServer(async (req, res) => {
    const body = await readRawBody(req);
    const { reqShim, resShim } = makeExpressShim(req, res);
    reqShim.rawBody = body;
    await new Promise(resolve =>
      middleware(reqShim, resShim, err => {
        if (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal_server_error' }));
          resolve();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        resolve();
      })
    );
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        replayStore,
        revocationStore,
        replayCap: cap,
      });
    });
  });
}

module.exports = {
  makeExpressShim,
  startReferenceVerifier,
  readRawBody,
};
