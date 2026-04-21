/**
 * Canonical catalog-item macro substitution vectors.
 *
 * Mirrors `static/test-vectors/catalog-macro-substitution.json` in the
 * upstream AdCP repo at the schema version this client targets. The
 * fixture is the source of truth for `raw_value` and `expected_encoded`
 * — these constants are synchronized copies so the library can be used
 * without filesystem side effects (works in browser bundles, avoids
 * shipping a JSON file through the tsc pipeline).
 *
 * The companion JSON at `fixtures/catalog-macro-substitution.json` is
 * byte-equal to the upstream fixture and is tested for parity.
 */

import type { CatalogMacroVector } from './types';

export type CatalogMacroVectorName =
  | 'reserved-character-breakout'
  | 'nested-expansion-preserved-as-literal'
  | 'crlf-injection-neutralized'
  | 'non-ascii-utf8-percent-encoding'
  | 'mixed-path-and-query-contexts'
  | 'bidi-override-neutralized'
  | 'url-scheme-injection-neutralized';

export const CATALOG_MACRO_VECTORS: readonly CatalogMacroVector[] = Object.freeze([
  Object.freeze({
    name: 'reserved-character-breakout',
    description:
      'A catalog value containing `&` and `=` would break out of the surrounding query string if substituted raw. Percent-encoding neutralizes the breakout.',
    macro: '{GTIN}',
    value: '00013&cmd=drop',
    template: 'https://track.example/imp?g={GTIN}',
    expected: 'https://track.example/imp?g=00013%26cmd%3Ddrop',
  }),
  Object.freeze({
    name: 'nested-expansion-preserved-as-literal',
    description:
      'A catalog value containing AdCP macro syntax `{DEVICE_ID}` MUST NOT be re-expanded. The braces are percent-encoded; the inner token survives as a literal.',
    macro: '{JOB_ID}',
    value: 'vacancy-{DEVICE_ID}-42',
    template: 'https://track.example/click?j={JOB_ID}',
    expected: 'https://track.example/click?j=vacancy-%7BDEVICE_ID%7D-42',
  }),
  Object.freeze({
    name: 'crlf-injection-neutralized',
    description:
      'A catalog value containing CR/LF would enable request-header smuggling or log-row injection in downstream consumers. The unreserved-whitelist rule escapes both bytes, defeating the vector.',
    macro: '{SKU}',
    value: 'abc\r\nHost: evil.example',
    template: 'https://track.example/imp?s={SKU}',
    expected: 'https://track.example/imp?s=abc%0D%0AHost%3A%20evil.example',
  }),
  Object.freeze({
    name: 'non-ascii-utf8-percent-encoding',
    description:
      'Non-ASCII octets MUST be percent-encoded after UTF-8 encoding per RFC 3986 §2.5. A value containing `café` emits `%C3%A9` for the `é`.',
    macro: '{STORE_ID}',
    value: 'café-amsterdam',
    template: 'https://track.example/imp?s={STORE_ID}',
    expected: 'https://track.example/imp?s=caf%C3%A9-amsterdam',
  }),
  Object.freeze({
    name: 'mixed-path-and-query-contexts',
    description: 'Verifies encoding applies equally to path segments and query strings within the same URL.',
    macro: '{CATALOG_ID}',
    value: 'gmc/primary feed',
    template: 'https://track.example/catalog/{CATALOG_ID}/ping?cid={CATALOG_ID}',
    expected: 'https://track.example/catalog/gmc%2Fprimary%20feed/ping?cid=gmc%2Fprimary%20feed',
  }),
  Object.freeze({
    name: 'bidi-override-neutralized',
    description:
      'Unicode bidi override characters (U+202E, U+2066-U+2069) in catalog values can spoof audit-log rendering. The unreserved-whitelist rule percent-encodes them as their UTF-8 bytes.',
    macro: '{VEHICLE_ID}',
    value: 'VIN-\u202E1234',
    template: 'https://track.example/imp?v={VEHICLE_ID}',
    expected: 'https://track.example/imp?v=VIN-%E2%80%AE1234',
  }),
  Object.freeze({
    name: 'url-scheme-injection-neutralized',
    description:
      'A catalog value containing `javascript:alert(0)` substituted into an href-whole-value position (e.g., `<a href="{CLICK}">`) would otherwise execute as a javascript: scheme URL. The strict unreserved-whitelist rule percent-encodes the colon and parens so the browser parses the result as a relative URL against the base, neutralizing the injection. Parentheses `(` and `)` are NOT in RFC 3986 `unreserved` (they are sub-delims), so the strict rule encodes them — encodeURIComponent-based encoders that leave parens alone FAIL this vector, which is how the runtime observer (#2638) distinguishes strict-RFC-3986 encoders from permissive ones.',
    macro: '{CLICK}',
    value: 'javascript:alert(0)',
    template: 'https://track.example/go?c={CLICK}',
    expected: 'https://track.example/go?c=javascript%3Aalert%280%29',
  }),
]);

export function getCatalogMacroVector(name: CatalogMacroVectorName | string): CatalogMacroVector | undefined {
  return CATALOG_MACRO_VECTORS.find(v => v.name === name);
}
