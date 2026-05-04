/**
 * Credential discipline at the request boundary.
 *
 * Scans incoming buyer args for credential-shaped keys at any depth and
 * rejects with `INVALID_REQUEST` when `credentialPolicy === 'authInfo-only'`.
 * Closes the bug class observed in storefront fan-out paths where buyer-
 * supplied keys like `<platform>_access_token` (top-level, in `context`,
 * or in `ext`) flow through to upstream calls.
 *
 * Default mode is `'lax'` for back-compat. Opt into `'authInfo-only'` to
 * enforce: credentials must arrive on `authInfo` (the framework-resolved
 * bearer / signature / OAuth principal) and never on the args bag.
 *
 * Pattern set is extensible. Adopters whose platform vocabulary uses
 * additional credential names extend via `credentialPolicy.patterns.extend`
 * or replace the matcher entirely. Per-tool opt-out via
 * `credentialPolicy.tools`.
 *
 * @see {@link AdcpServerConfig.credentialPolicy}
 * @see docs/guides/CTX-METADATA-SAFETY.md
 */

/**
 * Enforcement mode.
 *
 * - `'lax'` — no scan; current behavior.
 * - `'authInfo-only'` — scan args for credential-shaped keys; reject any
 *   match with `INVALID_REQUEST` listing the offending paths (not values).
 *   Adopters who legitimately accept buyer-presented credentials opt out
 *   per-tool via {@link CredentialPolicyConfig.tools}.
 */
export type CredentialPolicyMode = 'lax' | 'authInfo-only';

/**
 * Patterns that flag a key as credential-shaped. Values matching ANY
 * regex (or returning `true` from the matcher) are treated as
 * credential-bearing.
 */
export interface CredentialPatternsConfig {
  /**
   * Additional patterns appended to {@link DEFAULT_CREDENTIAL_PATTERNS}.
   * Use for platform-specific names the defaults don't cover (e.g.
   * `/^bearer$/i`, `/credentials/i`, `/^[a-z]+Pat$/`).
   */
  extend?: RegExp[];

  /**
   * Replace the regex-based check entirely. Receives each property name
   * encountered during recursion, plus the parent path. Return `true`
   * to flag as credential-bearing. Mutually exclusive with `extend` —
   * setting both throws at server construction.
   */
  matcher?: (key: string, path: readonly string[]) => boolean;
}

/**
 * Full credential-policy configuration. Pass a string for the simple
 * case (`credentialPolicy: 'authInfo-only'`) or this shape for
 * pattern customization or per-tool overrides.
 */
export interface CredentialPolicyConfig {
  policy: CredentialPolicyMode;
  patterns?: CredentialPatternsConfig;
  /**
   * Per-tool mode overrides. Storefronts that legitimately accept
   * buyer-presented credentials on a specific tool opt that tool out
   * of the server-wide `'authInfo-only'`:
   *
   * ```ts
   * credentialPolicy: {
   *   policy: 'authInfo-only',
   *   tools: { activate_signal: 'lax' },
   * }
   * ```
   */
  tools?: Record<string, CredentialPolicyMode>;
}

export type CredentialPolicy = CredentialPolicyMode | CredentialPolicyConfig;

/**
 * Default credential-name patterns. Catches the three vectors observed
 * in PR scope3data/agentic-adapters#248 plus the broader credential
 * vocabulary common in TS ecosystems. Adopters whose platform names
 * fall outside this set extend via {@link CredentialPatternsConfig.extend}.
 *
 * Coverage:
 *   - `_token$` (case-insensitive) — `*_access_token`, `bearer_token`,
 *     `id_token`, `session_token`, `refresh_token`.
 *   - `_secret$` / `_password$` — `client_secret`, `db_password`.
 *   - `api[_-]?key` — `api_key`, `apiKey`, `api-key`.
 *   - `^bearer$` — bare `bearer` field.
 *   - `^accessToken$` / `^refreshToken$` (case-insensitive) — camelCase
 *     and PascalCase exact matches.
 *
 * Intentionally excluded from defaults (too many false positives):
 *   - bare `key`, `principal`, `auth_token` (no `_token` boundary
 *     elsewhere — `_token$` covers `auth_token` since it ends in `_token`).
 *   - `*Token$` PascalCase suffix without a known prefix — e.g.
 *     `paymentToken` could be a legitimate wire field. Adopters who
 *     want broader coverage extend.
 */
export const DEFAULT_CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /_token$/i,
  /_secret$/i,
  /_password$/i,
  /api[_-]?key/i,
  /^bearer$/i,
  /^accessToken$/i,
  /^refreshToken$/i,
]);

interface ResolvedMatcher {
  match(key: string, path: readonly string[]): boolean;
}

function buildMatcher(patterns?: CredentialPatternsConfig): ResolvedMatcher {
  if (patterns?.matcher && patterns.extend) {
    throw new Error(
      'createAdcpServer: credentialPolicy.patterns cannot set both `matcher` and `extend`. ' +
        '`matcher` fully replaces the regex-based check; `extend` adds to the default set. ' +
        'Pick one — they answer different questions and combining them silently drops the regex set.'
    );
  }
  if (patterns?.matcher) {
    const fn = patterns.matcher;
    return { match: (key, path) => fn(key, path) };
  }
  const regexes = patterns?.extend ? [...DEFAULT_CREDENTIAL_PATTERNS, ...patterns.extend] : DEFAULT_CREDENTIAL_PATTERNS;
  return {
    match: (key: string) => regexes.some(rx => rx.test(key)),
  };
}

/**
 * Recursively scan `value` for credential-shaped keys. Returns dotted
 * paths to every match (e.g. `['snap_access_token',
 * 'context.snap_access_token', 'ext.snap_access_token']`). Empty array
 * means clean.
 *
 * Scans through both objects and arrays; array indices appear in the
 * path as numeric segments. Stops at primitives. Cycle-safe via a
 * Set-tracked depth-first traversal — buyers who send self-referential
 * objects don't infinite-loop the scanner.
 */
export function scanArgsForCredentials(value: unknown, patterns?: CredentialPatternsConfig): string[] {
  const matcher = buildMatcher(patterns);
  const hits: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: readonly string[]): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], [...path, String(i)]);
      }
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = [...path, key];
      if (matcher.match(key, path)) {
        hits.push(childPath.join('.'));
      }
      walk(child, childPath);
    }
  };

  walk(value, []);
  return hits;
}

/**
 * Normalize a `CredentialPolicy` (string or object) plus a tool name to
 * the effective {@link CredentialPolicyMode} for that tool. Per-tool
 * overrides win; otherwise the server-wide policy applies.
 */
export function resolveCredentialPolicyForTool(
  policy: CredentialPolicy | undefined,
  toolName: string
): CredentialPolicyMode {
  if (policy === undefined) return 'lax';
  if (typeof policy === 'string') return policy;
  return policy.tools?.[toolName] ?? policy.policy;
}

/**
 * Validate a `CredentialPolicy` at server construction. Catches typos
 * in `tools` keys (`activte_signal` instead of `activate_signal`) and
 * the both-`extend`-and-`matcher` config error before any traffic
 * dispatches. Throws `Error` with a specific message; callers convert
 * to their construction-time error envelope of choice.
 *
 * `knownToolNames` is the set of tool names the framework will
 * register for this server (spec tools for the claimed specialisms +
 * any adopter-supplied custom tools). Pass after the registration
 * loop completes so the set is authoritative.
 */
export function validateCredentialPolicy(
  policy: CredentialPolicy | undefined,
  knownToolNames: ReadonlySet<string>
): void {
  if (policy === undefined || typeof policy === 'string') return;

  // Surface the both-fields-set conflict at construction, not on the
  // first credential-bearing request. Mirrors the runtime check in
  // `buildMatcher` so adopters get the same diagnostic regardless of
  // whether traffic is flowing yet.
  if (policy.patterns?.matcher && policy.patterns?.extend) {
    throw new Error(
      'createAdcpServer: credentialPolicy.patterns cannot set both `matcher` and `extend`. ' +
        '`matcher` fully replaces the regex-based check; `extend` adds to the default set. Pick one.'
    );
  }

  if (!policy.tools) return;
  const unknownTools = Object.keys(policy.tools).filter(name => !knownToolNames.has(name));
  if (unknownTools.length > 0) {
    const known = [...knownToolNames].sort().join(', ');
    throw new Error(
      `createAdcpServer: credentialPolicy.tools references unregistered tool name(s): ${unknownTools
        .map(n => JSON.stringify(n))
        .join(', ')}. ` +
        `A typo in this map silently no-ops the per-tool override and the server-wide policy applies, ` +
        `which fails-closed on tools that needed an opt-out. ` +
        `Known tool names: ${known}.`
    );
  }
}
