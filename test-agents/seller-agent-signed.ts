/**
 * Signed-requests test agent — minimal HTTP server that exposes an
 * `createExpressVerifier` middleware pre-configured per the
 * `signed-requests-runner` test-kit contract. Intended for end-to-end
 * smoke-testing the conformance grader shipped in
 * adcontextprotocol/adcp-client#585.
 *
 * This is NOT an MCP agent — the conformance vectors target raw-HTTP AdCP
 * endpoints (e.g., `/adcp/create_media_buy`), and the RFC 9421 verifier is
 * a transport-layer concern independent of the MCP/A2A wrapping. A future
 * MCP-aware grader (issue TBD) will layer JSON-RPC envelope handling on
 * top; this agent validates the signing-layer contract standalone.
 *
 * Run locally:
 *   npm run build:test-agents
 *   PORT=3100 node test-agents/dist/seller-agent-signed.js
 *
 * Grade from another shell:
 *   node bin/adcp.js grade request-signing http://127.0.0.1:3100 --allow-http --skip-rate-abuse
 *
 * Verifier is pre-configured per `test-kits/signed-requests-runner.yaml`:
 *   - JWKS includes test-ed25519-2026, test-es256-2026, test-gov-2026,
 *     test-revoked-2026.
 *   - test-revoked-2026 pre-revoked.
 *   - Per-keyid replay cap = 100 (matches the contract's grading target).
 *
 * Do NOT deploy to production — the test keypairs are publicly published
 * in the AdCP spec repository.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createExpressVerifier,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  type AdcpJsonWebKey,
} from '@adcp/client/signing';

const COMPLIANCE_CACHE = process.env.ADCP_COMPLIANCE_DIR ?? resolveComplianceCache();

function resolveComplianceCache(): string {
  for (const candidate of [
    join(__dirname, '..', 'compliance', 'cache', 'latest'),
    join(__dirname, '..', '..', 'compliance', 'cache', 'latest'),
  ]) {
    try {
      readFileSync(join(candidate, 'test-vectors', 'request-signing', 'keys.json'));
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`Cannot locate compliance/cache/latest/ relative to ${__dirname}. Set ADCP_COMPLIANCE_DIR.`);
}

const KEYS_PATH = join(COMPLIANCE_CACHE, 'test-vectors', 'request-signing', 'keys.json');

const publicKeys: AdcpJsonWebKey[] = (JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys as AdcpJsonWebKey[]).map(k => {
  const pub: AdcpJsonWebKey = { ...k };
  delete (pub as { _private_d_for_test_only?: string })._private_d_for_test_only;
  delete (pub as { d?: string }).d;
  return pub;
});

const jwks = new StaticJwksResolver(publicKeys);
// 100 matches `grading_target_per_keyid_cap_requests` in the test-kit YAML.
const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 100 });
const revocationStore = new InMemoryRevocationStore({
  issuer: 'http://seller.example.com',
  updated: new Date().toISOString(),
  next_update: new Date(Date.now() + 3600_000).toISOString(),
  revoked_kids: ['test-revoked-2026'],
  revoked_jtis: [],
});

const verifier = createExpressVerifier({
  capability: {
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  },
  jwks,
  replayStore,
  revocationStore,
  // Operation = last path segment — matches the vectors' `/adcp/<operation>`
  // shape. Returns undefined for the capability endpoint.
  resolveOperation: req => {
    const pathname = new URL(`http://x${req.originalUrl ?? '/'}`).pathname;
    if (pathname === '/get_adcp_capabilities' || pathname === '/.well-known/adcp-capabilities') return undefined;
    return pathname.split('/').filter(Boolean).pop();
  },
});

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface ExpressReqShim {
  method: string;
  url: string;
  originalUrl: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
  protocol: string;
  get(name: string): string | undefined;
  verifiedSigner?: unknown;
  [extra: string]: unknown;
}

function makeExpressShim(req: IncomingMessage, res: ServerResponse) {
  const reqShim: ExpressReqShim = {
    method: req.method ?? 'POST',
    url: req.url ?? '/',
    originalUrl: req.url ?? '/',
    headers: req.headers,
    rawBody: '',
    protocol: 'http',
    get(name) {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : v;
    },
  };
  const resShim = {
    status(code: number) {
      res.statusCode = code;
      return {
        set(k: string, v: string) {
          res.setHeader(k, v);
          return {
            json(body: unknown) {
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

// Capability shape returned from GET /get_adcp_capabilities. Kept inline —
// this test agent doesn't need the full createAdcpServer surface, just enough
// to satisfy the grader's capability-discovery precondition.
const CAPABILITIES_RESPONSE = {
  adcp: { major_versions: [3], idempotency: { replay_ttl_seconds: 86400 } },
  supported_protocols: ['media_buy'],
  media_buy: {
    features: {
      inline_creative_management: false,
      property_list_filtering: false,
      content_standards: false,
    },
  },
  request_signing: {
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  },
  specialisms: ['signed-requests'],
};

const PORT = Number.parseInt(process.env.PORT ?? '3100', 10);

const server = createServer(async (req, res) => {
  try {
    const rawBody = await readRawBody(req);
    const { reqShim, resShim } = makeExpressShim(req, res);
    reqShim.rawBody = rawBody;

    // Capability discovery is intentionally unsigned — the grader calls this
    // BEFORE it starts signing requests, to confirm the agent opts into the
    // specialism. `resolveOperation` returns undefined here, which the
    // verifier reads as "not in required_for" → skip the signature pipeline.
    if (req.url === '/get_adcp_capabilities' || req.url === '/.well-known/adcp-capabilities') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(CAPABILITIES_RESPONSE));
      return;
    }

    await new Promise<void>(resolve =>
      verifier(reqShim, resShim, err => {
        if (err) {
          // Log the cause internally; the wire never sees err.message /
          // stack — CodeQL rule js/stack-trace-exposure. The response body
          // mirrors the generic shape `createExpressVerifier` itself emits
          // on a signature-pipeline rejection (status + error code).
          console.error('verifier middleware error:', err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'verifier_error' }));
          }
        } else if (!res.writableEnded) {
          // Verifier accepted (or skipped when operation wasn't in
          // required_for). Return a 200 stub — the grader doesn't inspect
          // the response body for positive vectors, only the status.
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, verified: reqShim.verifiedSigner ?? null }));
        }
        resolve();
      })
    );
  } catch (err) {
    // Log internally so operators can debug locally; don't leak the stack
    // trace to the wire (CodeQL rule js/stack-trace-exposure). Every code
    // path here is a test-harness error — the grader treats 500 as a probe
    // error anyway.
    console.error('signed test agent internal error:', err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  }
});

server.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`Signed-requests test agent listening at http://127.0.0.1:${port}`);
  console.log(
    `Grade with: node bin/adcp.js grade request-signing http://127.0.0.1:${port} --allow-http --skip-rate-abuse`
  );
});
