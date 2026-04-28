# Seller deployment patterns

Companion to [`SKILL.md`](./SKILL.md). Read this only when you need deployment shapes beyond single-host HTTP on a single port.

## Multi-Host, Express, and Alternative Transports

`serve()` supports two shapes of deployment out of the box: single-host (the quickstart default) and multi-host (one process fronting many hostnames). Three cases need a different entry point:

- **Mounting under an existing Express app** (especially alongside OAuth 2.1 Authorization Server routes like `mcpAuthRouter({ provider })`) — use `createExpressAdapter`.
- **Stdio transport** — for CLI / desktop / local-subprocess agents.
- **Hand-rolled HTTP** — when even `createExpressAdapter` doesn't fit; `createAdcpServer().connect(transport)` is the raw escape hatch.

### Multi-host HTTP

Pass functions for `publicUrl` and `protectedResource`, branch on `ctx.host` in the factory, and turn on `trustForwardedHost` when a proxy terminates TLS:

```typescript
import { serve, createAdcpServer, UnknownHostError, hostname } from '@adcp/sdk';
import { verifyBearer } from '@adcp/sdk/server';

// Host → adapter config. Whatever shape suits your deployment (DB, env, static).
// Cache the CONFIG (not the AdcpServer). serve() still instantiates the
// server per request today, but a config Map keeps the expensive part
// (handler bundle, idempotency store, DB pool) at module scope.
const adapters = new Map<string, { name: string; handlers: MediaBuyHandlers }>([
  ['snap.agentic-adapters.scope3.com', { name: 'Snap seller', handlers: snapHandlers }],
  ['meta.agentic-adapters.scope3.com', { name: 'Meta seller', handlers: metaHandlers }],
  // ... one entry per hostname you front
]);

serve(
  ctx => {
    // Fail closed on missing Host header. HTTP/1.1 requires it, but a
    // misbehaving client can omit it — ctx.host is `''` in that case,
    // and a blank-host adapter lookup would mint audience-mismatched
    // tokens if we proceeded.
    if (!ctx.host) throw new UnknownHostError('Host header required');
    const cfg = adapters.get(ctx.host);
    // UnknownHostError → 404 (generic body, routing table stays off the wire).
    // Any other thrown error still surfaces as 500.
    if (!cfg) throw new UnknownHostError(`No adapter configured for ${ctx.host}`);
    return createAdcpServer({
      name: cfg.name,
      version: '1.0.0',
      resolveAccount: async (ref, { authInfo }) => lookupAccount(ctx.host, ref, authInfo),
      mediaBuy: cfg.handlers,
    });
  },
  {
    trustForwardedHost: true, // behind Fly/Cloud Run/ALB that sets X-Forwarded-Host
    // hostname() strips the port — test/local runs include `:3001`, production
    // doesn't. Works for IPv6 too.
    publicUrl: host => `https://${hostname(host)}/mcp`,
    protectedResource: host => ({
      authorization_servers: [`https://${hostname(host)}/oauth`],
      scopes_supported: ['read', 'write'],
    }),
    authenticate: verifyBearer({
      jwksUri: process.env.JWKS_URI,
      issuer: process.env.ISSUER,
      // Derive the JWT audience from the SAME publicUrl serve() advertises
      // for this host. Never read X-Forwarded-Host here directly — ctx.host
      // already respects trustForwardedHost, but publicUrl is better because
      // the audience check and the PRM `resource` URL can't drift.
      audience: (_req, { publicUrl }) => publicUrl!,
    }),
  }
);
```

Each unique host runs its resolver once and the result is cached. Every host advertises its own RFC 9728 `resource` URL, the 401 challenge carries the host's `resource_metadata` URL, and the factory sees the resolved host so it can return host-specific handlers. Auth, RFC 9421 signature verification, idempotency, and governance composition all stay inside `serve()` — nothing extra to re-own.

**Audience binding: use the ctx-form callback.** `audience: (req, { publicUrl }) => publicUrl` is the safest shape — the JWT audience check is guaranteed to match what RFC 9728 PRM advertises for this host, and `publicUrl` already follows `serve()`'s host resolution. `audience: (req) => ...` also works but you own the security: don't read `X-Forwarded-Host` there directly (it bypasses `trustForwardedHost`), and don't string-concat the mount path (it breaks silently if the mount path changes).

**`trustForwardedHost: true` requires an overwriting proxy.** The framework trusts the first entry in an `X-Forwarded-Host` chain — safe when your proxy rewrites the header on ingress, UNSAFE when it appends (the attacker gets to pick the first entry). Fly, Cloud Run, and GCP HTTPS LBs overwrite. AWS ALB default and nginx default append — these need `proxy_set_header X-Forwarded-Host $host;` or equivalent before you enable the flag. Verify against a request that already has `X-Forwarded-Host: attacker.example` in it. RFC 7239 `Forwarded: host=...` is read the same way (same trust requirement).

**Unknown hosts: throw `UnknownHostError` from the factory.** `serve()` catches it and responds 404 with a generic body (the routing table never crosses the wire). Throwing any other `Error` stays as a 500 so unrelated bugs remain loud.

**Factory runs per request.** `serve()` calls the factory on every incoming request (to avoid cross-request state bleed). By default it closes the returned server at the end of each request — so caching the `AdcpServer` from one call to the next is unsafe without opt-in. Keep the default-path factory cheap: look up a pre-built adapter config from a module-scoped `Map`, and let `createAdcpServer(...)` build a fresh wrapper from that config on every call.

**Pass `reuseAgent: true` to cache `AdcpServer` instances per host.** When the tool-registration cost inside `createAdcpServer(...)` is a measurable part of request latency (common in multi-host deployments with many tools per host), flip the flag and cache the returned server in the factory:

```typescript
const agents = new Map<string, AdcpServer>();
serve(
  ctx => {
    let agent = agents.get(ctx.host);
    if (!agent) {
      const cfg = adapters.get(ctx.host);
      if (!cfg) throw new UnknownHostError(`No adapter for ${ctx.host}`);
      agent = createAdcpServer({
        name: cfg.name,
        version: '1.0.0',
        resolveAccount: cfg.resolveAccount,
        mediaBuy: cfg.handlers,
      });
      agents.set(ctx.host, agent);
    }
    return agent;
  },
  { reuseAgent: true /* ...other options... */ }
);

// Cleanup on shutdown — reuseAgent mode doesn't auto-close.
process.on('SIGTERM', async () => {
  await Promise.all([...agents.values()].map(a => a.close()));
  process.exit(0);
});
```

The framework wraps the `connect → handleRequest → close-transport` cycle in a per-instance async mutex. Concurrent requests on the SAME cached server serialize (MCP's `Protocol.connect()` throws when a transport is already attached, so serialization is mandatory for safety); concurrent requests on DIFFERENT cached servers run in parallel. Trade-off: throughput per unique host drops to 1 in flight at a time. If a single host regularly serves concurrent requests where handler latency dominates, cache a small pool of servers per host and round-robin from the factory — the mutex is per-instance, so pool members don't serialize with each other.

### Express + OAuth Authorization Server in one process

When your agent is _both_ an OAuth 2.1 AS (issues tokens) and a protected resource (MCP endpoint), mount both on a single `express()` app using `createExpressAdapter`. This is the supported composition path — you re-own nothing vs. running `serve()`.

```typescript
import express from 'express';
import { createAdcpServer, createExpressAdapter, verifyBearer, anyOf, verifyApiKey } from '@adcp/sdk/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

const agent = createAdcpServer({
  name: 'Snap seller',
  version: '1.0.0',
  resolveAccount: async (ref, { authInfo }) => lookupAccount(ref, authInfo),
  mediaBuy: {
    /* ... */
  },
});

const adapter = createExpressAdapter({
  mountPath: '/api/snap',
  publicUrl: 'https://seller.example.com/api/snap/mcp',
  prm: { authorization_servers: ['https://seller.example.com/oauth'] },
  server: agent,
});

const app = express();

// Raw-body capture so RFC 9421 signature verification hashes the bytes
// the client signed — express.json() would consume the stream first.
app.use(express.json({ limit: '5mb', verify: adapter.rawBodyVerify }));

// RFC 9728 PRM lives at the origin root (where OAuth graders probe),
// NOT inside the agent router.
app.use(adapter.protectedResourceMiddleware);

// OAuth 2.1 Authorization Server routes alongside the MCP endpoint.
app.use(
  '/oauth',
  mcpAuthRouter({
    provider: myOAuthProvider,
    issuerUrl: new URL('https://seller.example.com/oauth'),
  })
);

// MCP endpoint — per-request transport, agent is reused.
const authenticate = verifyBearer({
  jwksUri: 'https://seller.example.com/oauth/.well-known/jwks.json',
  issuer: 'https://seller.example.com/oauth',
  audience: 'https://seller.example.com/api/snap/mcp',
});

app.post('/api/snap/mcp', async (req, res) => {
  const principal = await authenticate(req);
  if (!principal) {
    res.status(401).end();
    return;
  }
  (req as any).auth = { token: principal.token, clientId: principal.principal, scopes: principal.scopes };
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await agent.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    transport.close();
  }
});

app.listen(3001);
```

`createExpressAdapter` gives you four pieces `serve()` would otherwise handle: `rawBodyVerify` (for signed requests), `protectedResourceMiddleware` (RFC 9728 at origin root, not inside the router), `getUrl` (reconstructs the canonical URL with Express's stripped mount prefix — pass to `verifySignatureAsAuthenticator`), and `resetHook` (compliance state reset between storyboards).

### Multi-host Express with per-host OAuth AS

The shape when one Node process fronts N hostnames AND each hostname is also its own OAuth 2.1 Authorization Server — the common pattern for white-label sellers, multi-platform adapter fleets (one process → Snap, Meta, TikTok, …), retail media networks with per-brand issuers, etc. `serve()`'s multi-host mode doesn't cover this because it has no composition surface for AS routes ([#887](https://github.com/adcontextprotocol/adcp-client/issues/887)); `createExpressAdapter` does, and the pieces compose as follows.

```typescript
import express from 'express';
import {
  createAdcpServer,
  createExpressAdapter,
  verifyBearer,
  resolveHost,
  hostname,
  UnknownHostError,
} from '@adcp/sdk/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

// One entry per hostname you front. Each carries the per-host
// configuration AND the per-host OAuth provider — the provider is
// what `mcpAuthRouter` invokes for authorize/token/introspect.
const adapters = new Map<string, AdapterConfig>([
  ['snap.agentic-adapters.example.com', snapConfig],
  ['meta.agentic-adapters.example.com', metaConfig],
  // ... 13 total in the deployment this recipe was designed around
]);

const app = express();

// Per-host Express Router, built once at module load and cached.
// The Router carries: express.json (with rawBody capture), the OAuth
// AS routes, and the MCP endpoint.
const routersByHost = new Map<string, express.Router>();
for (const [host, cfg] of adapters) {
  const agent = createAdcpServer({
    name: cfg.name,
    version: '1.0.0',
    resolveAccount: async (ref, { authInfo }) => cfg.lookupAccount(ref, authInfo),
    mediaBuy: cfg.handlers,
  });

  const adapter = createExpressAdapter({
    mountPath: `/api/${cfg.slug}`,
    publicUrl: `https://${host}/api/${cfg.slug}/mcp`,
    prm: { authorization_servers: [`https://${host}/oauth`] },
    server: agent,
  });

  const router = express.Router();

  // Raw-body capture: express.json() drains the stream, but RFC 9421
  // signature verification needs the exact bytes that were signed.
  router.use(express.json({ limit: '5mb', verify: adapter.rawBodyVerify }));

  // OAuth 2.1 AS routes — authorize, token, register, introspect, etc.
  // `cfg.createOAuthProvider()` returns an OAuthServerProvider
  // specific to this platform (Snap's, Meta's, …). See the two
  // provider sketches below for the common shapes.
  router.use(
    '/oauth',
    mcpAuthRouter({
      provider: cfg.createOAuthProvider(),
      issuerUrl: new URL(`https://${host}/oauth`),
    })
  );

  // MCP endpoint. verifyBearer's audience is tied to THIS host's
  // publicUrl so a token minted for snap.example.com can't be replayed
  // at meta.example.com.
  const authenticate = verifyBearer({
    jwksUri: `https://${host}/oauth/.well-known/jwks.json`,
    issuer: `https://${host}/oauth`,
    audience: `https://${host}/api/${cfg.slug}/mcp`,
  });

  router.post(`/api/${cfg.slug}/mcp`, async (req, res) => {
    const principal = await authenticate(req);
    if (!principal) {
      res.status(401).end();
      return;
    }
    (req as any).auth = {
      token: principal.token,
      clientId: principal.principal,
      scopes: principal.scopes,
    };
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await agent.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      transport.close();
    }
  });

  routersByHost.set(host, router);
}

// PRM lives at the origin root, BEFORE the host-dispatch middleware —
// the OAuth grader probes `/.well-known/oauth-protected-resource/<mount>`
// at the top-level app. Each adapter's `protectedResourceMiddleware`
// handles its own probe path; the fall-through ordering matters.
for (const cfg of adapters.values()) {
  const adapter = createExpressAdapter({
    mountPath: `/api/${cfg.slug}`,
    publicUrl: `https://${cfg.host}/api/${cfg.slug}/mcp`,
    prm: { authorization_servers: [`https://${cfg.host}/oauth`] },
  });
  app.use(adapter.protectedResourceMiddleware);
}

// Host dispatch — resolveHost mirrors serve()'s X-Forwarded-Host /
// Forwarded / append-vs-replace semantics, so this middleware closes
// the same attacker-header-flip hole serve() does.
app.use((req, res, next) => {
  const host = resolveHost(req, { trustForwardedHost: true });
  if (!host) {
    res.status(400).end();
    return;
  }
  const router = routersByHost.get(host);
  if (!router) {
    // UnknownHostError shape — keep the routing table off the wire.
    res.status(404).end();
    return;
  }
  router(req, res, next);
});

app.listen(3001);
```

#### OAuth provider shape 1: mint your own JWTs

The straightforward case. You own the IdP, issue JWTs with `aud` bound to `publicUrl`, and `verifyBearer` validates them against your JWKS.

```typescript
// cfg.createOAuthProvider() returns an OAuthServerProvider that:
//  - authorize(): runs your login + consent flow, redirects with a code
//  - exchangeAuthorizationCode(): verifies PKCE, mints a JWT with
//    `iss = https://<host>/oauth`, `aud = https://<host>/api/<slug>/mcp`,
//    `sub = <account_id>`, `scope = <granted scopes>`
//  - revokeToken(), introspect(): as needed
// JWKS is published under the same host so verifyBearer's remote fetch
// can discover the signing key.
```

#### OAuth provider shape 2: pass-through upstream platform tokens

Used when the adapter is a thin proxy over an external IdP (Snap OAuth, Meta OAuth, etc.) and the Bearer clients present IS the upstream platform's access token. Your AS is an orchestrator, not an issuer — the `OAuthServerProvider` persists the upstream access/refresh token keyed by your auth code, and `exchangeAuthorizationCode()` returns the stored upstream token rather than a freshly-minted JWT.

Bearer verification is NOT `verifyBearer({...})` — the token isn't your JWT. Use `verifyIntrospection` (RFC 7662) when the upstream exposes an introspection endpoint:

```typescript
import { verifyIntrospection } from '@adcp/sdk/server';

const authenticate = verifyIntrospection({
  introspectionUrl: 'https://accounts.snapchat.com/oauth2/introspect',
  // Introspection endpoints are ALWAYS client-authenticated (RFC 7662 §2.1);
  // provision an introspection-capable client with the upstream IdP.
  clientId: process.env.SNAP_INTROSPECTION_CLIENT_ID!,
  clientSecret: process.env.SNAP_INTROSPECTION_CLIENT_SECRET!,
  // Scopes to require on the upstream token. The introspection response's
  // `scope` string must contain ALL of these.
  requiredScopes: ['snapchat-marketing-api'],
  // Cache positive responses to amortize the network round-trip across
  // closely-spaced requests from the same buyer. TTL is capped at the
  // token's own `exp` claim — the cache can't extend a token past its
  // upstream-issued lifetime. Negative responses are NOT cached by
  // default (a revoked token must be able to fail the next request);
  // set `negativeTtlSeconds` if you accept the revocation-latency
  // trade-off for DoS-amplification protection.
  cache: { ttlSeconds: 60, max: 10_000 },
  // Fail-closed timeout. Default 2000ms — a slow upstream can't bypass auth.
  timeoutMs: 2000,
});

router.post(`/api/${cfg.slug}/mcp`, async (req, res) => {
  const principal = await authenticate(req);
  if (!principal) {
    res.status(401).end();
    return;
  }
  // ... rest as in shape 1
});
```

When the upstream platform publishes a JWKS and signs access tokens as JWTs (Google, Auth0-backed IdPs, etc.), `verifyBearer({ jwksUri, issuer, audience })` against the upstream's endpoints avoids the per-request introspection round trip — stronger cryptographic verification and no upstream rate-limit exposure. Pick introspection only when the upstream uses opaque tokens.

Both provider shapes compose with the multi-host Express scaffold above — swap the provider and the authenticator, the rest stays.

#### Why this scaffold, not `serve()`

`serve()`'s multi-host mode handles the PR side cleanly but has no hook for AS routes. Going to `createExpressAdapter` gives you:

- `rawBodyVerify` for signed-request verification (you'd otherwise have to re-implement express.json body-capture integration)
- `protectedResourceMiddleware` at the origin root (OAuth graders probe here; mounting inside the router makes them 404)
- `getUrl` for signature verifier audience reconstruction (Express strips the mount prefix from `req.url`)
- `resetHook` for conformance-runner storyboard resets

You own: the `mcpAuthRouter` wiring (provider-specific), the per-request `transport.connect()` + `handleRequest()` dance, the host-dispatch middleware. `resolveHost` + `hostname` + `UnknownHostError` from `@adcp/sdk/server` give you the same security posture as `serve()`'s internal resolution — export and reuse rather than re-deriving.

### Stdio

```typescript
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAdcpServer } from '@adcp/sdk/server';

const server = createAdcpServer({
  name: 'Local Seller',
  version: '1.0.0',
  resolveAccount: async ref => lookupAccount(ref),
  mediaBuy: {
    /* ... */
  },
});

await server.connect(new StdioServerTransport());
```

Stdio agents skip the entire HTTP stack — no `authenticate`, no `publicUrl`, no OAuth discovery. The host process (a CLI or local buyer agent) establishes trust by launching the subprocess, so `authenticate` on `serve()` doesn't apply. Your handlers still run the same way; `ctx.authInfo` is simply undefined.

<a name="protecting-your-agent"></a>
