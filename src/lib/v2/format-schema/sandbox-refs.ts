/**
 * `$ref` sandboxing + DoS bounds for `format_schema` JSON Schema bodies.
 *
 * Implements the spec's normative rules from
 * `product-format-declaration.json#format_schema`:
 *
 *   - **Sandboxing**: fetched schemas MAY use `$ref`. Refs MUST resolve
 *     only to one of three forms:
 *       (a) same-origin as the parent `format_schema.uri` after
 *           RFC 3986 §6 normalization (lowercase scheme + host, strip
 *           default port, normalize path dot-segments, no userinfo),
 *       (b) under the AAO mirror namespace
 *           (`https://mirror.adcontextprotocol.org/...`),
 *       (c) intra-document JSON Pointer refs (`#/...`) bounded to the
 *           parent document's parsed tree.
 *     `$ref: "file://..."` rejected unconditionally. Cross-origin refs
 *     to arbitrary URIs rejected.
 *
 *   - **Bounds**: transitive `$ref` chains MUST be bounded at
 *     depth ≤ 8 AND `$ref` count ≤ 256 across the resolved tree.
 *     Defaults match the spec ceiling; callers may tighten via options.
 *
 * The sandboxer takes an already-fetched + digest-verified parent
 * schema (from `fetchFormatSchema`) and inlines every reachable `$ref`.
 * External refs go through the same {@link fetchFormatSchema} pipeline
 * — HTTPS-only, SSRF-guarded, 1 MiB body cap, 5 s timeout. The parent
 * digest is the trust anchor; same-origin / mirror refs inherit trust.
 *
 * Out of scope (deferred to the manifest-validation layer):
 *   - Schema-compile DoS bounds (re2 pattern engine, allOf expansion,
 *     per-manifest validation budget ≤ 250 ms) — applied at the Ajv
 *     compile step. The constants {@link DEFAULT_MAX_KEYWORDS} and
 *     {@link DEFAULT_VALIDATION_BUDGET_MS} are exported here so the
 *     Ajv wiring can pick them up.
 */

import { ssrfSafeFetch, SsrfRefusedError } from '../../net/ssrf-fetch';
import { isInternalProbesAllowed } from '../../utils/probe-policy';

/**
 * Error codes from {@link resolveSchemaRefs}. Mirror the spec's
 * normative failure modes so SDK callers can surface them on the
 * response `errors[]` array.
 */
export type SchemaRefSandboxErrorCode =
  /** `$ref` value isn't a string or fails basic URL parsing. */
  | 'invalid_ref'
  /** `$ref: "file://..."` is unconditionally rejected. */
  | 'file_scheme_rejected'
  /** Cross-origin `$ref` to a URI not in the same-origin / mirror allowlist. */
  | 'cross_origin_rejected'
  /** Intra-doc `#/...` pointer doesn't resolve. */
  | 'pointer_unresolved'
  /** Transitive depth exceeded the per-call limit. */
  | 'depth_exceeded'
  /** Total `$ref` count exceeded the per-call limit. */
  | 'count_exceeded'
  /** Downstream `fetchFormatSchema` rejected — message carries the wrapped error code. */
  | 'fetch_failed';

export class SchemaRefSandboxError extends Error {
  readonly code: SchemaRefSandboxErrorCode;
  readonly ref?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SchemaRefSandboxErrorCode,
    message: string,
    meta: { ref?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'SchemaRefSandboxError';
    this.code = code;
    this.ref = meta.ref;
    this.details = meta.details;
  }
}

export interface ResolveSchemaRefsOptions {
  /**
   * Max transitive `$ref` depth before failing. Default 8 (spec ceiling).
   */
  maxDepth?: number;
  /**
   * Max total `$ref` occurrences across the resolved tree before failing.
   * Default 256 (spec ceiling).
   */
  maxRefCount?: number;
  /**
   * Single AAO mirror host that `$ref` targets are allowed to live under.
   * Convenience for `mirrorHosts: [host]`; ignored when `mirrorHosts`
   * is also set.
   * @deprecated Use {@link mirrorHosts} (array form) for transitional
   * dual-host support — see {@link DEFAULT_MIRROR_HOSTS}.
   */
  mirrorHost?: string;
  /**
   * AAO mirror hosts that `$ref` targets are allowed to live under.
   * Defaults to {@link DEFAULT_MIRROR_HOSTS} (both `mirror.adcontextprotocol.org`
   * and `creative.adcontextprotocol.org` during the spec's transitional
   * period). Override when running against a stand-in mirror in tests.
   */
  mirrorHosts?: readonly string[];
  /**
   * Per-fetch timeout (ms) for each external `$ref`. Default 5 s
   * — same as the parent format_schema fetch.
   */
  timeoutMs?: number;
  /**
   * Hard cap on response body bytes per `$ref` fetch. Default 1 MiB.
   */
  maxBodyBytes?: number;
  /**
   * Optional custom fetcher for external `$ref` URIs. Defaults to a
   * built-in that uses `ssrfSafeFetch` with HTTPS-only + 1 MiB cap +
   * 5 s timeout. Callers can swap this for a digest-enforcing variant
   * when they have an out-of-band trust signal (e.g., a registry of
   * `uri@digest` pairs).
   */
  fetchExternal?: (uri: string) => Promise<Record<string, unknown>>;
}

export interface ResolveSchemaRefsResult {
  /**
   * The parent schema with every `$ref` recursively inlined. The
   * structure mirrors the input; nodes that originally held `$ref` now
   * hold the referenced sub-schema.
   */
  schema: Record<string, unknown>;
  /** Number of `$ref` occurrences resolved while walking the tree. */
  refCount: number;
  /** Max transitive depth observed during the walk. */
  maxDepthSeen: number;
}

/** Spec ceiling for `$ref` depth (transitive). */
export const DEFAULT_MAX_REF_DEPTH = 8;
/** Spec ceiling for total `$ref` count across the resolved tree. */
export const DEFAULT_MAX_REF_COUNT = 256;
/**
 * Spec-normative AAO mirror trust anchor for `$ref` resolution
 * (`product-format-declaration.json#format_schema`, post-beta.2). The
 * legacy `mirror.adcontextprotocol.org` host was deprecated in
 * adcontextprotocol/adcp#4866 (3.1.0-beta.2) — it was never
 * provisioned and authorizing a ghost hostname is liability with no
 * upside. `creative.adcontextprotocol.org` is the single trust anchor
 * going forward.
 */
export const DEFAULT_MIRROR_HOSTS: readonly string[] = ['creative.adcontextprotocol.org'];

/**
 * Single-host alias kept for backward compatibility with the 7.10
 * shipping API. Resolves to the first host in {@link DEFAULT_MIRROR_HOSTS}.
 * @deprecated Use {@link DEFAULT_MIRROR_HOSTS} (array) instead.
 */
export const DEFAULT_MIRROR_HOST = DEFAULT_MIRROR_HOSTS[0]!;

/**
 * Sibling keys that may appear alongside `$ref` and merge over the
 * resolved body. Per JSON Schema 2020-12, `$ref` siblings are an
 * *additional* constraint (conjunction with the referenced subschema),
 * NOT an override. Allowing constraint keywords (`type`, `required`,
 * `additionalProperties`, etc.) to override the referent silently
 * defangs the referenced subschema's guarantees — a malicious or
 * sloppy author can flip `additionalProperties: false` to `true` and
 * smuggle unvalidated fields through manifest validation.
 *
 * This allowlist permits annotation-only siblings (description, title,
 * comments, examples, defaults, deprecation flags) — fields that don't
 * affect what validates. Constraint keywords on `$ref` are rejected as
 * `invalid_ref` so authors are forced to inline the constraint.
 */
const ALLOWED_REF_SIBLINGS = new Set<string>([
  '$comment',
  '$schema',
  'default',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

/**
 * JSON Pointer segments that are NEVER allowed on `$ref: "#/..."`
 * targets. `__proto__` / `constructor` / `prototype` are the standard
 * prototype-pollution sinks; we reject them up front so a malicious
 * (or accidentally-crafted) intra-doc pointer can't drag the prototype
 * chain into the resolved schema and have downstream Ajv merges land
 * on `Object.prototype`.
 */
const FORBIDDEN_POINTER_SEGMENTS = new Set<string>(['__proto__', 'constructor', 'prototype']);

/**
 * Spec-recommended bound on Ajv-compiled keyword count. Applied by the
 * manifest validator, not by the sandboxer — exported here so the Ajv
 * wiring has a single source of truth.
 */
export const DEFAULT_MAX_KEYWORDS = 10_000;

/**
 * Spec-recommended per-manifest validation budget in milliseconds.
 * Exceeded budget → treat manifest as invalid + surface telemetry signal.
 */
export const DEFAULT_VALIDATION_BUDGET_MS = 250;

interface NormalizedOrigin {
  /** Lowercase scheme + `://` + lowercase host + (port if non-default). */
  origin: string;
  /** Hostname only, lowercased. */
  hostname: string;
}

/**
 * RFC 3986 §6 normalization of a URI's origin: lowercase scheme + host,
 * strip default port, no userinfo. Returns `null` for unparseable URIs.
 */
function normalizeOrigin(uri: string): NormalizedOrigin | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const defaultPorts: Record<string, string> = { 'http:': '80', 'https:': '443' };
  const port = parsed.port && parsed.port !== defaultPorts[scheme] ? `:${parsed.port}` : '';
  return {
    origin: `${scheme}//${hostname}${port}`,
    hostname,
  };
}

/**
 * Resolve a JSON Pointer (`#/foo/bar`) against the parent document's
 * parsed tree. Returns the referenced subtree, or `null` when the
 * pointer doesn't resolve.
 */
function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown | null {
  // RFC 6901: empty pointer (`#` alone) returns the root document.
  if (pointer === '') return root;
  // Drop the leading slash; split; decode per RFC 6901 (~1 → /, ~0 → ~).
  const segments = pointer
    .replace(/^\//, '')
    .split('/')
    .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = root;
  for (const seg of segments) {
    // Reject prototype-pollution segments up front. `JSON.parse`-produced
    // objects can carry an OWN `__proto__` property (V8 quirk), so
    // `hasOwnProperty` alone doesn't block the attack path — we also
    // need to refuse the segment name unconditionally.
    if (FORBIDDEN_POINTER_SEGMENTS.has(seg)) return null;
    if (cursor === null || typeof cursor !== 'object') return null;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return null;
      cursor = cursor[idx];
    } else {
      const obj = cursor as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) return null;
      cursor = obj[seg];
    }
  }
  return cursor;
}

interface ResolveContext {
  parentRoot: Record<string, unknown>;
  parentOrigin: NormalizedOrigin;
  /** Lowercased AAO mirror hosts that are accepted as `$ref` targets. */
  mirrorHosts: ReadonlySet<string>;
  maxDepth: number;
  maxRefCount: number;
  fetchExternal: (uri: string) => Promise<Record<string, unknown>>;
  /** Per-resolved-URI cache so cycles + repeats don't fan out repeatedly. */
  externalCache: Map<string, Record<string, unknown>>;
  /** Running count of `$ref` occurrences across the whole walk. */
  count: { value: number };
  /** Running max-depth observed (for telemetry). */
  maxDepthSeen: { value: number };
}

/**
 * Default external-`$ref` fetcher. Uses `ssrfSafeFetch` for HTTPS-only +
 * SSRF guards + body cap + timeout. No per-`$ref` digest verification —
 * the parent format_schema's digest is the trust anchor; same-origin
 * and mirror `$ref` targets inherit trust by extension. Callers wanting
 * per-`$ref` digests pass a custom `fetchExternal` (e.g., a registry
 * lookup that hard-fails on missing digests).
 */
function makeDefaultFetcher(
  timeoutMs: number,
  maxBodyBytes: number
): (uri: string) => Promise<Record<string, unknown>> {
  const allowHttp = isInternalProbesAllowed();
  return async (uri: string) => {
    let res;
    try {
      res = await ssrfSafeFetch(uri, {
        method: 'GET',
        timeoutMs,
        maxBodyBytes,
        headers: { accept: 'application/schema+json, application/json' },
        allowPrivateIp: allowHttp,
      });
    } catch (err) {
      if (err instanceof SsrfRefusedError) {
        throw new SchemaRefSandboxError('fetch_failed', `\`$ref: ${uri}\` — SSRF guard refused: ${err.message}`, {
          ref: uri,
          details: { ssrfCode: err.code },
        });
      }
      throw new SchemaRefSandboxError(
        'fetch_failed',
        `\`$ref: ${uri}\` — ${err instanceof Error ? err.message : String(err)}`,
        { ref: uri }
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new SchemaRefSandboxError(
        'fetch_failed',
        `\`$ref: ${uri}\` — HTTP redirect ${res.status} (auto-follow disabled)`,
        {
          ref: uri,
          details: { httpStatus: res.status },
        }
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SchemaRefSandboxError('fetch_failed', `\`$ref: ${uri}\` — HTTP ${res.status}`, {
        ref: uri,
        details: { httpStatus: res.status },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8').decode(res.body));
    } catch (err) {
      throw new SchemaRefSandboxError(
        'fetch_failed',
        `\`$ref: ${uri}\` — body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { ref: uri }
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SchemaRefSandboxError('fetch_failed', `\`$ref: ${uri}\` — body is not a JSON object`, { ref: uri });
    }
    return parsed as Record<string, unknown>;
  };
}

/**
 * Validate that an external (non-`#/`) `$ref` target is in the
 * allowed set: same-origin as parent OR under the AAO mirror namespace.
 * Returns the normalized target origin on success; throws otherwise.
 */
function assertRefAllowed(ref: string, ctx: ResolveContext): NormalizedOrigin {
  if (ref.toLowerCase().startsWith('file:')) {
    throw new SchemaRefSandboxError(
      'file_scheme_rejected',
      `\`$ref: ${ref}\` — file:// scheme rejected unconditionally`,
      {
        ref,
      }
    );
  }
  const target = normalizeOrigin(ref);
  if (!target) {
    throw new SchemaRefSandboxError('invalid_ref', `\`$ref: ${ref}\` — could not parse as a URI`, { ref });
  }
  // Same-origin?
  if (target.origin === ctx.parentOrigin.origin) {
    return target;
  }
  // AAO mirror namespace? Spec is `https://` only — `http://` mirror
  // refs are rejected even when the host matches.
  if (ctx.mirrorHosts.has(target.hostname) && ref.toLowerCase().startsWith('https://')) {
    return target;
  }
  const mirrorList = [...ctx.mirrorHosts].join(', ');
  throw new SchemaRefSandboxError(
    'cross_origin_rejected',
    `\`$ref: ${ref}\` — not same-origin as parent (${ctx.parentOrigin.origin}) and not under an AAO mirror (${mirrorList})`,
    { ref, details: { parentOrigin: ctx.parentOrigin.origin, targetOrigin: target.origin } }
  );
}

/**
 * Walk a schema subtree, resolving every `$ref` inline. Recursive —
 * each external fetch's body is walked again under the new origin
 * context (depth increments).
 */
async function walk(node: unknown, depth: number, ctx: ResolveContext): Promise<unknown> {
  if (depth > ctx.maxDepthSeen.value) ctx.maxDepthSeen.value = depth;
  if (depth > ctx.maxDepth) {
    throw new SchemaRefSandboxError(
      'depth_exceeded',
      `\`$ref\` transitive depth exceeded ${ctx.maxDepth} (spec ceiling)`,
      { details: { maxDepth: ctx.maxDepth, depthSeen: depth } }
    );
  }
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) out.push(await walk(item, depth, ctx));
    return out;
  }
  const obj = node as Record<string, unknown>;
  // $ref node: resolve it inline. Sibling keys are restricted to the
  // annotation-only allowlist (description / title / examples / etc.) —
  // constraint keywords (`type`, `required`, `additionalProperties`,
  // `properties`, `items`, ...) on a `$ref` node would silently override
  // the referenced subschema's guarantees and defang manifest
  // validation. Per JSON Schema 2020-12 `$ref` siblings are an
  // additional constraint, not an override; we surface the constraint
  // mismatch as `invalid_ref` so authors must inline rather than smuggle.
  if (typeof obj.$ref === 'string') {
    ctx.count.value += 1;
    if (ctx.count.value > ctx.maxRefCount) {
      throw new SchemaRefSandboxError(
        'count_exceeded',
        `\`$ref\` count exceeded ${ctx.maxRefCount} across the resolved tree (spec ceiling)`,
        { details: { maxRefCount: ctx.maxRefCount, count: ctx.count.value } }
      );
    }
    const ref = obj.$ref;
    const { $ref: _drop, ...rest } = obj;
    void _drop;
    const disallowed = Object.keys(rest).filter(k => !ALLOWED_REF_SIBLINGS.has(k));
    if (disallowed.length > 0) {
      throw new SchemaRefSandboxError(
        'invalid_ref',
        `\`$ref: ${ref}\` has disallowed sibling keys [${disallowed.join(', ')}]; ` +
          `only annotation siblings (${[...ALLOWED_REF_SIBLINGS].sort().join(', ')}) ` +
          `may appear alongside a $ref. Inline the constraint instead.`,
        { ref, details: { disallowedSiblings: disallowed } }
      );
    }
    let resolved: Record<string, unknown>;
    if (ref.startsWith('#')) {
      // Intra-document pointer. Resolve against the parent root.
      const pointer = ref.slice(1);
      const target = resolveJsonPointer(ctx.parentRoot, pointer);
      if (target === null) {
        throw new SchemaRefSandboxError(
          'pointer_unresolved',
          `\`$ref: ${ref}\` — pointer not resolved in parent document`,
          {
            ref,
          }
        );
      }
      // Walk the resolved subtree at the same depth — same-document
      // pointers don't introduce a new origin layer; only count toward
      // the global count limit. Intra-doc pointer chains do hit the
      // depth cap if they're cyclic, which protects against
      // `#/a -> #/b -> #/a` loops.
      resolved = (await walk(target, depth + 1, ctx)) as Record<string, unknown>;
    } else {
      // External ref. Validate origin, fetch, walk the fetched body.
      // Parent digest is the trust anchor; same-origin / mirror refs
      // inherit trust. Callers wanting per-`$ref` digest verification
      // pass a custom `fetchExternal` that enforces it.
      assertRefAllowed(ref, ctx);
      let body: Record<string, unknown>;
      const cached = ctx.externalCache.get(ref);
      if (cached) {
        body = cached;
      } else {
        body = await ctx.fetchExternal(ref);
        ctx.externalCache.set(ref, body);
      }
      // External fetch opens a new document layer. We treat each
      // external fetch as one depth step.
      const refCtx: ResolveContext = {
        ...ctx,
        // The fetched document becomes the parent for its own intra-doc
        // pointers. Same-origin checks for its own external $refs still
        // use the ORIGINAL parent origin (the trust root). Per spec the
        // trust anchor is the top-level format_schema.uri@digest, so
        // nested same-origin checks should resolve against THAT origin,
        // not the chain's last hop — otherwise an attacker who
        // controls one mirror-hosted schema could re-export to another
        // origin via a single redirect-like $ref.
        parentRoot: body,
      };
      resolved = (await walk(body, depth + 1, refCtx)) as Record<string, unknown>;
    }
    // Merge sibling annotations UNDER the resolved body — referent wins
    // on key collision. With the allowlist above this is purely
    // cosmetic (no constraint keys can collide); the spread order is
    // defensive against future allowlist expansion that might admit a
    // key the referent also defines.
    return Object.keys(rest).length > 0 ? { ...rest, ...resolved } : resolved;
  }
  // Plain object — recurse into properties.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = await walk(v, depth, ctx);
  }
  return out;
}

/**
 * Recursively resolve every `$ref` in a fetched format_schema body,
 * honoring the spec's sandboxing + bounds. Returns the fully-inlined
 * schema and telemetry (`refCount`, `maxDepthSeen`).
 *
 * Throws {@link SchemaRefSandboxError} on the first failure (missing
 * pointer, cross-origin ref, depth/count exceeded, downstream fetch
 * failure). Callers surface the structured code on the response
 * envelope's `errors[]` array.
 *
 * @example
 * ```ts
 * import { fetchFormatSchema, resolveSchemaRefs } from '@adcp/sdk/v2/format-schema';
 *
 * const { schema, ref } = await fetchFormatSchema(formatSchemaRef);
 * const { schema: resolved } = await resolveSchemaRefs(schema, ref.uri);
 * // Feed `resolved` to Ajv. Ajv won't try to fetch any remaining $refs
 * // because every one has been inlined.
 * ```
 */
export async function resolveSchemaRefs(
  schema: Record<string, unknown>,
  parentUri: string,
  options: ResolveSchemaRefsOptions = {}
): Promise<ResolveSchemaRefsResult> {
  const parentOrigin = normalizeOrigin(parentUri);
  if (!parentOrigin) {
    throw new SchemaRefSandboxError('invalid_ref', `parent URI '${parentUri}' could not be parsed`, { ref: parentUri });
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const ctx: ResolveContext = {
    parentRoot: schema,
    parentOrigin,
    mirrorHosts: new Set(
      (options.mirrorHosts ?? (options.mirrorHost ? [options.mirrorHost] : DEFAULT_MIRROR_HOSTS)).map(h =>
        h.toLowerCase()
      )
    ),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_REF_DEPTH,
    maxRefCount: options.maxRefCount ?? DEFAULT_MAX_REF_COUNT,
    fetchExternal: options.fetchExternal ?? makeDefaultFetcher(timeoutMs, maxBodyBytes),
    externalCache: new Map(),
    count: { value: 0 },
    maxDepthSeen: { value: 0 },
  };
  const resolved = (await walk(schema, 0, ctx)) as Record<string, unknown>;
  return {
    schema: resolved,
    refCount: ctx.count.value,
    maxDepthSeen: ctx.maxDepthSeen.value,
  };
}
