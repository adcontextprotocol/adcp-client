/**
 * Seller-side helper that translates universal macro tokens in a pixel URL's
 * query parameters using a caller-supplied mapping.
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
 * URLSearchParams is intentionally avoided — it force-encodes values and would
 * corrupt native ad-server tokens (e.g. `%%GDPR%%`).  Query manipulation is
 * done textually so native tokens remain raw and value-encoding is controlled.
 */

import { encodeUnreserved } from './rfc3986';

/** Universal macro token pattern: `{UPPER_SNAKE}`. */
const UNIVERSAL_MACRO = /\{[A-Z][A-Z0-9_]*\}/g;

/**
 * A mapping from universal macro token (e.g. `'{GDPR}'`) to either:
 *   - `{ native: string }` — inserted verbatim (not percent-encoded), for
 *     downstream ad-server tokens like `%%GDPR%%`.
 *   - `{ value: string }` — inserted after RFC 3986 unreserved-whitelist
 *     percent-encoding, for seller-supplied data values.
 */
export type MacroMapping = Record<string, { native: string } | { value: string }>;

/** Result of {@link universal_macro_translation}. */
export interface TranslateResult {
  /** The translated URL. Base, path, and fragment are unchanged. */
  url: string;
  /** Keys of query parameters that were dropped due to unmapped macros. */
  dropped_params: string[];
  /** Unique unmapped macro tokens encountered across all dropped parameters. */
  unmapped_macros: string[];
}

/**
 * Translate universal macro tokens in the query parameters of `input_pixel_url`
 * using `mapping`.  See module-level documentation for the substitution rules.
 */
export function universal_macro_translation(
  input_pixel_url: string,
  mapping: MacroMapping,
): TranslateResult {
  // Split off the fragment first so it is never touched.
  const fragmentIdx = input_pixel_url.indexOf('#');
  const withoutFragment =
    fragmentIdx === -1 ? input_pixel_url : input_pixel_url.slice(0, fragmentIdx);
  const fragment = fragmentIdx === -1 ? '' : input_pixel_url.slice(fragmentIdx);

  // Split base (scheme + host + path) from query.
  const queryIdx = withoutFragment.indexOf('?');
  if (queryIdx === -1) {
    return { url: input_pixel_url, dropped_params: [], unmapped_macros: [] };
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
    // The regex global flag is reset by replacing from a fresh match call so
    // replaced text is never re-scanned.
    const translated = value.replace(/\{[A-Z][A-Z0-9_]*\}/g, token => {
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

  return { url, dropped_params, unmapped_macros };
}
