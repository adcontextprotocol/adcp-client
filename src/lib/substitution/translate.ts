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
 * Privacy note: dropping a parameter whose macro is unmapped silently removes
 * that tracker — including consent/privacy macros (`{GDPR_CONSENT}`,
 * `{US_PRIVACY}`) if a mapping is forgotten. Callers SHOULD inspect
 * `unmapped_macros` and `dropped_params` so a missing consent signal is caught
 * rather than shipped as a degraded pixel.
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
 */
const NATIVE_TOKEN_SHAPE = /^(?:%%.+%%|\{\{.+\}\}|\$\{.+\}|\[.+\])$/;

/**
 * A mapping from universal macro token (e.g. `'{GDPR}'`) to either:
 *   - `{ native: string }` — inserted verbatim (not percent-encoded), for
 *     downstream ad-server tokens like `%%GDPR%%`.
 *   - `{ value: string }` — inserted after RFC 3986 unreserved-whitelist
 *     percent-encoding, for seller-supplied data values.
 */
export type MacroMapping = Record<string, { native: string } | { value: string }>;

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
   * Macro tokens whose `value` entry looks like a native ad-server token
   * (`%%…%%`, `{{…}}`, `${…}`, `[…]`). Such a value will be percent-encoded
   * and break at impression time — almost always it should have been a
   * `native` entry. Deduplicated. Empty when no mapping is suspect.
   */
  suspect_native_values: string[];
}

/**
 * Translate universal macro tokens in the query-parameter values of
 * `input_pixel_url` using `mapping`. See module-level documentation for the
 * substitution rules and the privacy note on dropped parameters.
 */
export function translateUniversalMacros(input_pixel_url: string, mapping: MacroMapping): TranslateResult {
  const suspect_native_values: string[] = [];
  const suspectSeen = new Set<string>();
  for (const [macro, entry] of Object.entries(mapping)) {
    if ('value' in entry && NATIVE_TOKEN_SHAPE.test(entry.value) && !suspectSeen.has(macro)) {
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
    return { url: input_pixel_url, dropped_params: [], unmapped_macros: [], suspect_native_values };
  }

  const base = withoutFragment.slice(0, queryIdx);
  const rawQuery = withoutFragment.slice(queryIdx + 1);

  const dropped_params: string[] = [];
  const unmapped_macros: string[] = [];
  const unmappedSeen = new Set<string>();

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

  return { url, dropped_params, unmapped_macros, suspect_native_values };
}
