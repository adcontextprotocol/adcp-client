/**
 * Per-binding assertions the runner runs on each BindingMatch. Each
 * returns an {@link AssertionResult} with a contract error code on
 * failure. Custom-vector payloads are SHA-256 redacted by default to
 * honor the contract's `error_report_payload_policy`; canonical
 * fixture vectors are echoed verbatim.
 */

import { createHash } from 'node:crypto';

import type { AssertionOptions, AssertionResult, BindingMatch } from '../types';
import { divergenceOffset, equalUnderHexCasePolicy, isUnreservedOnly } from '../rfc3986';

/**
 * Default prohibited pattern for {@link assertNoNestedExpansion} —
 * any brace-delimited token, regardless of case or naming convention.
 * Storyboards that need a narrower check (a specific sentinel macro)
 * pass a custom `RegExp`.
 */
export const DEFAULT_MACRO_PROHIBITED_PATTERN = /\{[^{}\s]+\}/;

/**
 * Byte-for-byte comparison of the observed value against the expected
 * encoded substring under the contract's hex-case policy. Uppercase
 * and lowercase hex digits inside a `%NN` triplet are treated as
 * equivalent; bytes outside triplets compare case-sensitively.
 */
export function assertRfc3986Safe(match: BindingMatch, options: AssertionOptions = {}): AssertionResult {
  const { observed_value, expected_encoded } = match;
  if (equalUnderHexCasePolicy(observed_value, expected_encoded)) {
    return { ok: true, byte_offset: -1 };
  }
  const offset = divergenceOffset(observed_value, expected_encoded);
  const { observed, expected } = redactPayloads(match, observed_value, expected_encoded, options);
  return {
    ok: false,
    error_code: 'substitution_encoding_violation',
    byte_offset: offset,
    expected,
    observed,
    message: `Encoded bytes diverge at offset ${offset} (expected=${truncate(expected)} observed=${truncate(observed)})`,
  };
}

/**
 * Stricter variant of {@link assertRfc3986Safe} — every byte at the
 * macro position is either an unreserved character or a valid `%NN`
 * triplet. Producers using a reserved-char denylist instead of the
 * unreserved whitelist fail here even when the byte-equal check passes
 * (the canonical counterexamples are parens `(` `)` and sub-delims).
 */
export function assertUnreservedOnly(match: BindingMatch, options: AssertionOptions = {}): AssertionResult {
  if (isUnreservedOnly(match.observed_value)) {
    return { ok: true };
  }
  const { observed, expected } = redactPayloads(match, match.observed_value, match.expected_encoded, options);
  return {
    ok: false,
    error_code: 'substitution_encoding_violation',
    observed,
    expected,
    message: `Observed value contains bytes outside RFC 3986 unreserved + %NN: ${truncate(observed)}`,
  };
}

/**
 * Reject second-round AdCP macro expansion at the macro position. A
 * seller that re-scanned its output after substitution would resolve
 * a `{DEVICE_ID}` literal inside the catalog value — this assertion
 * fails that behavior. The default `prohibited_pattern` matches any
 * brace-delimited token ({@link DEFAULT_MACRO_PROHIBITED_PATTERN});
 * storyboards that bind a specific sentinel macro SHOULD pass a
 * narrower pattern.
 */
export function assertNoNestedExpansion(
  match: BindingMatch,
  prohibited_pattern: RegExp = DEFAULT_MACRO_PROHIBITED_PATTERN,
  options: AssertionOptions = {}
): AssertionResult {
  // Only literal brace characters indicate re-expansion risk —
  // percent-encoded `%7B...%7D` is the contract-required safe form.
  if (!/[{}]/.test(match.observed_value)) {
    return { ok: true };
  }
  const hit = prohibited_pattern.exec(match.observed_value);
  if (!hit) {
    return { ok: true };
  }
  const { observed, expected } = redactPayloads(match, match.observed_value, match.expected_encoded, options);
  return {
    ok: false,
    error_code: 'nested_macro_re_expansion',
    observed,
    expected,
    message: `Observed value contains a literal AdCP macro token at the macro position — second-round expansion risk.`,
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
  // Scheme values are a closed set (URL parsers normalize them) —
  // safe to echo without SHA-256 redaction regardless of vector kind.
  return {
    ok: false,
    error_code: 'substitution_scheme_injection',
    observed: match.observed_url.protocol,
    expected: `${normalizedExpected}:`,
    message: `Observed URL scheme ${match.observed_url.protocol} does not match template scheme ${normalizedExpected}:`,
  };
}

/**
 * Redact custom-vector payloads to SHA-256 digests unless the caller
 * explicitly opts into verbatim echo. Mirrors the contract's
 * `error_report_payload_policy` — canonical fixture values are safe
 * to echo because the fixtures are public; seller-specific payloads
 * SHOULD NOT become searchable text in CI logs.
 */
function redactPayloads(
  match: BindingMatch,
  observed_value: string,
  expected_encoded: string,
  options: AssertionOptions
): { observed: string; expected: string } {
  if (!match.is_custom_vector || options.include_raw_payloads) {
    return { observed: observed_value, expected: expected_encoded };
  }
  return {
    observed: `sha256:${sha256Hex(observed_value)}`,
    expected: `sha256:${sha256Hex(expected_encoded)}`,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function truncate(s: string | undefined): string {
  if (s === undefined) return '';
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
