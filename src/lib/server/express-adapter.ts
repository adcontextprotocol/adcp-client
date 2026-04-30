/**
 * Express / Connect adapter for AdCP MCP agents.
 *
 * Mounting an MCP agent inside an existing Express app — rather than using
 * {@link serve}'s standalone HTTP server — requires five specific pieces
 * of plumbing, none of which are obvious the first time you wire them:
 *
 *   1. `rawBody` capture: `express.json()` consumes the body stream before
 *      the RFC 9421 signature verifier runs; the verifier needs the exact
 *      signed bytes. The seller has to pass a custom `verify` callback to
 *      `express.json` that stashes a copy on `req.rawBody`.
 *   2. Mount-path URL reconstruction: Express strips the router mount
 *      prefix from `req.url`, so when the verifier reconstructs the
 *      canonical URL from `req.url` it sees `/mcp` instead of
 *      `/api/training-agent/mcp`. The signed base was the second; the
 *      verifier sees the first; every signature fails.
 *   3. RFC 9728 protected-resource metadata at the ORIGIN root: the
 *      OAuth graders probe `${origin}/.well-known/oauth-protected-resource${pathname}`,
 *      NOT a path inside the router. The well-known route must be mounted
 *      on `app`, not on the sub-router.
 *   4. Session reset between storyboards: conformance runners execute
 *      many storyboards in sequence against one process; cached state
 *      from storyboard N leaks into N+1.
 *   5. Presence-gated signature composition (closed by
 *      {@link requireSignatureWhenPresent} / {@link requireAuthenticatedOrSigned}).
 *
 * {@link createExpressAdapter} returns all four of the remaining pieces
 * so the seller's wiring collapses to:
 *
 * ```ts
 * import express from 'express';
 * import { createAdcpServer, createExpressAdapter } from '@adcp/sdk/server/legacy/v5';
 *
 * const agent = createAdcpServer({ ...handlers });
 * const adapter = createExpressAdapter({
 *   server: agent,
 *   mountPath: '/api/training-agent',
 *   publicUrl: 'https://agent.example.com/api/training-agent',
 *   prm: { authorizationServers: ['https://auth.example.com'] },
 * });
 *
 * const app = express();
 * app.use(express.json({ limit: '5mb', verify: adapter.rawBodyVerify }));
 * app.use(adapter.protectedResourceMiddleware);
 * app.use('/api/training-agent', myRouter);
 *
 * // In a conformance runner:
 * for (const storyboard of storyboards) {
 *   await adapter.resetHook();
 *   await run(storyboard);
 * }
 * ```
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { AdcpServer } from './adcp-server';
import type { ProtectedResourceMetadata } from './serve';
// `SeedComplianceFixturesOptions` is only a type import — zero runtime
// cost for sellers who don't use `seedFixtures`. The runtime
// `seedComplianceFixtures` is loaded lazily inside `resetHook` so
// the fixture set's JS bytes stay out of the server barrel for
// production sellers who never seed.
import type { SeedComplianceFixturesOptions } from '../compliance-fixtures';

export interface ExpressAdapterOptions {
  /**
   * Mount path the agent router is attached at (must match what you
   * pass to `app.use(mountPath, router)`). Used by {@link ExpressAdapter.getUrl}
   * to reconstruct the canonical request URL for signature verification.
   *
   * Leading slash required; no trailing slash. Example: `/api/training-agent`.
   */
  mountPath: string;
  /**
   * Canonical public URL of the MCP endpoint, origin + mount + `/mcp`.
   *
   * **Required for any deployment that pipes `getUrl` into an RFC 9421
   * signature verifier.** Without `publicUrl`, `getUrl` reconstructs
   * the URL from `x-forwarded-host`/`host` — which an attacker can set
   * to any value, letting them present a signature signed for a
   * different audience and have it verify against the wrong origin.
   * `getUrl` throws when neither `publicUrl` nor the explicit opt-in
   * `trustForwardedHost` is set, so accidental misconfiguration fails
   * closed.
   *
   * When omitted, {@link ExpressAdapter.protectedResourceMiddleware}
   * also refuses to start unless `trustForwardedHost: true` is set —
   * it can't advertise a stable `resource` URL without one of the two.
   */
  publicUrl?: string;
  /**
   * Explicit opt-in for header-derived URL reconstruction in
   * multi-host deployments where `publicUrl` can't be fixed at adapter
   * construction. Setting this acknowledges that `x-forwarded-host` /
   * `host` are trusted inputs (the upstream proxy sanitizes them).
   * Prefer `publicUrl` when possible — it's the only configuration
   * that closes the signed-payload audience-confusion attack.
   */
  trustForwardedHost?: boolean;
  /**
   * RFC 9728 Protected Resource Metadata body. Required unless you're
   * wiring the PRM response yourself; omitting this disables
   * {@link ExpressAdapter.protectedResourceMiddleware}.
   */
  prm?: ProtectedResourceMetadata;
  /**
   * When present, {@link ExpressAdapter.resetHook} dispatches to
   * `server.compliance.reset()`. Leave undefined if you've wired the
   * reset yourself (e.g., via a test-controller scenario).
   */
  server?: AdcpServer;
  /**
   * Pass `{ force: true }` to the underlying `server.compliance.reset()`
   * call. Use when your deployment wires a state store other than the
   * in-memory default but you've verified the flush is safe for this
   * environment (a disposable test DB, for example).
   */
  resetForce?: boolean;
  /**
   * When truthy, {@link ExpressAdapter.resetHook} re-seeds the AdCP
   * compliance fixtures (via `seedComplianceFixtures`) after
   * `compliance.reset()` flushes the state store. Without this, a
   * runner that resets between storyboards loses fixtures seeded
   * before storyboard #1, and every subsequent fixture lookup returns
   * `null` — surfacing as fixture-not-found 404s across the run.
   *
   * - `true` seeds the full canonical fixture set with default options.
   * - An object applies the matching `seedComplianceFixtures`
   *   configuration (category filter, overrides, collection names).
   *
   * Leave undefined when handlers don't read from the compliance
   * state-store collections, or when you seed through a different
   * path (e.g., a `comply_test_controller` scenario).
   */
  seedFixtures?: boolean | SeedComplianceFixturesOptions;
}

/** Return shape of {@link createExpressAdapter}. */
export interface ExpressAdapter {
  /**
   * Pass as `express.json({ verify })` — populates `req.rawBody` with
   * the exact bytes signed, which is what the RFC 9421 verifier needs
   * for `Content-Digest` recompute. Safe no-op when the route doesn't
   * run behind `express.json`.
   */
  rawBodyVerify: (req: IncomingMessage, res: ServerResponse, buf: Buffer) => void;

  /**
   * Mount on the top-level `app` (NOT inside your agent router) with
   * `app.use(adapter.protectedResourceMiddleware)`. Responds to
   * `/.well-known/oauth-protected-resource/*` at the origin root —
   * which is where the OAuth graders probe. Forwards everything else
   * via `next()`.
   *
   * Undefined when {@link ExpressAdapterOptions.prm} is omitted.
   */
  protectedResourceMiddleware?: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

  /**
   * Reconstruct the full request URL for an incoming request, including
   * the Express mount prefix that `req.url` strips. Pass this as the
   * `getUrl` option to {@link verifySignatureAsAuthenticator} so the
   * recomputed signature base matches what the signer signed.
   */
  getUrl: (req: IncomingMessage) => string;

  /**
   * Drop session state and the idempotency cache between storyboards.
   * Delegates to `server.compliance.reset()` when a server is
   * configured; returns a no-op otherwise.
   */
  resetHook: () => Promise<void>;
}

/**
 * Build all four Express-integration helpers an AdCP agent needs to run
 * behind a mounted router. See the module docstring for the full wiring
 * example.
 */
export function createExpressAdapter(options: ExpressAdapterOptions): ExpressAdapter {
  const mountPath = normalizeMountPath(options.mountPath);
  const trustForwardedHost = options.trustForwardedHost === true;

  let fixedOrigin: string | undefined;
  if (options.publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(options.publicUrl);
    } catch {
      throw new Error(`createExpressAdapter: \`publicUrl\` is not a valid URL: ${options.publicUrl}`);
    }
    fixedOrigin = parsed.origin;
  }

  const rawBodyVerify = (req: IncomingMessage, _res: ServerResponse, buf: Buffer): void => {
    // Attach the raw body as a string — that's what
    // `verifySignatureAsAuthenticator` expects on `req.rawBody`. The
    // verifier's Content-Digest recompute runs over these exact bytes
    // regardless of express.json's subsequent parsing, so the buffer
    // copy here is the source of truth for signature verification.
    (req as IncomingMessage & { rawBody?: string }).rawBody = buf.toString('utf8');
  };

  let protectedResourceMiddleware: ExpressAdapter['protectedResourceMiddleware'];
  if (options.prm) {
    if (!fixedOrigin && !trustForwardedHost) {
      throw new Error(
        'createExpressAdapter: `prm` requires either `publicUrl` (fixed origin) or `trustForwardedHost: true` ' +
          '(acknowledging that upstream sanitizes `x-forwarded-host`/`host`). Header-derived origin reconstruction ' +
          'without one of these lets an attacker pick the advertised OAuth resource URL.'
      );
    }
    protectedResourceMiddleware = buildProtectedResourceMiddleware(options.prm, options.publicUrl, trustForwardedHost);
  }

  const getUrl = (req: IncomingMessage): string => {
    // Express strips the mount prefix from `req.url`, but leaves the
    // pre-strip value on `req.originalUrl`. Prefer `originalUrl` when
    // it exists — that's what the signer signed. Fall back to a
    // mountPath + req.url composition for non-Express frameworks.
    const reqAny = req as IncomingMessage & { originalUrl?: string };
    const path = reqAny.originalUrl ?? joinPath(mountPath, req.url ?? '/');
    if (fixedOrigin) {
      // publicUrl wins unconditionally — ignoring `x-forwarded-host` /
      // `host` is exactly what closes the signed-payload audience-
      // confusion attack. Attacker-controlled headers can't influence
      // the origin the verifier sees.
      return `${fixedOrigin}${path}`;
    }
    if (!trustForwardedHost) {
      throw new Error(
        'createExpressAdapter.getUrl: neither `publicUrl` nor `trustForwardedHost: true` is set. ' +
          'Header-derived URL reconstruction lets an attacker pick the origin a signed payload verifies against — ' +
          'the verifier would recompute the signature base against the spoofed host and accept a signature signed for a different audience. ' +
          'Set `publicUrl` at adapter construction, or opt into `trustForwardedHost` with an upstream that sanitizes the headers.'
      );
    }
    const forwardedProto = firstHeader(req.headers['x-forwarded-proto']);
    const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
    const proto = forwardedProto ?? (encrypted ? 'https' : 'http');
    const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers['host']);
    if (!host) {
      throw new Error('createExpressAdapter.getUrl: missing Host header under `trustForwardedHost`.');
    }
    return `${proto}://${host}${path}`;
  };

  const resetHook = async (): Promise<void> => {
    if (!options.server) return;
    await options.server.compliance.reset({
      ...(options.resetForce ? { force: true } : {}),
    });
    // Re-seed AFTER the flush so subsequent storyboards find fixtures
    // at the same IDs. Without this step the first storyboard consumes
    // the seed from pre-run setup, then every storyboard after N+1
    // misses because `reset()` wiped `compliance:*` collections.
    //
    // NOT atomic: if `compliance.reset()` succeeds and
    // `seedComplianceFixtures` throws mid-loop, the state store is
    // left with a partial seed. For a conformance-runner use case
    // that's fine — the next storyboard surfaces the error loudly.
    // Lazy-loaded so sellers who never set `seedFixtures` don't
    // carry the fixture set's bytes in their server bundle.
    if (options.seedFixtures) {
      const seedOptions: SeedComplianceFixturesOptions = options.seedFixtures === true ? {} : options.seedFixtures;
      const { seedComplianceFixtures } = await import('../compliance-fixtures');
      await seedComplianceFixtures(options.server, seedOptions);
    }
  };

  return {
    rawBodyVerify,
    ...(protectedResourceMiddleware ? { protectedResourceMiddleware } : {}),
    getUrl,
    resetHook,
  };
}

function buildProtectedResourceMiddleware(
  prm: ProtectedResourceMetadata,
  publicUrl: string | undefined,
  trustForwardedHost: boolean
): (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void {
  // OAuth graders probe `/.well-known/oauth-protected-resource/<mount>`.
  // The `<mount>` suffix varies by agent, so match the well-known prefix
  // and return PRM for any suffix. Agents that host multiple MCP mounts
  // behind one origin should override this middleware — the default
  // advertises the same `resource` for every probed path, which is the
  // common single-mount case.
  const WELL_KNOWN = '/.well-known/oauth-protected-resource';
  return (req, res, next) => {
    const pathname = parsePathname(req);
    if (!pathname.startsWith(WELL_KNOWN)) {
      next();
      return;
    }
    let resource: string;
    if (publicUrl) {
      // Fixed origin — same security property as `getUrl`'s
      // publicUrl path: attacker-controlled headers can't influence
      // the advertised resource URL.
      resource = publicUrl;
    } else {
      // trustForwardedHost: true was checked at construction — if we
      // got here without publicUrl, upstream is responsible for
      // sanitizing the headers we read below.
      resource = reconstructResource(req, pathname.slice(WELL_KNOWN.length), trustForwardedHost);
    }
    const body = {
      resource,
      ...prm,
      bearer_methods_supported: prm.bearer_methods_supported ?? ['header'],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

function reconstructResource(req: IncomingMessage, suffix: string, trustForwardedHost: boolean): string {
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto']);
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const proto = forwardedProto ?? (encrypted ? 'https' : 'http');
  const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers['host']);
  if (!host) {
    // Fail closed rather than advertising a placeholder: a PRM with a
    // garbage `resource` would silently mint audience-mismatched tokens
    // across the fleet. Returning 500 surfaces the misconfiguration to
    // the operator; the OAuth grader's probe fails loud.
    throw new Error(
      'createExpressAdapter.protectedResourceMiddleware: upstream did not forward a Host header. ' +
        'Set `publicUrl` at adapter construction so the advertised OAuth resource URL is stable.'
    );
  }
  if (!trustForwardedHost && req.headers['x-forwarded-host'] !== undefined) {
    // Defense-in-depth: reaching this path at all means `publicUrl`
    // wasn't set. If an upstream forwards `x-forwarded-host` without
    // the caller opting into trust, that's a misconfiguration.
    throw new Error(
      'createExpressAdapter.protectedResourceMiddleware: x-forwarded-host present but trustForwardedHost is false.'
    );
  }
  const normalizedSuffix = suffix && !suffix.startsWith('/') ? `/${suffix}` : suffix || '/';
  return `${proto}://${host}${normalizedSuffix}`;
}

function parsePathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '', 'http://_').pathname;
  } catch {
    return req.url ?? '/';
  }
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath.startsWith('/')) {
    throw new Error(`createExpressAdapter: mountPath must start with '/'. Got: ${mountPath}`);
  }
  let end = mountPath.length;
  while (end > 1 && mountPath.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return mountPath.slice(0, end);
}

function joinPath(mount: string, rest: string): string {
  const r = rest.startsWith('/') ? rest : `/${rest}`;
  return mount === '/' ? r : `${mount}${r}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}
