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
 * vocabulary common in TS ecosystems and HTTPSig / OAuth flows.
 * Adopters whose platform names fall outside this set extend via
 * {@link CredentialPatternsConfig.extend}.
 *
 * Coverage:
 *   - `_token$` (case-insensitive) — `*_access_token`, `bearer_token`,
 *     `id_token`, `session_token`, `auth_token`, `refresh_token`.
 *   - `_secret$` / `_password$` — `client_secret`, `db_password`.
 *   - `api[_-]?key` (case-insensitive) — `api_key`, `apiKey`, `api-key`,
 *     and prefixed variants like `criteo_api_key`.
 *   - `private[_-]?key` (case-insensitive) — `private_key`, `privateKey`,
 *     `private-key`. Common in JWT / RFC 9421 signing-key flows.
 *   - `^authorization$` / `^cookie$` (case-insensitive) — HTTP-header
 *     value smuggled as a field.
 *   - `^bearer$` — bare `bearer` field.
 *   - `^accessToken$` / `^refreshToken$` (case-insensitive) — camelCase
 *     and PascalCase exact matches.
 *
 * Intentionally excluded from defaults (too many false positives):
 *   - bare `key` / `principal` / `kid` / `pat` — too short to risk
 *     matching legitimate routing fields.
 *   - `*Token$` PascalCase suffix without a known prefix — e.g.
 *     `paymentToken` could be a legitimate wire field. Adopters who
 *     want broader coverage extend.
 */
export const DEFAULT_CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /_token$/i,
  /_secret$/i,
  /_password$/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /^authorization$/i,
  /^cookie$/i,
  /^bearer$/i,
  /^accessToken$/i,
  /^refreshToken$/i,
]);

type ResolvedMatcher = (key: string, path: readonly string[]) => boolean;

/**
 * Strip `/g` and `/y` flags from a regex. With those flags set,
 * `RegExp.prototype.test` advances `lastIndex`, causing alternating-skip
 * behavior on repeated calls against the same pattern instance. The
 * scanner calls `.test()` per key per request and reuses the regex
 * instance across calls, so `/credentials/gi` (a natural footgun) would
 * produce non-deterministic hits. Strip the offending flags rather than
 * forcing adopters to read a footnote.
 */
function stripStatefulFlags(rx: RegExp): RegExp {
  if (!rx.global && !rx.sticky) return rx;
  return new RegExp(rx.source, rx.flags.replace(/[gy]/g, ''));
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
    return patterns.matcher;
  }
  const regexes = patterns?.extend
    ? [...DEFAULT_CREDENTIAL_PATTERNS, ...patterns.extend.map(stripStatefulFlags)]
    : DEFAULT_CREDENTIAL_PATTERNS;
  return (key: string) => regexes.some(rx => rx.test(key));
}

/**
 * Recursively scan `value` for credential-shaped keys. Returns dotted
 * paths to every match (e.g. `['snap_access_token',
 * 'context.snap_access_token', 'ext.snap_access_token']`). Empty array
 * means clean.
 *
 * Scope:
 *   - Walks own string-keyed data properties only. Symbol keys,
 *     prototype-chain inherited properties, and accessor (getter/setter)
 *     properties are skipped — JSON-derived inputs (the only source the
 *     framework dispatches) cannot carry any of those. Hand-built
 *     objects with credential-named getters are still flagged
 *     fail-closed (the property name is matched against the regex
 *     set), but the getter is never invoked, so a throwing or
 *     side-effecting getter cannot reach the dispatcher.
 *   - Walks both plain objects and arrays; array indices appear as
 *     numeric path segments.
 *   - Stops at primitives.
 *   - Cycle-safe via a `WeakSet` tracking visited objects.
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

    // Use property descriptors so accessor (getter/setter) properties
    // are visible to the scanner without invoking the getter — a
    // throwing getter on a credential-named property would otherwise
    // either crash the dispatcher or land the surrounding `params`
    // object in an outer error log. Data-only inputs (JSON.parse,
    // structured clone) never have accessor descriptors, so this is
    // a defensive measure for hand-built test inputs and any future
    // transport that bypasses JSON parsing.
    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(node) as Record<string, PropertyDescriptor>;
    } catch {
      // Proxy-trapped property enumeration that throws — fail closed
      // by recording the parent path as suspicious. Cannot enumerate
      // to a finer-grained location.
      hits.push([...path, '<unreadable>'].join('.'));
      return;
    }

    for (const key of Object.keys(descriptors)) {
      const desc = descriptors[key];
      if (desc === undefined) continue;
      const childPath = [...path, key];
      if (matcher(key, path)) {
        hits.push(childPath.join('.'));
      }
      // Only recurse into data descriptors. Accessor descriptors
      // (no `value` slot) are flagged-by-name above but never invoked.
      if ('value' in desc) {
        walk(desc.value, childPath);
      }
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
 *
 * @internal — adopters cannot construct `knownToolNames` outside the
 * framework. The framework calls this once, late in `createAdcpServer`,
 * after every tool (including `get_adcp_capabilities`) is registered.
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
