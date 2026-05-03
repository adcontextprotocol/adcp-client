/**
 * Shared glob-to-regex translator for `endpoint_pattern` matching.
 *
 * Used on both sides of the `upstream_traffic` round-trip:
 *   - `@adcp/sdk/upstream-recorder` filters its own buffer when the adopter's
 *     controller calls `recorder.query({ endpointPattern })`.
 *   - The storyboard runner filters `recorded_calls[]` returned by the
 *     controller when grading `upstream_traffic` validations.
 *
 * If the two implementations drift, the runner-side filter could surface
 * different calls than the producer-side filter would — different verdict
 * on the same storyboard. One implementation, one test, no drift.
 *
 * Grammar (ratified by spec PR adcontextprotocol/adcp#3987):
 *   - `*` matches zero or more characters of any kind, including `/`.
 *   - All other characters are literal — `?`, `[`, `]`, `(`, `)` etc. are
 *     escaped to themselves so a path-component like `?cohort=1` doesn't
 *     accidentally act as a regex quantifier.
 *   - No escape mechanism — `*` is always a wildcard. Callers needing
 *     literal-asterisk matching omit `endpoint_pattern` and filter
 *     response-side.
 *   - Match is anchored (full-string), not substring search.
 *
 * Defense against catastrophic-backtracking on `'**********'`-style
 * patterns: consecutive `*`s coalesce to a single `*` before the
 * `* → .*` substitution, so the resulting regex has at most one `.*`
 * per literal-segment boundary.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '*')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
