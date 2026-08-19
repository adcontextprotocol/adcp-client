/**
 * Seller-side helper that translates universal macro tokens in a pixel URL's
 * query parameter VALUES using a caller-supplied mapping. Macro tokens in key
 * position pass through untouched — only query-parameter values are translated.
 *
 * Universal macros match `\{[A-Z][A-Z0-9_]*\}` (upper-snake, single braces).
 * Native ad-server tokens (`%%X%%`, `{{x}}`) are not matched and pass through.
 *
 * Per query parameter:
 *   - No universal macro → left untouched (literal param passes through).
 *   - All macros in the param are in `mapping` → every occurrence replaced in
 *     a single pass.  A `native` entry is inserted raw; a `value` entry is
 *     percent-encoded with the RFC 3986 unreserved whitelist.
 *   - Any macro in the param is NOT in `mapping` → the entire parameter is
 *     dropped, its key is recorded in `dropped_params`, and each unmapped
 *     macro token is recorded in `unmapped_macros`.
 *
 * The substitution is a single pass: a translated value that itself contains
 * `{…}` is not re-expanded.
 *
 * A URL ending in a bare `?` with no parameters returns without the trailing
 * `?` (e.g. `https://px.example/i?` → `https://px.example/i`).
 *
 * Privacy note: dropping a parameter whose macro is unmapped silently removes
 * that tracker — including consent/privacy macros (`{GDPR_CONSENT}`,
 * `{US_PRIVACY}`) if a mapping is forgotten. Consent/privacy macros that get
 * dropped are surfaced separately in `dropped_consent_macros`; callers SHOULD
 * inspect it (and `unmapped_macros`) so a missing consent signal is caught
 * rather than shipped as a degraded pixel.
 *
 * A `native` mapping is trusted syntax and is therefore validated before any
 * URL is emitted. If any native entry contains an ASCII C0 control character
 * (U+0000-U+001F) or DEL (U+007F), this function throws
 * {@link UnsafeNativeMappingError}. Validation is mapping-scoped: an unsafe
 * entry is rejected even when its macro does not occur in `input_pixel_url`.
 *
 * URLSearchParams is intentionally avoided — it force-encodes values and would
 * corrupt native ad-server tokens (e.g. `%%GDPR%%`).  Query manipulation is
 * done textually so native tokens remain raw and value-encoding is controlled.
 */

import { encodeUnreserved } from './rfc3986';

/** Universal macro token pattern: `{UPPER_SNAKE}`. */
const UNIVERSAL_MACRO = /\{[A-Z][A-Z0-9_]*\}/g;

/**
 * Shapes of common ad-server native tokens (`%%X%%`, `{{x}}`, `${x}`, `[X]`).
 * A legitimate `value` entry — a literal data value — never takes this shape,
 * so a `value` that matches it almost certainly belongs in a `native` entry.
 * The bracket form is constrained to upper-snake token names (VAST-style, e.g.
 * `[CACHEBUSTING]`) so ordinary bracketed values like `[1,2,3]` or `[redacted]`
 * are not flagged.
 */
const NATIVE_TOKEN_SHAPE = /^(?:%%.+%%|\{\{.+\}\}|\$\{.+\}|\[[A-Z][A-Z0-9_]*\])$/;

/**
 * Consent/privacy-signalling universal macros. Dropping one because its
 * mapping was forgotten is a compliance hazard, so these are reported
 * separately from benign drops.
 */
const CONSENT_MACROS = new Set<string>([
  '{GDPR}',
  '{GDPR_CONSENT}',
  '{US_PRIVACY}',
  '{GPP_STRING}',
  '{GPP_SID}',
  '{LIMIT_AD_TRACKING}',
]);

/** ASCII control characters forbidden in native mapping entries. */
const UNSAFE_NATIVE_CHARACTER = /[\u0000-\u001F\u007F]/;

/**
 * A mapping from universal macro token (e.g. `'{GDPR}'`) to either:
 *   - `{ native: string }` — inserted verbatim (not percent-encoded), for
 *     downstream ad-server tokens like `%%GDPR%%`.
 *   - `{ value: string }` — inserted after RFC 3986 unreserved-whitelist
 *     percent-encoding, for seller-supplied data values.
 */
export type MacroMapping = Record<string, { native: string } | { value: string }>;

/**
 * Thrown when a native mapping contains an ASCII control character.
 *
 * The error intentionally identifies the mapping key but does not retain the
 * unsafe value, so callers can report the failure without propagating control
 * characters into logs or error envelopes. `message` escapes control
 * characters in the key for log safety; `macro` preserves the exact offending
 * key for programmatic handling and must be escaped before logging.
 */
export class UnsafeNativeMappingError extends Error {
  readonly code = 'unsafe_native_mapping' as const;
  readonly macro: string;

  constructor(macro: string) {
    const escapedMacro = JSON.stringify(macro).replace(/[\u007F-\u009F\u2028\u2029]/g, character => {
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
    super(`Native mapping for ${escapedMacro} contains a forbidden ASCII control character`);
    this.name = 'UnsafeNativeMappingError';
    this.macro = macro;
  }
}

/** Result of {@link translateUniversalMacros}. */
export interface TranslateResult {
  /** The translated URL. Base, path, and fragment are unchanged. */
  url: string;
  /**
   * Keys of query parameters that were dropped due to unmapped macros.
   * One entry per dropped parameter instance, so a repeated key can appear
   * more than once.
   */
  dropped_params: string[];
  /**
   * Unique unmapped macro tokens encountered across all dropped parameters.
   * Deduplicated: the same token is recorded at most once regardless of how
   * many parameters reference it.
   */
  unmapped_macros: string[];
  /**
   * Subset of `unmapped_macros` that are consent/privacy signals (`{GDPR}`,
   * `{GDPR_CONSENT}`, `{US_PRIVACY}`, `{GPP_STRING}`, `{GPP_SID}`,
   * `{LIMIT_AD_TRACKING}`). Surfaced separately so a forgotten-mapping drop of
   * a compliance-relevant macro isn't lost among benign drops. Deduplicated.
   */
  dropped_consent_macros: string[];
  /**
   * Consent/privacy macros supplied through a `value` entry. These values are
   * still RFC 3986 encoded and translated, but are reported because freezing a
   * consent signal at translation time can make it stale. Mapping-scoped,
   * mapping-property ordered, and deduplicated.
   */
  frozen_consent_macros?: string[];
  /**
   * Macro tokens whose `value` entry looks like a native ad-server token
   * (`%%…%%`, `{{…}}`, `${…}`, `[UPPER_SNAKE]`). Such a value will be
   * percent-encoded and break at impression time — almost always it should
   * have been a `native` entry. Deduplicated.
   *
   * Note: this is mapping-scoped, not URL-scoped — it lints the whole
   * `mapping`, so a suspect entry is reported even if its macro never appears
   * in `input_pixel_url` (unlike `unmapped_macros`/`dropped_params`, which are
   * URL-scoped). Empty when no mapping is suspect.
   */
  suspect_native_values: string[];
}

/**
 * Translate universal macro tokens in the query-parameter values of
 * `input_pixel_url` using `mapping`. See module-level documentation for the
 * substitution rules and the privacy note on dropped parameters.
 *
 * @throws {UnsafeNativeMappingError} If any native mapping entry contains
 * U+0000-U+001F or U+007F. The whole mapping is checked before translation,
 * including entries not referenced by `input_pixel_url`.
 */
export function translateUniversalMacros(input_pixel_url: string, mapping: MacroMapping): TranslateResult {
  const suspect_native_values: string[] = [];
  const suspectSeen = new Set<string>();
  const frozen_consent_macros: string[] = [];
  const frozenConsentSeen = new Set<string>();
  for (const [macro, entry] of Object.entries(mapping)) {
    if ('native' in entry) {
      if (UNSAFE_NATIVE_CHARACTER.test(entry.native)) {
        throw new UnsafeNativeMappingError(macro);
      }
      continue;
    }

    if (CONSENT_MACROS.has(macro) && !frozenConsentSeen.has(macro)) {
      frozenConsentSeen.add(macro);
      frozen_consent_macros.push(macro);
    }
    if (NATIVE_TOKEN_SHAPE.test(entry.value) && !suspectSeen.has(macro)) {
      suspectSeen.add(macro);
      suspect_native_values.push(macro);
    }
  }

  // Split off the fragment first so it is never touched.
  const fragmentIdx = input_pixel_url.indexOf('#');
  const withoutFragment = fragmentIdx === -1 ? input_pixel_url : input_pixel_url.slice(0, fragmentIdx);
  const fragment = fragmentIdx === -1 ? '' : input_pixel_url.slice(fragmentIdx);

  // Split base (scheme + host + path) from query.
  const queryIdx = withoutFragment.indexOf('?');
  if (queryIdx === -1) {
    return {
      url: input_pixel_url,
      dropped_params: [],
      unmapped_macros: [],
      dropped_consent_macros: [],
      frozen_consent_macros,
      suspect_native_values,
    };
  }

  const base = withoutFragment.slice(0, queryIdx);
  const rawQuery = withoutFragment.slice(queryIdx + 1);

  const dropped_params: string[] = [];
  const unmapped_macros: string[] = [];
  const unmappedSeen = new Set<string>();
  const dropped_consent_macros: string[] = [];
  const consentSeen = new Set<string>();

  const outputParts: string[] = [];

  for (const rawParam of rawQuery.split('&')) {
    const eqIdx = rawParam.indexOf('=');
    const key = eqIdx === -1 ? rawParam : rawParam.slice(0, eqIdx);
    const value = eqIdx === -1 ? '' : rawParam.slice(eqIdx + 1);

    // Find every universal macro token in the raw value.
    const tokens = value.match(UNIVERSAL_MACRO);

    if (!tokens) {
      // No universal macros — pass through verbatim.
      outputParts.push(rawParam);
      continue;
    }

    // Check for any unmapped macro in this parameter.
    const missing = tokens.filter(t => !(t in mapping));
    if (missing.length > 0) {
      dropped_params.push(key);
      for (const m of missing) {
        if (!unmappedSeen.has(m)) {
          unmappedSeen.add(m);
          unmapped_macros.push(m);
        }
        if (CONSENT_MACROS.has(m) && !consentSeen.has(m)) {
          consentSeen.add(m);
          dropped_consent_macros.push(m);
        }
      }
      continue;
    }

    // All macros are mapped — replace in a single pass.
    // String.replace with a global regex does not re-scan substituted output,
    // so macro tokens inside a translated value are never expanded.
    const translated = value.replace(UNIVERSAL_MACRO, token => {
      const entry = mapping[token];
      if (!entry) {
        // Unreachable: all tokens were verified above, but TypeScript narrows.
        return token;
      }
      return 'native' in entry ? entry.native : encodeUnreserved(entry.value);
    });

    outputParts.push(`${key}=${translated}`);
  }

  const newQuery = outputParts.join('&');
  const url = newQuery ? `${base}?${newQuery}${fragment}` : `${base}${fragment}`;

  return {
    url,
    dropped_params,
    unmapped_macros,
    dropped_consent_macros,
    frozen_consent_macros,
    suspect_native_values,
  };
}
