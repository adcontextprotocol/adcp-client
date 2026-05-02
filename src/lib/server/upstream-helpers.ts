/**
 * Adapter translation helpers for AdCP seller agents.
 *
 * Every AdCP adapter needs the same two things:
 *
 * 1. Bidirectional key translation (AdCP wire values ↔ upstream platform values).
 * 2. A thin typed HTTP client for upstream platform APIs.
 *
 * These helpers replace the per-adapter boilerplate that appears in every
 * reference adapter (sales-social, signal-marketplace, creative-template,
 * sales-guaranteed) without encoding any domain-specific logic.
 */

// ---------------------------------------------------------------------------
// createTranslationMap
// ---------------------------------------------------------------------------

/**
 * A reversible bidirectional mapping between two sets of string keys.
 *
 * @example
 * ```ts
 * const channelMap = createTranslationMap({
 *   olv: 'video',
 *   ctv: 'ctv',
 *   display: 'display',
 *   streaming_audio: 'audio',
 * });
 *
 * channelMap.toUpstream('olv');     // 'video'
 * channelMap.toAdcp('video');       // 'olv'
 * channelMap.hasAdcp('olv');        // true
 * channelMap.hasUpstream('audio');  // true
 * ```
 *
 * Keys on the left side of the map argument are the AdCP wire values;
 * keys on the right are the upstream platform values.
 *
 * Both lookup methods return `undefined` for unknown keys — callers
 * should either guard with `has*()` or handle `undefined` explicitly.
 */
export interface TranslationMap<A extends string, B extends string> {
  /** Translate an AdCP wire value to the upstream platform value. */
  toUpstream(adcpKey: A): B | undefined;
  /** Translate an upstream platform value back to the AdCP wire value. */
  toAdcp(upstreamKey: B): A | undefined;
  /** True when `adcpKey` is a known AdCP-side key. */
  hasAdcp(adcpKey: string): adcpKey is A;
  /** True when `upstreamKey` is a known upstream-side key. */
  hasUpstream(upstreamKey: string): upstreamKey is B;
}

/**
 * Build a bidirectional translation map from a `{ adcpKey: upstreamKey }`
 * record. Keys on the left are AdCP wire values; values on the right are
 * upstream platform values.
 *
 * TypeScript infers literal types from the object literal, so `toUpstream`
 * and `toAdcp` return the precise union of known values rather than `string`.
 *
 * @example
 * ```ts
 * const channelMap = createTranslationMap({
 *   olv: 'video',
 *   ctv: 'ctv',
 * });
 * channelMap.toUpstream('olv'); // 'video' | undefined
 * channelMap.toAdcp('video');   // 'olv' | undefined
 * ```
 */
export function createTranslationMap<const M extends Record<string, string>>(
  adcpToUpstream: M
): TranslationMap<keyof M & string, M[keyof M & string]> {
  type A = keyof M & string;
  type B = M[keyof M & string];
  const forward = new Map<A, B>(Object.entries(adcpToUpstream) as Array<[A, B]>);
  const reverse = new Map<B, A>();
  for (const [a, b] of forward) {
    reverse.set(b, a);
  }
  return {
    toUpstream: (k: A) => forward.get(k),
    toAdcp: (k: B) => reverse.get(k),
    hasAdcp: (k: string): k is A => forward.has(k as A),
    hasUpstream: (k: string): k is B => reverse.has(k as B),
  };
}

// ---------------------------------------------------------------------------
// createUpstreamHttpClient
// ---------------------------------------------------------------------------

/**
 * Per-request context passed from the handler to the auth resolver.
 *
 * Adopters define their own shape — common fields include the AdCP
 * principal (`principal`), resolved tenant id (`operatorId`), or any
 * adapter-specific routing key. The SDK does not interpret this; it
 * simply forwards it to `dynamic_bearer.getToken` so the resolver can
 * pick the right credential per call.
 *
 * @example multi-tenant credential lookup
 * ```ts
 * upstream.get('/items', undefined, undefined, {
 *   authContext: { operatorId: ctx.account.id }
 * });
 * ```
 *
 * @example pass-through of caller-presented credential
 * ```ts
 * upstream.get('/items', undefined, undefined, {
 *   authContext: { principal: ctx.auth.principal }
 * });
 * ```
 */
export type AuthContext = Record<string, unknown>;

/**
 * Authentication configuration for the upstream HTTP client.
 *
 * - `static_bearer` — fixed Bearer token injected into every request.
 * - `dynamic_bearer` — async token factory; called per-request. Receives
 *   the optional `authContext` passed to the method call, so the same
 *   resolver can return a master key for tenant-fan-out, a
 *   per-operator key, or pass-through of the caller's principal.
 *   OAuth client-credentials refresh is handled transparently.
 * - `api_key` — fixed key injected into a named header.
 * - `none` — no authentication header injected.
 */
export type UpstreamAuth =
  | { kind: 'static_bearer'; token: string }
  | { kind: 'dynamic_bearer'; getToken: (ctx?: AuthContext) => Promise<string> }
  | { kind: 'api_key'; header: string; key: string }
  | { kind: 'none' };

export interface UpstreamHttpClientOptions {
  /** Base URL of the upstream API (no trailing slash). */
  baseUrl: string;
  /**
   * Authentication strategy for outgoing requests.
   * Pass `{ kind: 'none' }` for unauthenticated internal services.
   */
  auth: UpstreamAuth;
  /**
   * Additional headers to include on every request (e.g. tenant ID,
   * API version, content-type overrides). Per-request headers passed
   * to individual method calls are merged on top and take precedence.
   */
  defaultHeaders?: Record<string, string>;
}

/** Result shape returned by every method on the upstream HTTP client. */
export interface UpstreamHttpResult<T> {
  /** HTTP status code returned by the upstream. */
  status: number;
  /**
   * Parsed response body, or `null` when the upstream returned a 404
   * or an empty body. Non-2xx responses throw — use the `status` field
   * only for within-2xx distinction (e.g. 201 Created vs 200 OK).
   */
  body: T | null;
}

/** Per-call options that don't fit naturally into positional method args. */
export interface UpstreamCallOptions {
  /**
   * Forwarded to `dynamic_bearer.getToken(ctx)` so handlers can pick
   * the right credential per call. Ignored by other auth kinds.
   */
  authContext?: AuthContext;
}

export interface UpstreamHttpClient {
  get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    headers?: Record<string, string>,
    options?: UpstreamCallOptions
  ): Promise<UpstreamHttpResult<T>>;
  post<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
    options?: UpstreamCallOptions
  ): Promise<UpstreamHttpResult<T>>;
  put<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
    options?: UpstreamCallOptions
  ): Promise<UpstreamHttpResult<T>>;
  delete<T>(
    path: string,
    headers?: Record<string, string>,
    options?: UpstreamCallOptions
  ): Promise<UpstreamHttpResult<T>>;
}

async function resolveAuthHeader(auth: UpstreamAuth, ctx?: AuthContext): Promise<Record<string, string>> {
  switch (auth.kind) {
    case 'static_bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'dynamic_bearer': {
      const token = await auth.getToken(ctx);
      return { Authorization: `Bearer ${token}` };
    }
    case 'api_key':
      return { [auth.header]: auth.key };
    case 'none':
      return {};
  }
}

async function doRequest<T>(
  baseUrl: string,
  auth: UpstreamAuth,
  defaultHeaders: Record<string, string>,
  method: string,
  path: string,
  options: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
    authContext?: AuthContext;
  }
): Promise<UpstreamHttpResult<T>> {
  const authHeader = await resolveAuthHeader(auth, options.authContext);
  const mergedHeaders: Record<string, string> = {
    ...defaultHeaders,
    ...authHeader,
    ...options.headers,
  };

  let url = `${baseUrl}${path}`;
  if (options.params) {
    const qs = Object.entries(options.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url = `${url}?${qs}`;
  }

  const init: RequestInit = { method, headers: mergedHeaders };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    mergedHeaders['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, init);

  // 404 → null body (not an error — resource absent is a common upstream signal)
  if (res.status === 404) return { status: 404, body: null };

  const text = await res.text();

  // Non-2xx always throws — callers must not silently swallow errors
  if (!res.ok) {
    throw new Error(`Upstream ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  // Empty body (204 No Content, etc.)
  if (!text) return { status: res.status, body: null };

  const body = JSON.parse(text) as T;
  return { status: res.status, body };
}

/**
 * Create a thin typed HTTP client for upstream platform APIs.
 *
 * Handles auth injection, query-string serialization, and 404→null
 * translation so adapters can focus on domain logic.
 *
 * @example
 * ```ts
 * const upstream = createUpstreamHttpClient({
 *   baseUrl: process.env.UPSTREAM_URL!,
 *   auth: { kind: 'static_bearer', token: process.env.UPSTREAM_TOKEN! },
 *   defaultHeaders: { 'X-Tenant-Id': tenantId },
 * });
 *
 * const { body } = await upstream.get<Cohort[]>('/v2/cohorts');
 * const cohorts = body ?? [];
 * ```
 */
export function createUpstreamHttpClient(options: UpstreamHttpClientOptions): UpstreamHttpClient {
  const { baseUrl, auth, defaultHeaders = {} } = options;
  return {
    get: (path, params, headers, opts) =>
      doRequest(baseUrl, auth, defaultHeaders, 'GET', path, { params, headers, authContext: opts?.authContext }),
    post: (path, body, headers, opts) =>
      doRequest(baseUrl, auth, defaultHeaders, 'POST', path, { body, headers, authContext: opts?.authContext }),
    put: (path, body, headers, opts) =>
      doRequest(baseUrl, auth, defaultHeaders, 'PUT', path, { body, headers, authContext: opts?.authContext }),
    delete: (path, headers, opts) =>
      doRequest(baseUrl, auth, defaultHeaders, 'DELETE', path, { headers, authContext: opts?.authContext }),
  };
}
