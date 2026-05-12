/**
 * Regression fixture: Raptive / CafeMedia wire shape as captured on
 * 2026-05-12.
 *
 * Real-world data from probing `ads.cafemedia.com` and `cafemedia.com`
 * during the rollout of RFC 4175 / adcp-client#1717. Two issues found
 * with Raptive's current deployment that this fixture pins:
 *
 *   1. `ads.cafemedia.com/.well-known/adagents.json` returns **HTTP 403**
 *      (S3 `AccessDenied` XML) rather than 404. The RFC's fallback
 *      rule fires only on 404 — so even though `ads.cafemedia.com/ads.txt`
 *      declares `managerdomain=cafemedia.com`, no conforming validator
 *      can chase the fallback. Reported upstream at adcontextprotocol/adcp.
 *
 *   2. `cafemedia.com/.well-known/adagents.json` returns **HTTP 404**,
 *      and `cafemedia.com/ads.txt` ALSO declares
 *      `managerdomain=cafemedia.com` — a self-loop. Our cycle-detection
 *      branch correctly refuses to chase it.
 *
 * This test pins the two outcomes so we catch the day Raptive either
 * fixes their bucket policy (403→404) or hosts an authoritative
 * adagents.json on `cafemedia.com`. When that happens, the assertions
 * will flip and we'll know to update the test (and the upstream issue
 * can close).
 */

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { validateAdAgents } = require('../../dist/lib/discovery/validate-adagents.js');

// Captured 2026-05-12 from https://ads.cafemedia.com/ads.txt — only the
// header + managerdomain + first few records, enough to exercise the
// directive parser without checking in 5 KB of SSP records.
const ADS_CAFEMEDIA_ADS_TXT = `#Raptive ads.txt (CafeMedia/AdThrive) v2.70-auto
managerdomain=cafemedia.com
contact=info@raptive.com
google.com, pub-8501674430909082, DIRECT, f08c47fec0942fa0 #video, banner
google.com, pub-8501674430909082, RESELLER, f08c47fec0942fa0 #video, banner
`;

// Captured 2026-05-12 from https://cafemedia.com/ads.txt — same shape,
// self-referencing managerdomain.
const CAFEMEDIA_ADS_TXT = `# CafeMedia/AdThrive ads.txt v2.60-auto
managerdomain=cafemedia.com
contact=info@adthrive.com
google.com, pub-8501674430909082, DIRECT, f08c47fec0942fa0 #video, banner
`;

// Real S3 AccessDenied body shape. The HTTP status (403) is the only
// part the validator inspects, but pinning the body documents what
// publishers on AWS see by default.
const S3_ACCESS_DENIED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>53ZTTYHFDF7PN7GN</RequestId></Error>`;

/**
 * Stand up two loopback servers that mirror what `ads.cafemedia.com`
 * and `cafemedia.com` returned on 2026-05-12. Returns a `urlForDomain`
 * builder + cleanup hook to point the validator at the loopback hosts
 * while preserving the publisher-domain values the validator sees in
 * its result and error messages.
 */
async function startCafeMediaMirror() {
  const adsServer = await startServer((req, res) => {
    if (req.url === '/ads.txt') return respondText(res, 200, ADS_CAFEMEDIA_ADS_TXT);
    if (req.url === '/.well-known/adagents.json') return respondXml(res, 403, S3_ACCESS_DENIED_XML);
    respondText(res, 404, 'Not Found');
  });
  const managerServer = await startServer((req, res) => {
    if (req.url === '/ads.txt') return respondText(res, 200, CAFEMEDIA_ADS_TXT);
    // `/.well-known/adagents.json` falls through to 404 — matching live
    if (req.url === '/.well-known/adagents.json') return respondText(res, 404, 'Not Found');
    respondText(res, 404, 'Not Found');
  });

  const urlForDomain = (domain, path) => {
    if (domain === 'ads.cafemedia.com') return `http://${adsServer.host}${path}`;
    if (domain === 'cafemedia.com') return `http://${managerServer.host}${path}`;
    // Default to publisher's loopback for any unexpected domain — fail
    // loudly if our fixture-driven code accidentally reaches into the
    // real internet.
    throw new Error(`Unexpected domain in CafeMedia fixture: ${domain}`);
  };

  return {
    urlForDomain,
    cleanup: () => Promise.all([adsServer.close(), managerServer.close()]),
  };
}

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ host: `127.0.0.1:${port}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

function respondText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

function respondXml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(body);
}

describe('validateAdAgents — Raptive/CafeMedia wire shape (captured 2026-05-12)', () => {
  test('ads.cafemedia.com: 403 (S3) on adagents.json must NOT trigger fallback (spec: 404-only)', async () => {
    const mirror = await startCafeMediaMirror();
    try {
      const result = await validateAdAgents('ads.cafemedia.com', { urlForDomain: mirror.urlForDomain });
      // Spec-correct outcome:
      // - 403 ≠ 404, so the validator must NOT consult ads.txt at all.
      // - Even though ads.txt declares `managerdomain=cafemedia.com`,
      //   the validator stays on the direct path with a terminal 403.
      // - manager_domain is NOT populated (we never reached the
      //   fallback decision).
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.strictEqual(result.manager_domain, undefined);
      assert.ok(
        result.errors.some(e => e.includes('HTTP 403')),
        `expected error mentioning HTTP 403, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await mirror.cleanup();
    }
  });

  test('cafemedia.com: 404 → fallback fires → MANAGERDOMAIN points at self → cycle rejected', async () => {
    const mirror = await startCafeMediaMirror();
    try {
      const result = await validateAdAgents('cafemedia.com', { urlForDomain: mirror.urlForDomain });
      // Spec-correct outcome:
      // - 404 on adagents.json → ads.txt is consulted.
      // - ads.txt declares `managerdomain=cafemedia.com` (self).
      // - Cycle detected — discovery_method stays 'direct' (we never
      //   commit to the managerdomain hop) and manager_domain is NOT
      //   populated (no chase happened).
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.strictEqual(result.manager_domain, undefined);
      assert.ok(
        result.errors.some(e => e.toLowerCase().includes('cycle')),
        `expected cycle error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await mirror.cleanup();
    }
  });
});
