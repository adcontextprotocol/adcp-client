/**
 * Macro-position alignment: map each observed tracker URL back to the
 * template position its macro occupied, so the verifier can compare
 * observed bytes against the expected encoding at exactly that slot.
 *
 * Implements the normative algorithm from the test-kit contract:
 *
 *   1. Tokenize the template from its raw string so literal AdCP macros
 *      (`{SKU}`) survive — WHATWG URL percent-encodes `{` in paths, which
 *      would mask the macro position.
 *   2. Parse observed URLs with WHATWG URL (they are properly encoded).
 *   3. Align observed query pairs by decoded key (positionally among
 *      pairs sharing the same key); align path segments positionally.
 *   4. Emit BindingMatch entries the verifier can assert on.
 */

import type { BindingMatch, CatalogBinding, CatalogMacroVector, TrackerUrlRecord } from '../types';
import { encodeUnreserved } from '../rfc3986';
import { getCatalogMacroVector } from '../vectors';

interface ParsedQueryPair {
  /** Decoded key per WHATWG URLSearchParams semantics. */
  key: string;
  /** Raw value as it appears in the query string (pre-decode). */
  raw_value: string;
  /** Ordinal position in the original query string (0-indexed). */
  index: number;
}

interface TemplateLayout {
  origin: string;
  path_segments: string[];
  query_pairs: ParsedQueryPair[];
  href: string;
}

interface ObservedLayout {
  url: URL;
  path_segments: string[];
  query_pairs: ParsedQueryPair[];
  href: string;
}

const MACRO_SEGMENT_RE = /\{[A-Z][A-Z0-9_]*\}/;

/**
 * Resolve the fixture vector or inline overrides for a binding. The
 * `expected_encoded` field is the per-position encoded substring
 * (e.g., `00013%26cmd%3Ddrop`), NOT the full fixture URL. Without a
 * resolvable raw_value, the binding is dropped — callers surface
 * missing bindings as `substitution_binding_missing`.
 */
function resolveBinding(binding: CatalogBinding): { raw_value: string; expected_encoded: string } | null {
  let vector: CatalogMacroVector | undefined;
  if (binding.vector_name) vector = getCatalogMacroVector(binding.vector_name);
  const raw_value = binding.raw_value ?? vector?.value;
  if (raw_value === undefined) return null;
  const expected_encoded = binding.expected_encoded ?? encodeUnreserved(raw_value);
  return { raw_value, expected_encoded };
}

/**
 * Match each observed record to the template positions its bindings
 * occupy. A binding may match multiple records when the observed
 * preview contains repetitions (e.g., impression + click pixels
 * sharing a SKU).
 */
export function matchBindings(
  records: readonly TrackerUrlRecord[],
  template: URL | string,
  bindings: readonly CatalogBinding[]
): BindingMatch[] {
  const templateLayout = parseTemplate(template);
  const matches: BindingMatch[] = [];

  for (const binding of bindings) {
    const resolved = resolveBinding(binding);
    if (!resolved) continue;

    const positions = findMacroPositions(templateLayout, binding.macro);
    if (positions.length === 0) continue;

    for (const record of sameTemplateRecords(records, templateLayout)) {
      const observed = parseObserved(record.url);
      for (const position of positions) {
        const observed_value = resolveObservedValue(observed, position);
        if (observed_value === null) continue;
        matches.push({
          binding,
          raw_value: resolved.raw_value,
          expected_encoded: resolved.expected_encoded,
          observed_url: record.url,
          record,
          position,
          observed_value,
        });
      }
    }
  }

  return matches;
}

/**
 * Tokenize a template from its raw string. Preserves literal `{MACRO}`
 * sequences in path and query. Throws if the template is not an
 * absolute URL.
 */
function parseTemplate(template: URL | string): TemplateLayout {
  const raw = typeof template === 'string' ? template : template.href;
  const m = /^([a-z][a-z0-9+.\-]*:\/\/[^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!m) throw new Error(`Template is not an absolute URL: ${raw}`);
  const origin = m[1] ?? '';
  const path = m[2] ?? '';
  const search = (m[3] ?? '').replace(/^\?/, '');

  const path_segments = path === '' || path === '/' ? [] : path.replace(/^\//, '').split('/');

  const query_pairs: ParsedQueryPair[] = search
    ? search.split('&').map((segment, index) => {
        const eq = segment.indexOf('=');
        const keyRaw = eq === -1 ? segment : segment.slice(0, eq);
        const valueRaw = eq === -1 ? '' : segment.slice(eq + 1);
        return { key: safeDecode(keyRaw), raw_value: valueRaw, index };
      })
    : [];

  // Origin reported as WHATWG URL's `origin` shape so comparison with
  // observed URLs (which are WHATWG-parsed) is apples-to-apples.
  const normalizedOrigin = normalizeOrigin(origin);

  return {
    origin: normalizedOrigin,
    path_segments,
    query_pairs,
    href: raw,
  };
}

function normalizeOrigin(scheme_and_authority: string): string {
  // Handle `scheme://authority` form.
  try {
    const u = new URL(scheme_and_authority + '/');
    return u.origin;
  } catch {
    return scheme_and_authority;
  }
}

function parseObserved(url: URL): ObservedLayout {
  const path_segments = url.pathname === '/' ? [] : url.pathname.replace(/^\//, '').split('/');
  const rawSearch = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const query_pairs: ParsedQueryPair[] = rawSearch
    ? rawSearch.split('&').map((segment, index) => {
        const eq = segment.indexOf('=');
        const keyRaw = eq === -1 ? segment : segment.slice(0, eq);
        const valueRaw = eq === -1 ? '' : segment.slice(eq + 1);
        return { key: safeDecode(keyRaw), raw_value: valueRaw, index };
      })
    : [];
  return { url, path_segments, query_pairs, href: url.href };
}

/**
 * Narrow observed records to those that could plausibly be substituted
 * forms of `template`: same origin, same number of path segments,
 * literal segments matching where the template has no macro, and every
 * template query key present in the observed URL.
 */
function sameTemplateRecords(records: readonly TrackerUrlRecord[], template: TemplateLayout): TrackerUrlRecord[] {
  const templateKeys = new Set(template.query_pairs.map(p => p.key));
  const templateSegCount = template.path_segments.length;
  return records.filter(r => {
    if (r.url.origin !== template.origin) return false;
    const observed = parseObserved(r.url);
    if (observed.path_segments.length !== templateSegCount) return false;
    for (let i = 0; i < templateSegCount; i++) {
      const seg = template.path_segments[i] ?? '';
      const obs = observed.path_segments[i] ?? '';
      if (!MACRO_SEGMENT_RE.test(seg) && seg !== obs) return false;
    }
    for (const key of templateKeys) {
      if (!observed.query_pairs.some(p => p.key === key)) return false;
    }
    return true;
  });
}

/**
 * Find the template positions where `macro` appears. Whole-value
 * matches win first (rare; legal for `<a href="{CLICK}">`). Otherwise
 * emit every query-value and path-segment match in scan order.
 */
function findMacroPositions(layout: TemplateLayout, macro: string): BindingMatch['position'][] {
  const out: BindingMatch['position'][] = [];

  if (layout.href === macro) {
    out.push({ kind: 'href_whole_value' });
  }

  for (const pair of layout.query_pairs) {
    if (pair.raw_value === macro) {
      out.push({ kind: 'query', key: pair.key, index: pair.index });
    }
  }

  layout.path_segments.forEach((seg, index) => {
    if (seg === macro) {
      out.push({ kind: 'path', index });
    }
  });

  return out;
}

function resolveObservedValue(layout: ObservedLayout, position: BindingMatch['position']): string | null {
  if (position.kind === 'href_whole_value') {
    return layout.href;
  }
  if (position.kind === 'path') {
    return layout.path_segments[position.index] ?? null;
  }
  const matching = layout.query_pairs.filter(p => p.key === position.key);
  return matching[0]?.raw_value ?? null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}
