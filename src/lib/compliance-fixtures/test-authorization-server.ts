/**
 * In-process test authorization server for closed-loop compliance runs.
 *
 * Pairs with {@link seedComplianceFixtures} and `runAgainstLocalAgent` to
 * let sellers grade `security_baseline`, `signed-requests`, and any other
 * storyboard that needs real OAuth 2.0 tokens without reaching an
 * external IdP.
 *
 * What it exposes:
 *   - `/.well-known/oauth-authorization-server` — RFC 8414 metadata
 *   - `/.well-known/jwks.json` — JWKS with the AS public key
 *   - `/token` — client_credentials token endpoint (always issues; this is
 *     a fixture, not a real IdP)
 *
 * What the caller gets back:
 *   - `issuer` — set on the token `iss` and in PRM `authorization_servers`
 *   - `jwksUri` — point `verifyBearer({ jwksUri })` at this
 *   - `issueToken()` — mint a JWT for any audience / scope / subject
 *   - `close()` — tear down the HTTP listener (idempotent)
 *
 * Uses RS256 by default. HS* algorithms are refused — they would fail
 * `verifyBearer`'s asymmetric-only allowlist and teach sellers the wrong
 * setup.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface TestAuthorizationServerOptions {
  /** Bind host. Defaults to `127.0.0.1`. */
  host?: string;
  /** Bind port. `0` (default) lets the kernel assign one. */
  port?: number;
  /**
   * Canonical issuer URL to advertise in metadata and on issued JWTs.
   * Defaults to `http://<host>:<port>` once the listener is bound.
   *
   * Set this when fronting the AS behind a reverse proxy or tunnel so the
   * metadata and `iss` claim match the URL clients actually see.
   */
  issuer?: string;
  /**
   * JWT signing algorithm. Defaults to `RS256`. `ES256` is accepted for
   * fixtures that must mirror an ES-keyed production IdP.
   */
  algorithm?: 'RS256' | 'ES256';
  /**
   * Pre-seed subject → default-claims pairs so `issueToken({ sub })` picks
   * up the canonical identity without the caller repeating claim bodies.
   * Storyboard runners typically seed one entry per fixture brand_domain.
   */
  subjects?: Record<string, Record<string, unknown>>;
  /** Default token lifetime in seconds. Defaults to 3600. */
  tokenLifetimeSeconds?: number;
}

export interface IssueTokenOptions {
  /**
   * Token subject. When this matches a preseeded subject the AS merges
   * the preseed's claims into the token (caller claims still win).
   */
  sub: string;
  /** RFC 8707 audience. Typically the agent's canonical publicUrl. */
  aud: string | string[];
  /** Scopes (encoded as RFC 8693 `scope`). */
  scope?: string | string[];
  /** Extra arbitrary claims merged on top of subject defaults. */
  claims?: Record<string, unknown>;
  /** Override the default token lifetime for this mint. */
  expiresInSeconds?: number;
}

export interface TestAuthorizationServer {
  /** Base URL of the running AS (origin only, no path). */
  readonly baseUrl: string;
  /** Canonical issuer URL — matches the `iss` claim on issued tokens. */
  readonly issuer: string;
  /** RFC 8414 metadata URL. */
  readonly metadataUrl: string;
  /** JWKS URL — pass this to `verifyBearer({ jwksUri })`. */
  readonly jwksUri: string;
  /** Token endpoint URL — POST client_credentials here. */
  readonly tokenEndpoint: string;
  /** Mint a JWT. Returns the compact JWS string. */
  issueToken(options: IssueTokenOptions): Promise<string>;
  /** Stop the listener. Idempotent. */
  close(): Promise<void>;
}

const TOKEN_PATH = '/token';
const JWKS_PATH = '/.well-known/jwks.json';
const METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * Start an in-process test authorization server. Safe to mount many
 * times in the same process; each call binds a fresh ephemeral port.
 */
export async function createTestAuthorizationServer(
  options: TestAuthorizationServerOptions = {}
): Promise<TestAuthorizationServer> {
  const host = options.host ?? '127.0.0.1';
  const algorithm = options.algorithm ?? 'RS256';
  const tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? 3600;
  const subjects: Record<string, Record<string, unknown>> = { ...(options.subjects ?? {}) };

  if (options.issuer && !/^https?:\/\//.test(options.issuer)) {
    throw new Error(`createTestAuthorizationServer: issuer must be http(s); got ${options.issuer}`);
  }

  const { publicKey, privateKey } = await generateKeyPair(algorithm, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = algorithm;
  publicJwk.use = 'sig';

  const state = {
    issuer: options.issuer?.replace(/\/$/, '') ?? '',
  };

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, state.issuer, publicJwk, async opts => mintToken(opts));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const bound = httpServer.address() as AddressInfo;
  const boundBase = `http://${formatHost(bound.address)}:${bound.port}`;
  if (!state.issuer) state.issuer = boundBase;

  async function mintToken(opts: IssueTokenOptions): Promise<string> {
    const preset = subjects[opts.sub] ?? {};
    const mergedClaims = { ...preset, ...(opts.claims ?? {}) };
    const scopeValue = Array.isArray(opts.scope) ? opts.scope.join(' ') : opts.scope;
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (opts.expiresInSeconds ?? tokenLifetimeSeconds);
    return new SignJWT({
      ...mergedClaims,
      ...(scopeValue ? { scope: scopeValue } : {}),
    })
      .setProtectedHeader({ alg: algorithm, kid, typ: 'JWT' })
      .setSubject(opts.sub)
      .setIssuer(state.issuer)
      .setAudience(opts.aud)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(privateKey);
  }

  return {
    baseUrl: boundBase,
    get issuer() {
      return state.issuer;
    },
    get metadataUrl() {
      return `${boundBase}${METADATA_PATH}`;
    },
    get jwksUri() {
      return `${boundBase}${JWKS_PATH}`;
    },
    get tokenEndpoint() {
      return `${boundBase}${TOKEN_PATH}`;
    },
    issueToken: mintToken,
    close: () => closeServer(httpServer),
  };
}

// ────────────────────────────────────────────────────────────
// HTTP handlers
// ────────────────────────────────────────────────────────────

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  issuer: string,
  publicJwk: JWK,
  issueToken: (opts: IssueTokenOptions) => Promise<string>
): void {
  const { pathname } = new URL(req.url || '', 'http://localhost');

  if (req.method === 'GET' && pathname === METADATA_PATH) {
    respondJson(res, 200, buildMetadata(issuer));
    return;
  }
  if (req.method === 'GET' && pathname === JWKS_PATH) {
    respondJson(res, 200, { keys: [publicJwk] });
    return;
  }
  if (req.method === 'POST' && pathname === TOKEN_PATH) {
    handleTokenEndpoint(req, res, issueToken).catch(err => {
      console.error('[adcp/test-authorization-server] token endpoint error:', err);
      if (!res.headersSent) respondJson(res, 500, { error: 'server_error' });
    });
    return;
  }

  res.statusCode = 404;
  res.end();
}

function buildMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    jwks_uri: `${issuer}${JWKS_PATH}`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    response_types_supported: ['token'],
    scopes_supported: ['adcp:read', 'adcp:write'],
  };
}

async function handleTokenEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  issueToken: (opts: IssueTokenOptions) => Promise<string>
): Promise<void> {
  const rawBody = await readBody(req);
  const form = parseFormOrJson(rawBody, req.headers['content-type']);

  const grantType = form.get('grant_type');
  if (grantType !== 'client_credentials') {
    respondJson(res, 400, {
      error: 'unsupported_grant_type',
      error_description: `Only client_credentials supported in the test AS; got ${grantType ?? '(none)'}`,
    });
    return;
  }
  const audience = form.get('resource') ?? form.get('audience');
  if (!audience) {
    respondJson(res, 400, {
      error: 'invalid_request',
      error_description: 'Missing `resource` (RFC 8707) or `audience` form parameter.',
    });
    return;
  }
  // Accept either form-posted `client_id` or HTTP Basic auth. The test AS
  // does not enforce a client registry — it issues for any caller.
  const clientId = form.get('client_id') ?? extractBasicAuthUsername(req.headers.authorization);
  const sub = clientId ?? 'test-client';
  const scope = form.get('scope') ?? undefined;

  const token = await issueToken({
    sub,
    aud: audience,
    scope,
  });
  respondJson(res, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: 3600,
    ...(scope ? { scope } : {}),
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 65_536;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('token endpoint body exceeded 64 KiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseFormOrJson(raw: string, contentType: string | string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (raw.length === 0) return out;
  const ct = Array.isArray(contentType) ? contentType[0] : contentType;
  const looksJson = ct && /json/i.test(ct);
  if (looksJson) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') out.set(k, v);
      }
      return out;
    } catch {
      return out;
    }
  }
  const params = new URLSearchParams(raw);
  for (const [k, v] of params.entries()) out.set(k, v);
  return out;
}

function extractBasicAuthUsername(auth: string | string[] | undefined): string | undefined {
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (!header || !/^basic\s+/i.test(header)) return undefined;
  const b64 = header.replace(/^basic\s+/i, '').trim();
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    return colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
  } catch {
    return undefined;
  }
}

function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections?.();
    server.close(err => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    });
  });
}
