// Positive vector 015 presents a bracketed IPv6 literal with a non-default port
// as the request authority. Raw grading retargets every vector onto the agent's
// own origin and the HTTP client derives `Host` from that URL, so against an
// ordinary DNS or IPv4 endpoint the authority never reaches the agent. These
// tests pin that a skip, never a pass, is reported then, and that a live probe
// still runs where the target can carry the authority.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  gradeOneVector,
  gradeRequestSigning,
  loadRequestSigningVectors,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');
const { probeRequestSigningVector } = require('../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
const { signingCoverage } = require('../dist/lib/testing/storyboard/runner.js');
const { DETAILED_SKIP_TO_CANONICAL } = require('../dist/lib/testing/storyboard/types.js');
const {
  verifyRequestSignature,
  RequestSignatureError,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../dist/lib/signing/index.js');

const VECTORS = [
  { id: '015-bracketed-ipv6-host-with-port', profile: undefined },
  { id: 'profile-3.2/positive/015-bracketed-ipv6-host-with-port', profile: '3.2' },
];
const rawKeys = JSON.parse(
  readFileSync(path.join(__dirname, '../compliance/cache/latest/test-vectors/request-signing/keys.json'), 'utf8')
).keys;

function listen(host, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}
const close = server => new Promise(resolve => server.close(() => resolve()));

/** An agent that records what reached it and accepts everything. */
async function recordingAgent(host = '127.0.0.1') {
  const seen = [];
  const server = await listen(host, (req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  return { server, seen, port: server.address().port };
}

const grade = (vector, url, extra = {}) =>
  gradeOneVector(vector.id, 'positive', url, {
    transport: 'raw',
    allowPrivateIp: true,
    ...(vector.profile ? { signingProfileVersion: vector.profile } : {}),
    ...extra,
  });

describe('raw grading of 015 without an IPv6-with-port target', () => {
  for (const vector of VECTORS) {
    for (const [label, url] of [
      ['an IPv4 endpoint', port => `http://127.0.0.1:${port}`],
      ['a DNS name', port => `http://localhost:${port}`],
    ]) {
      test(`${vector.id} against ${label} is skipped without touching the agent`, async () => {
        const agent = await recordingAgent();
        try {
          const result = await grade(vector, url(agent.port));
          assert.equal(result.skipped, true);
          assert.equal(result.skip_reason, 'transport_ungradable');
          assert.equal(result.http_status, 0);
          assert.match(result.diagnostic, /bracketed IPv6 literal with a non-default port/);
          assert.deepEqual(agent.seen, [], 'nothing may be sent for a vector that cannot be presented');
          assert.equal(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'not_applicable');
        } finally {
          await close(agent.server);
        }
      });
    }

    test(`${vector.id} against an IPv6 literal on the default port is skipped`, async () => {
      for (const url of ['http://[::1]', 'https://[2001:db8::1]', 'http://[::1]:80']) {
        const result = await grade(vector, url);
        assert.equal(result.skip_reason, 'transport_ungradable', url);
      }
    });

    test(`${vector.id} batch report does not credit the skip as a pass`, async () => {
      const agent = await recordingAgent();
      try {
        const report = await gradeRequestSigning(`http://127.0.0.1:${agent.port}`, {
          transport: 'raw',
          allowPrivateIp: true,
          onlyVectors: [vector.id],
          ...(vector.profile ? { signingProfileVersion: vector.profile } : {}),
        });
        const entry = report.positive.find(row => row.vector_id === vector.id);
        assert.equal(entry.skipped, true);
        assert.equal(entry.skip_reason, 'transport_ungradable');
        assert.equal(report.passed_count, 0);
        assert.equal(agent.seen.length, 0);
      } finally {
        await close(agent.server);
      }
    });

    test(`${vector.id} through the storyboard probe is a skip that grants no signing coverage`, async () => {
      const agent = await recordingAgent();
      try {
        const stepId = `positive-${vector.id}`;
        const result = await probeRequestSigningVector(stepId, `http://127.0.0.1:${agent.port}`, {
          request_signing: { transport: 'raw' },
          allow_http: true,
          ...(vector.profile ? { adcpVersion: '3.2.5' } : {}),
        });
        assert.equal(result.skip_reason, 'transport_ungradable');
        assert.equal(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'not_applicable');
        assert.deepEqual(agent.seen, []);
        const step = {
          task: 'request_signing_probe',
          skipped: true,
          skip_reason: result.skip_reason,
          response: result,
        };
        assert.equal(signingCoverage([step]), 'scope_excluded');
        assert.notEqual(signingCoverage([step]), 'graded');
      } finally {
        await close(agent.server);
      }
    });
  }

  test('pre-existing raw behavior for the other IPv6 edge (011) is unchanged', async () => {
    const agent = await recordingAgent();
    try {
      const result = await gradeOneVector('011-ipv6-authority', 'positive', `http://127.0.0.1:${agent.port}`, {
        transport: 'raw',
        allowPrivateIp: true,
      });
      assert.notEqual(result.skipped, true);
      assert.equal(result.passed, true);
      assert.equal(agent.seen.length, 1);
    } finally {
      await close(agent.server);
    }
  });
});

describe('raw grading of 015 against a bracketed IPv6 target with a non-default port', () => {
  for (const vector of VECTORS) {
    test(`${vector.id} is probed live and the agent sees, and verifies, that authority`, async t => {
      const loaded = loadRequestSigningVectors();
      const fixture = (vector.profile ? loaded.profiles[vector.profile].positive : loaded.positive).find(
        v => v.id === vector.id
      );
      const seen = [];
      const verdicts = [];
      let server;
      try {
        server = await listen('::1', async (req, res) => {
          let body = '';
          for await (const chunk of req) body += chunk;
          seen.push(req.headers.host);
          // The default Express/serve() derivation: the URL authority is the Host the client sent.
          const request = {
            method: req.method,
            url: `http://${req.headers.host}${req.url}`,
            headers: req.headers,
            body,
          };
          try {
            await verifyRequestSignature(request, {
              capability: fixture.verifier_capability,
              jwks: new StaticJwksResolver(rawKeys.filter(key => fixture.jwks_ref.includes(key.kid))),
              replayStore: new InMemoryReplayStore(),
              revocationStore: new InMemoryRevocationStore(),
              operation: 'create_media_buy',
              adcpVersion: fixture.signing_profile_version ?? '3.1',
            });
            verdicts.push('verified');
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          } catch (error) {
            verdicts.push(error instanceof RequestSignatureError ? error.code : String(error));
            res.writeHead(401).end('{}');
          }
        });
      } catch (error) {
        if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') {
          t.skip('IPv6 loopback is not available on this host');
          return;
        }
        throw error;
      }
      try {
        const result = await grade(vector, `http://[::1]:${server.address().port}`);
        assert.notEqual(result.skipped, true, result.diagnostic);
        assert.equal(result.passed, true, result.diagnostic);
        assert.equal(result.http_status, 200);
        assert.equal(seen.length, 1);
        assert.match(seen[0], /^\[::1\]:\d+$/, 'the agent must see a bracketed IPv6 authority with a port');
        assert.deepEqual(verdicts, ['verified']);
      } finally {
        await close(server);
      }
    });
  }
});
