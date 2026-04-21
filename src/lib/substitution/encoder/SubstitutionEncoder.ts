/**
 * Seller-side primitives for producing catalog-item macro substitution
 * output that satisfies the #2620 rule. The runtime counterpart of
 * {@link SubstitutionObserver} — both share the RFC 3986 implementation
 * in `../rfc3986.ts` so a single bug-fix path covers producer and verifier.
 *
 * ```ts
 * import { SubstitutionEncoder } from '@adcp/client/substitution';
 *
 * const encoder = new SubstitutionEncoder();
 * encoder.reject_if_contains_macro(rawValue); // optional input guard
 * const safe = encoder.encode_for_url_context(rawValue);
 * const url = template.replace('{SKU}', safe);
 * ```
 */

import { encodeUnreserved } from '../rfc3986';

/**
 * Regex that matches any AdCP macro token (braces included). Catalog
 * sellers use this to refuse catalog values that would trigger a
 * second-round expansion if the downstream renderer re-scanned its
 * output. The check is a belt-and-suspenders guard; the encoder itself
 * already percent-encodes braces so a post-encoded value CAN NOT
 * re-expand.
 */
const ADCP_MACRO_PATTERN = /\{[A-Z][A-Z0-9_]*\}/;

export class MacroInRawValueError extends Error {
  readonly raw_value: string;
  readonly matched_macro: string;
  constructor(raw_value: string, matched_macro: string) {
    super(
      `Raw catalog value contains AdCP macro token ${matched_macro} — ` +
        `reject at ingest or accept the risk of second-round expansion in consumers that re-scan rendered output.`
    );
    this.name = 'MacroInRawValueError';
    this.raw_value = raw_value;
    this.matched_macro = matched_macro;
  }
}

export class SubstitutionEncoder {
  /**
   * Strict RFC 3986 unreserved-whitelist percent-encoder. Only
   * `ALPHA / DIGIT / "-" / "." / "_" / "~"` pass through; every other
   * byte is UTF-8 + percent-encoded with uppercase hex digits.
   *
   * The behavior intentionally differs from `encodeURIComponent`, which
   * leaves `( ) * !` unescaped — those are sub-delims, not unreserved,
   * and leaving them raw fails the `url-scheme-injection-neutralized`
   * vector when a value like `javascript:alert(0)` substitutes into an
   * `href`-whole-value position.
   */
  encode_for_url_context(raw_value: string): string {
    return encodeUnreserved(raw_value);
  }

  /**
   * Throw if `raw_value` contains an AdCP macro token. The encoder
   * output is already safe from second-round expansion (braces become
   * `%7B` / `%7D`), so this is a defensive check for sellers who want
   * to fail-fast at catalog ingest rather than let suspicious values
   * propagate. Opt-in; callers that omit it accept the canonical
   * encode-and-move-on behavior shown by
   * `nested-expansion-preserved-as-literal`.
   */
  reject_if_contains_macro(raw_value: string): void {
    const match = raw_value.match(ADCP_MACRO_PATTERN);
    if (match) {
      throw new MacroInRawValueError(raw_value, match[0]);
    }
  }
}
