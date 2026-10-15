/**
 * Seller-side helper that translates universal macro tokens in a pixel URL's
 * query parameter VALUES using a caller-supplied mapping. Macro tokens in key
 * position pass through untouched — only query-parameter values are translated.
 *
 * Universal macros match `\{[A-Z][A-Z0-9_]*\}` (upper-snake, single braces).
 * Native ad-server tokens (`%%X%%`, `{{x}}`, `${x}`, `[X]`) pass through
 * without translating their interiors.
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
import { isConsentMacro, isVendorScopedConsentMacro } from './consent-macros';

interface MacroToken {
  text: string;
  start: number;
  end: number;
  native: boolean;
}

/**
 * Consume native shells before single-brace AdCP tokens. Cache missing closers
 * so repeated malformed openers cannot cause quadratic scans of the URL tail.
 */
function* macroTokens(text: string): Generator<MacroToken> {
  const missingClosers = new Set<string>();
  let cursor = 0;
  while (cursor < text.length) {
    let end = -1;
    let native = true;
    const close = text.startsWith('%%', cursor)
      ? '%%'
      : text.startsWith('{{', cursor)
        ? '}}'
        : text.startsWith('${', cursor)
          ? '}'
          : null;
    if (close && !missingClosers.has(close)) {
      const closer = text.indexOf(close, cursor + 2);
      if (closer === -1) missingClosers.add(close);
      else end = closer + close.length;
    }
    if (end === -1 && (text[cursor] === '{' || text[cursor] === '[')) {
      let nameEnd = cursor + 1;
      if (/[A-Z]/.test(text[nameEnd] ?? '')) {
        nameEnd += 1;
        while (/[A-Z0-9_]/.test(text[nameEnd] ?? '')) nameEnd += 1;
        if (text[nameEnd] === (text[cursor] === '{' ? '}' : ']')) {
          end = nameEnd + 1;
          native = text[cursor] === '[';
        }
      }
    }
    if (end === -1) {
      cursor += 1;
      continue;
    }
    yield { text: text.slice(cursor, end), start: cursor, end, native };
    cursor = end;
  }
}

/** Native syntax embedded in a value is advisory; ordinary brackets are data. */
function hasNativeTokenSyntax(value: string): boolean {
  for (const token of macroTokens(value)) {
    const minimumLength = token.text.startsWith('${') ? 3 : token.text.startsWith('[') ? 2 : 4;
    if (token.native && token.text.length > minimumLength) return true;
  }
  return false;
}

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

/**
 * Thrown before emitting a URL containing a second vendor-scoped TCF macro.
 * Only the canonical second token is retained, never the URL or consent data.
 */
export class MultipleVendorConsentMacrosError extends Error {
  readonly code = 'multiple_vendor_consent_macros' as const;
  readonly macro: string;

  constructor(macro: string) {
    super(`Multiple vendor-scoped consent macros; second token is ${JSON.stringify(macro)}`);
    this.name = 'MultipleVendorConsentMacrosError';
    this.macro = macro;
  }
}

interface RenderedSpan {
  text: string;
  /** Concrete values are data, even if their bytes resemble a known alias. */
  concrete?: boolean;
  scopedSource?: string;
}

interface ScopedOccurrence {
  start: number;
  end: number;
  macro: string;
}

interface TextRange {
  start: number;
  end: number;
}

/** Find an overlap in sorted, non-overlapping ranges without rescanning them. */
function overlappingRange<T extends TextRange>(ranges: readonly T[], candidate: TextRange): T | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle]!.end <= candidate.start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range && range.start < candidate.end ? range : undefined;
}

/**
 * Inspect the final emitted bytes, retaining native-source evidence for
 * spellings such as %%CONSENT_755%%. Literal values never supply macro evidence.
 */
function assertSingleScopedConsent(spans: readonly RenderedSpan[], mapping: MacroMapping): string {
  const url = spans.map(span => span.text).join('');
  const concrete: TextRange[] = [];
  const sources: ScopedOccurrence[] = [];
  let offset = 0;
  for (const span of spans) {
    const range = { start: offset, end: offset + span.text.length };
    if (span.concrete && range.start < range.end) {
      // Adjacent value mappings remain data even when their combined bytes
      // happen to spell a known native alias.
      const previous = concrete[concrete.length - 1];
      if (previous?.end === range.start) previous.end = range.end;
      else concrete.push(range);
    }
    if (span.scopedSource && span.text.length > 0) sources.push({ ...range, macro: span.scopedSource });
    offset = range.end;
  }

  const occurrences: ScopedOccurrence[] = [];
  const shells: TextRange[] = [];
  for (const token of macroTokens(url)) {
    const range = { start: token.start, end: token.end };
    shells.push(range);
    const canonical = token.text.startsWith('${') ? token.text.slice(1) : token.text;
    // Encoded data cannot contain complete braced syntax. A token assembled
    // across native/data spans is real expandable output and must still count.
    if (isVendorScopedConsentMacro(canonical)) {
      occurrences.push({ ...range, macro: canonical });
    }
  }

  // A verified mapping also identifies pre-existing and indirectly inserted
  // native aliases. Prefer complete spellings when aliases overlap. Canonical
  // occurrences already identify their semantics and must not be counted twice.
  const aliases: ScopedOccurrence[] = [];
  for (const [macro, entry] of Object.entries(mapping)) {
    if (!isVendorScopedConsentMacro(macro) || !('native' in entry) || entry.native.length === 0) continue;
    let start = url.indexOf(entry.native);
    while (start !== -1) {
      const range = { start, end: start + entry.native.length };
      const shell = overlappingRange(shells, range);
      const completeShell = shell?.start === range.start && shell.end === range.end;
      const insideShell = shell && shell.start <= range.start && range.end <= shell.end && !completeShell;
      const data = overlappingRange(concrete, range);
      const entirelyConcrete = data && data.start <= range.start && range.end <= data.end;
      if (!insideShell && (completeShell || !entirelyConcrete) && !overlappingRange(occurrences, range)) {
        aliases.push({ ...range, macro });
      }
      start = url.indexOf(entry.native, range.end);
    }
  }
  aliases.sort((a, b) => a.start - b.start || b.end - a.end);
  const selectedAliases: ScopedOccurrence[] = [];
  for (const alias of aliases) {
    const previous = selectedAliases[selectedAliases.length - 1];
    if (!previous || previous.end <= alias.start) selectedAliases.push(alias);
  }
  for (const alias of selectedAliases) occurrences.push(alias);
  occurrences.sort((a, b) => a.start - b.start);

  // Native mappings can use arbitrary syntax. Preserve the scoped source's
  // semantics if no recognizable target survived, without adding a second
  // occurrence for an ordinary source -> native translation.
  const unmatchedSources = sources.filter(source => !overlappingRange(occurrences, source));
  for (const source of unmatchedSources) occurrences.push(source);
  occurrences.sort((a, b) => a.start - b.start);
  const second = occurrences[1];
  if (second) throw new MultipleVendorConsentMacrosError(second.macro);
  return url;
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
   * `{GDPR_CONSENT}`, `{GDPR_CONSENT_<gvl_id>}`, `{ADDTL_CONSENT}`,
   * `{US_PRIVACY}`, `{GPP_STRING}`, `{GPP_SID}`,
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
 * @throws {MultipleVendorConsentMacrosError} If the final URL contains more
 * than one scoped TCF consent macro, after unsupported parameters are dropped.
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

    if (isConsentMacro(macro) && !frozenConsentSeen.has(macro)) {
      frozenConsentSeen.add(macro);
      frozen_consent_macros.push(macro);
    }
    if (hasNativeTokenSyntax(entry.value) && !suspectSeen.has(macro)) {
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
      url: assertSingleScopedConsent([{ text: input_pixel_url }], mapping),
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

  const outputParts: RenderedSpan[][] = [];

  for (const rawParam of rawQuery.split('&')) {
    const eqIdx = rawParam.indexOf('=');
    const key = eqIdx === -1 ? rawParam : rawParam.slice(0, eqIdx);
    const value = eqIdx === -1 ? '' : rawParam.slice(eqIdx + 1);

    const tokens = [...macroTokens(value)].filter(token => !token.native);

    if (tokens.length === 0) {
      // No universal macros — pass through verbatim.
      outputParts.push([{ text: rawParam }]);
      continue;
    }

    // Check for any unmapped macro in this parameter.
    const missing = tokens.map(token => token.text).filter(token => !(token in mapping));
    if (missing.length > 0) {
      dropped_params.push(key);
      for (const m of missing) {
        if (!unmappedSeen.has(m)) {
          unmappedSeen.add(m);
          unmapped_macros.push(m);
        }
        if (isConsentMacro(m) && !consentSeen.has(m)) {
          consentSeen.add(m);
          dropped_consent_macros.push(m);
        }
      }
      continue;
    }

    // Render once, retaining the distinction between native syntax and data.
    const translated: RenderedSpan[] = [{ text: `${key}=` }];
    let cursor = 0;
    for (const match of tokens) {
      const token = match.text;
      translated.push({ text: value.slice(cursor, match.start) });
      const entry = mapping[token]!;
      if ('native' in entry) {
        translated.push({
          text: entry.native,
          ...(isVendorScopedConsentMacro(token) ? { scopedSource: token } : {}),
        });
      } else {
        translated.push({ text: encodeUnreserved(entry.value), concrete: true });
      }
      cursor = match.end;
    }
    translated.push({ text: value.slice(cursor) });
    outputParts.push(translated);
  }

  const querySpans = outputParts.flatMap((part, index) => (index === 0 ? part : [{ text: '&' }, ...part]));
  const hasQuery = querySpans.some(span => span.text.length > 0);
  const url = assertSingleScopedConsent(
    [{ text: base }, ...(hasQuery ? [{ text: '?' }, ...querySpans] : []), { text: fragment }],
    mapping
  );

  return {
    url,
    dropped_params,
    unmapped_macros,
    dropped_consent_macros,
    frozen_consent_macros,
    suspect_native_values,
  };
}
