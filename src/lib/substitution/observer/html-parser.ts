/**
 * Targeted HTML attribute extractor. Pulls tracker URLs from the
 * contract's normative tag/attribute set only — deliberately narrower
 * than a general-purpose HTML parser.
 *
 * The set (from `substitution-observer-runner.yaml`):
 *   a/href, img/src, img/srcset, iframe/src, source/src, source/srcset,
 *   link/href, meta/content, *\/data-impression-url, *\/data-click-url,
 *   *\/data-tracker-url, *\/data-vast-url
 *
 * Script text and HTML comments are ignored. `srcset` values are split
 * per-descriptor; every URL component is emitted.
 */

import type { TrackerUrlRecord } from '../types';

const SYNTHETIC_BASE = 'https://observer.test/';

const TAG_SPECIFIC_ATTRS: Record<string, readonly string[]> = {
  a: ['href'],
  img: ['src', 'srcset'],
  iframe: ['src'],
  source: ['src', 'srcset'],
  link: ['href'],
  meta: ['content'],
};

const WILDCARD_ATTRS: readonly string[] = [
  'data-impression-url',
  'data-click-url',
  'data-tracker-url',
  'data-vast-url',
];

const SRCSET_ATTRS = new Set(['srcset']);

interface AttrHit {
  tag: string;
  attr: string;
  value: string;
  line: number;
}

/**
 * Parse `html` and return every tracker URL in the normative extraction
 * set. URLs that fail WHATWG URL parsing (even after resolving against
 * `https://observer.test/`) are skipped — the runner asserts on
 * extractable URLs only.
 */
export function extractTrackerUrls(html: string): TrackerUrlRecord[] {
  const hits = findAttributeHits(html);
  const records: TrackerUrlRecord[] = [];
  for (const hit of hits) {
    const values = SRCSET_ATTRS.has(hit.attr) ? splitSrcset(hit.value) : [hit.value];
    for (const raw of values) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Defense against entity-smuggled URLs (`javascript&Tab;:...`):
      // we decode a known-safe set of named entities inside the attribute
      // value and drop any value whose remaining ampersand sequences
      // suggest an entity the decoder did not handle. A browser would
      // resolve the missing entity; we would not — and the divergence
      // is the exact gap the #2620 rule exists to close.
      if (__hasResidualEntity(trimmed)) continue;
      const parsed = tryParseUrl(trimmed);
      if (!parsed) continue;
      records.push({
        url: parsed,
        source_attr: hit.attr,
        source_tag: hit.tag,
        line_hint: hit.line,
      });
    }
  }
  return records;
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw, SYNTHETIC_BASE);
  } catch {
    return null;
  }
}

/**
 * `srcset` carries `URL [descriptor]` pairs separated by commas. The
 * descriptor is optional (`1x`, `2x`, `640w`, ...). Commas can appear
 * inside URLs only percent-encoded, so `,` splits are unambiguous.
 */
function splitSrcset(value: string): string[] {
  return value
    .split(',')
    .map(part => part.trim().split(/\s+/)[0] ?? '')
    .filter(u => u.length > 0);
}

/**
 * Walk `html` as a simple state machine, skipping comments, CDATA,
 * <script>, and <style>. Emit one hit per matching attribute.
 */
function findAttributeHits(html: string): AttrHit[] {
  const hits: AttrHit[] = [];
  const len = html.length;
  let i = 0;
  let line = 1;

  const advance = (to: number): void => {
    for (let k = i; k < to && k < len; k++) {
      if (html.charCodeAt(k) === 0x0a) line += 1;
    }
    i = to;
  };

  while (i < len) {
    const c = html.charCodeAt(i);
    if (c === 0x0a) {
      line += 1;
      i += 1;
      continue;
    }
    if (c !== 0x3c /* < */) {
      i += 1;
      continue;
    }

    // Comment <!-- ... -->
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end === -1) break;
      advance(end + 3);
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      if (end === -1) break;
      advance(end + 3);
      continue;
    }

    // DOCTYPE / XML decl — ignore up to first '>'
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i + 2);
      if (end === -1) break;
      advance(end + 1);
      continue;
    }

    // Closing tag </foo>
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i + 2);
      if (end === -1) break;
      advance(end + 1);
      continue;
    }

    // Only opening / self-closing tags remain. Parse tag name.
    const tagMatch = /^[A-Za-z][A-Za-z0-9:_-]*/.exec(html.slice(i + 1));
    if (!tagMatch) {
      i += 1;
      continue;
    }
    const tag = tagMatch[0].toLowerCase();
    const tagEnd = findTagEnd(html, i);
    if (tagEnd === -1) break;
    const tagStartLine = line;
    const tagBody = html.slice(i + 1 + tag.length, tagEnd);

    // <script>/<style>: skip until the matching close tag. Content
    // is ignored per the contract (script_text_content: ignored).
    if (tag === 'script' || tag === 'style') {
      advance(tagEnd + 1);
      const closeRegex = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRegex.exec(rest);
      if (!m) break;
      advance(i + m.index + m[0].length);
      continue;
    }

    collectAttributes(tagBody, tag, tagStartLine, hits);
    advance(tagEnd + 1);
  }

  return hits;
}

/**
 * Return the offset (relative to `html`) of the closing `>` that ends
 * the opening-tag token starting at `start`. Handles quoted attribute
 * values so a `>` inside an attribute doesn't close the tag early.
 */
function findTagEnd(html: string, start: number): number {
  const len = html.length;
  let k = start + 1;
  let quote: number | null = null;
  while (k < len) {
    const ch = html.charCodeAt(k);
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else {
      if (ch === 0x22 /* " */ || ch === 0x27 /* ' */) {
        quote = ch;
      } else if (ch === 0x3e /* > */) {
        return k;
      }
    }
    k += 1;
  }
  return -1;
}

const ATTR_REGEX = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

function collectAttributes(body: string, tag: string, line: number, out: AttrHit[]): void {
  const tagAttrs = TAG_SPECIFIC_ATTRS[tag] ?? [];
  ATTR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_REGEX.exec(body)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    const isTagAttr = tagAttrs.includes(name);
    const isWildcard = WILDCARD_ATTRS.includes(name);
    if (!isTagAttr && !isWildcard) continue;
    out.push({ tag, attr: name, value: decodeHtmlEntities(value), line });
  }
}

/**
 * Entities that browsers decode inside attribute values and that a
 * seller could weaponize to smuggle a javascript:-scheme URL past a
 * naive extractor. The set covers:
 *
 *   - The five basic entities (`&amp; &lt; &gt; &quot; &apos;`) that
 *     every HTML consumer handles.
 *   - Whitespace / control entities that let a colon or scheme prefix
 *     hide: `&Tab;`, `&NewLine;`, `&nbsp;`, variants of newlines.
 *   - Punctuation that appears in URL scheme injection or reserved-
 *     char breakout: `&colon;`, `&sol;`, `&lpar;`, `&rpar;`, `&lbrace;`,
 *     `&rbrace;`.
 *
 * This is NOT the full HTML5 named-character-reference table (~2200
 * entries). The decoder additionally post-filters: if the value still
 * contains an ampersand followed by a letter after decoding, it is
 * treated as undecodable and the URL is dropped — refusing to classify
 * rather than risking under-extraction.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Whitespace / control — used in URL-scheme smuggling.
  Tab: '\t',
  tab: '\t',
  NewLine: '\n',
  newline: '\n',
  nbsp: '\u00A0',
  NonBreakingSpace: '\u00A0',
  // Punctuation entities browsers decode.
  colon: ':',
  sol: '/',
  bsol: '\\',
  lpar: '(',
  rpar: ')',
  lbrace: '{',
  rbrace: '}',
  lsqb: '[',
  rsqb: ']',
  period: '.',
  comma: ',',
  semi: ';',
  excl: '!',
  quest: '?',
  equals: '=',
  num: '#',
  dollar: '$',
  commat: '@',
  percnt: '%',
};

/**
 * Detects an ampersand followed by alphanumeric entity-shaped text.
 * After decoding, any remaining occurrence signals an entity the
 * limited table above did not cover — callers should drop the value
 * rather than extract a partially-decoded URL.
 */
const RESIDUAL_ENTITY_RE = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[xX]?[0-9A-Fa-f]+);?/;

function decodeHtmlEntities(s: string): string {
  return (
    s
      .replace(/&#[xX]([0-9A-Fa-f]+);?/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);?/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
      // Semicolon is optional per HTML5 for legacy entities; match both.
      .replace(/&([A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, name: string) => {
        const hit = NAMED_ENTITIES[name];
        return hit ?? whole;
      })
  );
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '\uFFFD';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '\uFFFD';
  }
}

/**
 * True if the decoded value still contains an entity-shaped ampersand
 * sequence (named or numeric) — a signal that browser-visible content
 * may differ from what we extracted. The caller discards such values
 * to avoid under-extraction of a smuggled javascript:-scheme URL.
 */
export function __hasResidualEntity(decoded: string): boolean {
  return RESIDUAL_ENTITY_RE.test(decoded);
}
