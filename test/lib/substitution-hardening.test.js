/**
 * Regression tests locking in the hardening findings from PR #703 code
 * review + security review. Each test targets a specific attack class
 * that shipped as a defect in an earlier revision:
 *
 *   - HTML entity smuggling — `javascript&Tab;:alert(0)` hiding from extraction.
 *   - Tautological oracle — custom bindings using the library's own encoder
 *     as the expected value.
 *   - Payload exposure — custom raw_value / observed_value echoed verbatim
 *     in grader logs.
 *   - Nested-macro default pattern narrowness — lowercase / numeric-leading
 *     tokens slipping past `assertNoNestedExpansion`.
 *   - DNS pinning contract — `fetch_and_parse` must accept a caller-supplied
 *     dispatcher so graders can pin the request to a pre-validated IP.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  SubstitutionObserver,
  matchBindings,
  assertRfc3986Safe,
  assertNoNestedExpansion,
  DEFAULT_MACRO_PROHIBITED_PATTERN,
  extractTrackerUrls,
} = require('../../dist/lib/index.js');

describe('HTML entity smuggling — values with unknown entities are dropped', () => {
  it('decodes known entities like &Tab; so WHATWG URL sees the real scheme (javascript:)', () => {
    // Browsers decode `&Tab;` → `\t` inside attribute values, producing
    // `javascript\t:alert(0)` which WHATWG URL normalizes to
    // `javascript:alert(0)`. Our extractor must see the same thing so
    // `assert_scheme_preserved` catches the injection downstream.
    const html = `<a href="javascript&Tab;:alert(0)">click</a>`;
    const records = extractTrackerUrls(html);
    assert.equal(records.length, 1);
    assert.equal(records[0].url.protocol, 'javascript:');
  });

  it('drops values with unknown entity sequences rather than risk under-extraction', () => {
    // `&nonexistentEntity;` isn't in the decoder's table. A browser
    // decodes the HTML5 named-entity table (2200+ entries); we ship
    // a focused subset. Rather than silently under-extract, any
    // residual entity-shaped ampersand sequence is a signal to drop.
    const html = `<a href="javascript&nonexistentEntity;:alert(0)">click</a>`;
    const records = extractTrackerUrls(html);
    assert.equal(records.length, 0, 'undecodable entity must cause extractor to drop the value');
  });

  it('still extracts values carrying the five basic entities (&amp;, &lt;, etc.)', () => {
    const html = `<img src="https://track.example/imp?g=00013%26cmd&amp;x=1">`;
    const records = extractTrackerUrls(html);
    assert.equal(records.length, 1);
    // `&amp;` was decoded to `&`; no residual entity remains.
    assert.ok(records[0].url.href.includes('&x=1'));
  });

  it('extracts values that contain numeric character references', () => {
    // `&#37;` (hex/decimal) → `%`. The URL parses once decoded.
    const html = `<img src="https://track.example/imp?g=00013&#37;26cmd&#37;3Ddrop">`;
    const records = extractTrackerUrls(html);
    assert.equal(records.length, 1);
    assert.ok(records[0].url.href.includes('%26'));
  });

  it('decodes &colon; so a `javascript&colon;alert(0)` is seen as `javascript:alert(0)`', () => {
    // This is the critical case the hardening adds coverage for: a seller
    // using a known-dangerous entity gets decoded and classified as a
    // javascript:-scheme URL, which assert_scheme_preserved catches at
    // an href-whole-value binding.
    const html = `<a href="javascript&colon;alert(0)">click</a>`;
    const records = extractTrackerUrls(html);
    assert.equal(records.length, 1);
    assert.equal(records[0].url.protocol, 'javascript:');
  });
});

describe('custom bindings without expected_encoded are dropped (not silently graded)', () => {
  const observer = new SubstitutionObserver();

  it('returns no matches when a custom binding omits expected_encoded', () => {
    const records = observer.parse_html(`<img src="https://track.example/imp?g=whatever">`);
    const matches = observer.match_bindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', raw_value: 'seller-specific-value' }, // no vector_name, no expected_encoded
    ]);
    assert.equal(matches.length, 0, 'custom binding must supply expected_encoded explicitly');
  });

  it('accepts a custom binding with both raw_value AND expected_encoded', () => {
    const records = observer.parse_html(`<img src="https://track.example/imp?g=seller-specific-value">`);
    const matches = observer.match_bindings(records, 'https://track.example/imp?g={GTIN}', [
      {
        macro: '{GTIN}',
        raw_value: 'seller-specific-value',
        expected_encoded: 'seller-specific-value',
      },
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].is_custom_vector, true);
  });
});

describe('custom-vector payloads are SHA-256 redacted in error reports', () => {
  it('redacts observed/expected for failing custom bindings by default', () => {
    const records = [
      {
        url: new URL('https://track.example/imp?g=seller-value-DIVERGES'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      {
        macro: '{GTIN}',
        raw_value: 'seller-specific-value',
        expected_encoded: 'seller-specific-value',
      },
    ]);
    assert.equal(matches.length, 1);
    const r = assertRfc3986Safe(matches[0]);
    assert.equal(r.ok, false);
    // Redacted form: sha256:<64 hex chars>.
    assert.match(String(r.observed), /^sha256:[0-9a-f]{64}$/);
    assert.match(String(r.expected), /^sha256:[0-9a-f]{64}$/);
  });

  it('echoes payloads verbatim when include_raw_payloads is explicitly set', () => {
    const records = [
      {
        url: new URL('https://track.example/imp?g=observed-diverges'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      {
        macro: '{GTIN}',
        raw_value: 'seller-expected',
        expected_encoded: 'seller-expected',
      },
    ]);
    const r = assertRfc3986Safe(matches[0], { include_raw_payloads: true });
    assert.equal(r.ok, false);
    assert.equal(r.observed, 'observed-diverges');
    assert.equal(r.expected, 'seller-expected');
  });

  it('echoes payloads verbatim for canonical fixture vectors regardless of flag', () => {
    const records = [
      {
        url: new URL('https://track.example/imp?g=wrong-bytes'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', vector_name: 'reserved-character-breakout' },
    ]);
    const r = assertRfc3986Safe(matches[0]); // flag defaults to false
    assert.equal(r.ok, false);
    assert.equal(r.observed, 'wrong-bytes');
    assert.equal(r.expected, '00013%26cmd%3Ddrop');
  });

  it('sha256 digest matches a reference hash of the raw value', () => {
    const records = [
      {
        url: new URL('https://track.example/imp?g=abc'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', raw_value: 'xyz', expected_encoded: 'xyz' },
    ]);
    const r = assertRfc3986Safe(matches[0]);
    const expectedDigest = `sha256:${crypto.createHash('sha256').update('abc', 'utf8').digest('hex')}`;
    assert.equal(r.observed, expectedDigest);
  });
});

describe('assertNoNestedExpansion — default pattern covers any brace-delimited token', () => {
  it('flags a lowercase-leading token like {foo}', () => {
    const records = [
      {
        url: new URL('https://track.example/imp?g=value-{foo}-tail'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', raw_value: 'value-{foo}-tail', expected_encoded: 'value-%7Bfoo%7D-tail' },
    ]);
    assert.equal(matches.length, 1);
    const r = assertNoNestedExpansion(matches[0]);
    assert.equal(r.ok, false);
    assert.equal(r.error_code, 'nested_macro_re_expansion');
  });

  it('flags a numeric-leading token like {1FOO}', () => {
    const records = [
      {
        url: new URL('https://track.example/imp?g=x-{1FOO}-y'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', raw_value: 'x-{1FOO}-y', expected_encoded: 'x-%7B1FOO%7D-y' },
    ]);
    assert.equal(matches.length, 1);
    const r = assertNoNestedExpansion(matches[0]);
    assert.equal(r.ok, false);
  });

  it('respects a narrower pattern when the storyboard supplies one', () => {
    const narrow = /\{DEVICE_ID\}/;
    const records = [
      {
        url: new URL('https://track.example/imp?g=val-{foo}-tail'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', raw_value: 'val-{foo}-tail', expected_encoded: 'val-%7Bfoo%7D-tail' },
    ]);
    assert.equal(matches.length, 1);
    // With the narrow pattern, {foo} does not match → pass.
    assert.equal(assertNoNestedExpansion(matches[0], narrow).ok, true);
    // With the default pattern, {foo} does match → fail.
    assert.equal(assertNoNestedExpansion(matches[0]).ok, false);
  });

  it('DEFAULT_MACRO_PROHIBITED_PATTERN is the widened token regex', () => {
    assert.ok(DEFAULT_MACRO_PROHIBITED_PATTERN.test('{anything}'));
    assert.ok(DEFAULT_MACRO_PROHIBITED_PATTERN.test('{1FOO}'));
    assert.ok(!DEFAULT_MACRO_PROHIBITED_PATTERN.test('{}'));
    // Whitespace inside a brace pair is unusual enough to treat as non-macro.
    assert.ok(!DEFAULT_MACRO_PROHIBITED_PATTERN.test('{ spaced }'));
  });
});

describe('fetch_and_parse — dispatcher injection path preserves DNS pinning contract', () => {
  // We do not actually open a network socket here; this test just verifies
  // that the method accepts a caller-supplied dispatcher and does not
  // throw before reaching the inner call. The DNS-pinning behavior is
  // validated in unit coverage of enforceSsrfPolicyResolved + a future
  // integration test with a local HTTP server (follow-up).
  const observer = new SubstitutionObserver();

  it('rejects fetch when scheme is on the deny list (before any network work)', async () => {
    await assert.rejects(
      () => observer.fetch_and_parse(new URL('http://example.com/preview'), { dispatcher: {} }),
      err => err.name === 'PreviewFetchError' && err.sub_reason === 'ssrf_blocked'
    );
  });

  it('rejects fetch on bare IP literal under default (Verified) policy', async () => {
    await assert.rejects(
      () => observer.fetch_and_parse(new URL('https://192.0.2.1/preview'), { dispatcher: {} }),
      err => err.name === 'PreviewFetchError' && err.sub_reason === 'ssrf_blocked'
    );
  });
});
