/**
 * Per-binding assertions the runner runs on each BindingMatch. Each
 * returns an {@link AssertionResult} with a contract error code on failure.
 */

import type { AssertionResult, BindingMatch } from '../types';
import { divergenceOffset, equalUnderHexCasePolicy, isUnreservedOnly } from '../rfc3986';

/**
 * Default prohibited pattern for
 * `assert_no_nested_expansion` — any `{MACRO_NAME}` token. Storyboards
 * MAY pass a narrower pattern (e.g., restricted to the specific
 * second-round macro under test).
 */
export const DEFAULT_MACRO_PROHIBITED_PATTERN = /\{[A-Z][A-Z0-9_]*\}/;

/**
 * Byte-for-byte comparison of the observed value against the expected
 * encoded substring under the contract's hex-case policy. Uppercase
 * and lowercase hex digits inside a `%NN` triplet are treated as
 * equivalent; bytes outside triplets compare case-sensitively.
 */
export function assertRfc3986Safe(match: BindingMatch): AssertionResult {
  const { observed_value, expected_encoded } = match;
  if (equalUnderHexCasePolicy(observed_value, expected_encoded)) {
    return { ok: true, byte_offset: -1 };
  }
  const offset = divergenceOffset(observed_value, expected_encoded);
  return {
    ok: false,
    error_code: 'substitution_encoding_violation',
    byte_offset: offset,
    expected: expected_encoded,
    observed: observed_value,
    message: `Encoded bytes diverge at offset ${offset} (expected=${truncate(expected_encoded)} observed=${truncate(observed_value)})`,
  };
}

/**
 * Stricter variant of {@link assertRfc3986Safe} — every byte at the
 * macro position is either an unreserved character or a valid `%NN`
 * triplet. Producers using a reserved-char denylist instead of the
 * unreserved whitelist fail here even when the byte-equal check passes
 * (the canonical counterexamples are parens `(` `)` and sub-delims).
 */
export function assertUnreservedOnly(match: BindingMatch): AssertionResult {
  if (isUnreservedOnly(match.observed_value)) {
    return { ok: true };
  }
  return {
    ok: false,
    error_code: 'substitution_encoding_violation',
    observed: match.observed_value,
    expected: match.expected_encoded,
    message: `Observed value contains bytes outside RFC 3986 unreserved + %NN: ${truncate(match.observed_value)}`,
  };
}

/**
 * Reject second-round AdCP macro expansion at the macro position. A
 * seller that re-scanned its output after substitution would resolve a
 * `{DEVICE_ID}` literal inside the catalog value — this assertion
 * fails that behavior. The default `prohibited_pattern` matches any
 * `{NAME}` token; storyboards that bind a specific sentinel macro
 * SHOULD pass a narrower pattern.
 */
export function assertNoNestedExpansion(
  match: BindingMatch,
  prohibited_pattern: RegExp = DEFAULT_MACRO_PROHIBITED_PATTERN
): AssertionResult {
  // The observed value is the substituted bytes at the macro position.
  // If those bytes contain an unescaped `{...}` token, the downstream
  // consumer could re-expand it. The encoded form `%7B...%7D` is safe
  // — we only flag literal brace characters in the observed slot.
  if (!/[{}]/.test(match.observed_value)) {
    return { ok: true };
  }
  const hit = prohibited_pattern.exec(match.observed_value);
  if (!hit) {
    return { ok: true };
  }
  return {
    ok: false,
    error_code: 'nested_macro_re_expansion',
    observed: match.observed_value,
    expected: match.expected_encoded,
    message: `Observed value contains a literal AdCP macro token ${hit[0]} at the macro position — second-round expansion risk.`,
  };
}

/**
 * Verify the observed URL's scheme matches the template's scheme. Only
 * meaningful at `href_whole_value` positions where a catalog value
 * could replace an entire URL and change its scheme (e.g., a
 * `javascript:`-scheme injection into `<a href="{CLICK}">`).
 */
export function assertSchemePreserved(match: BindingMatch, template_scheme: string): AssertionResult {
  if (match.position.kind !== 'href_whole_value') {
    // Scheme preservation is only meaningful for whole-value bindings;
    // sub-value positions can't alter the enclosing URL's scheme.
    return { ok: true };
  }
  const normalizedExpected = template_scheme.replace(/:$/, '').toLowerCase();
  const observedScheme = match.observed_url.protocol.replace(/:$/, '').toLowerCase();
  if (observedScheme === normalizedExpected) {
    return { ok: true };
  }
  return {
    ok: false,
    error_code: 'substitution_scheme_injection',
    observed: match.observed_url.protocol,
    expected: `${normalizedExpected}:`,
    message: `Observed URL scheme ${match.observed_url.protocol} does not match template scheme ${normalizedExpected}:`,
  };
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
