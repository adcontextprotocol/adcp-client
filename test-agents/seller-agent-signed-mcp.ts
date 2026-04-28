/**
 * Signed-requests MCP test agent — `createAdcpServer` + `serve`, with the
 * RFC 9421 verifier wired as a `preTransport` middleware. Grader-compatible
 * in MCP mode:
 *
 *   PORT=3101 npm run build:test-agents && node test-agents/dist/seller-agent-signed-mcp.js
 *   node bin/adcp.js grade request-signing http://127.0.0.1:3101/mcp --allow-http --transport mcp --skip-rate-abuse
 *
 * Verifier config mirrors `seller-agent-signed.ts` (test-kit contract):
 *   - JWKS accepts test-ed25519-2026, test-es256-2026, test-gov-2026,
 *     test-revoked-2026.
 *   - test-revoked-2026 pre-revoked.
 *   - Per-keyid replay cap = 100.
 *
 * Difference vs `seller-agent-signed.ts`: that one is raw HTTP (per-operation
 * endpoints like `/adcp/create_media_buy`). This one is MCP, so the operation
 * name comes from the JSON-RPC body's `params.name` instead of the URL path.
 * `adcp grade --transport mcp` wraps vectors accordingly before signing.
 *
 * Do NOT deploy to production — test keys are publicly published in the
 * AdCP spec repository.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdcpServer, InMemoryStateStore, serve, type ServeContext } from '@adcp/sdk';
import {
  createExpressVerifier,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  type AdcpJsonWebKey,
} from '@adcp/sdk/signing';

// ── Test-kit-driven verifier configuration ──────────────────────────

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
// Per-keyid replay cap defaults to 100 (matches the test-kit's
// grading_target_per_keyid_cap_requests). Override via ADCP_REPLAY_CAP for
// the MCP rate-abuse test, which needs a tight cap it can fill quickly.
// Validate: Number.parseInt on garbage returns NaN, and InMemoryReplayStore's
// size >= NaN comparison is always false — a typo would silently disable
// the rate-abuse guard. Fall back to the default on any non-positive int.
const REPLAY_CAP_RAW = Number.parseInt(process.env.ADCP_REPLAY_CAP ?? '100', 10);
const REPLAY_CAP = Number.isFinite(REPLAY_CAP_RAW) && REPLAY_CAP_RAW > 0 ? REPLAY_CAP_RAW : 100;
const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: REPLAY_CAP });
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
  // MCP: operation = JSON-RPC `params.name`. `req.rawBody` is populated by
  // `serve`'s preTransport hook (the body is buffered once before the
  // transport gets it).
  resolveOperation: req => {
    const raw = (req as { rawBody?: string }).rawBody;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { method?: string; params?: { name?: string } };
      if (parsed.method === 'tools/call' && typeof parsed.params?.name === 'string') {
        return parsed.params.name;
      }
    } catch {
      // non-JSON body — let verifier see no operation
    }
    return undefined;
  },
});

// ── MCP agent ──────────────────────────────────────────────────────

const stateStore = new InMemoryStateStore();

function createAgent({ taskStore }: ServeContext) {
  return createAdcpServer({
    name: 'Signed-Requests MCP Test SSP',
    version: '1.0.0',
    taskStore,
    stateStore,
    resolveAccount: async ref => {
      if ('account_id' in ref) return stateStore.get('accounts', ref.account_id);
      const result = await stateStore.list('accounts', { filter: { operator: ref.operator } });
      return result.items[0] ?? null;
    },
    mediaBuy: {
      getProducts: async () => ({ products: [], context: {} }),
      createMediaBuy: async params => ({
        media_buy_id: `mb-${Date.now()}`,
        status: 'active' as const,
        confirmed_at: new Date().toISOString(),
        revision: 1,
        packages: (params.packages ?? []).map(() => ({
          package_id: crypto.randomUUID(),
          status: 'active' as const,
        })),
        context: params.context,
      }),
    },
    capabilities: {
      features: {
        inlineCreativeManagement: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: ['create_media_buy'],
      },
      specialisms: ['signed-requests'],
    },
  });
}

// ── Serve with verifier preTransport ────────────────────────────────

interface VerifierReqShim {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  protocol: string;
  get(name: string): string | undefined;
  verifiedSigner?: unknown;
  [extra: string]: unknown;
}

serve(createAgent, {
  port: Number.parseInt(process.env.PORT ?? '3101', 10),
  preTransport: async (req, res) => {
    const reqShim: VerifierReqShim = {
      method: req.method ?? 'POST',
      url: req.url ?? '/mcp',
      originalUrl: req.url ?? '/mcp',
      headers: req.headers,
      rawBody: req.rawBody ?? '',
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
    let rejected = false;
    await new Promise<void>(resolve =>
      verifier(reqShim, resShim, err => {
        if (err) {
          // Log internally; don't leak stack traces (js/stack-trace-exposure).
          console.error('verifier middleware error:', err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'verifier_error' }));
          }
          rejected = true;
        }
        // resShim.status().set().json() already ended the response for 401s.
        if (res.writableEnded) rejected = true;
        resolve();
      })
    );
    return rejected;
  },
});
