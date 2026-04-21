const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SubstitutionObserver,
  CATALOG_MACRO_VECTORS,
  extractTrackerUrls,
  matchBindings,
  assertRfc3986Safe,
  assertNoNestedExpansion,
  assertSchemePreserved,
  assertUnreservedOnly,
} = require('../../dist/lib/index.js');

describe('SubstitutionObserver — parse_html', () => {
  const observer = new SubstitutionObserver();

  it('extracts tracker URLs from the normative attribute set', () => {
    const html = `
      <html><body>
        <a href="https://a.example/click">click</a>
        <img src="https://b.example/imp.png">
        <iframe src="https://c.example/frame"></iframe>
        <link rel="canonical" href="https://d.example/canonical">
        <meta http-equiv="refresh" content="0;url=https://e.example/redirect">
        <div data-impression-url="https://f.example/dimp"></div>
        <span data-click-url="https://g.example/dclick"></span>
      </body></html>
    `;
    const records = observer.parse_html(html);
    const urls = records.map(r => r.url.href);
    assert.ok(urls.some(u => u === 'https://a.example/click'));
    assert.ok(urls.some(u => u === 'https://b.example/imp.png'));
    assert.ok(urls.some(u => u === 'https://c.example/frame'));
    assert.ok(urls.some(u => u === 'https://d.example/canonical'));
    assert.ok(urls.some(u => u.includes('e.example/redirect')));
    assert.ok(urls.some(u => u === 'https://f.example/dimp'));
    assert.ok(urls.some(u => u === 'https://g.example/dclick'));
  });

  it('splits srcset into per-descriptor URLs', () => {
    const html = `<img srcset="https://a.example/1.png 1x, https://a.example/2.png 2x">`;
    const records = observer.parse_html(html);
    const urls = records.map(r => r.url.href).sort();
    assert.deepEqual(urls, ['https://a.example/1.png', 'https://a.example/2.png']);
  });

  it('ignores <script> body content', () => {
    const html = `
      <script>document.write('<img src="https://hidden.example/x">');</script>
      <img src="https://visible.example/y">
    `;
    const records = observer.parse_html(html);
    const urls = records.map(r => r.url.href);
    assert.deepEqual(urls, ['https://visible.example/y']);
  });

  it('ignores HTML comments', () => {
    const html = `
      <!-- <img src="https://commented.example/x"> -->
      <img src="https://real.example/y">
    `;
    const records = observer.parse_html(html);
    assert.deepEqual(
      records.map(r => r.url.href),
      ['https://real.example/y']
    );
  });

  it('ignores non-whitelisted data-* attributes', () => {
    const html = `<div data-extra-url="https://arbitrary.example/x" data-tracker-url="https://real.example/y">`;
    const records = observer.parse_html(html);
    assert.deepEqual(
      records.map(r => r.url.href),
      ['https://real.example/y']
    );
  });

  it('exports extractTrackerUrls as a standalone function', () => {
    const records = extractTrackerUrls(`<img src="https://x.example/a">`);
    assert.equal(records.length, 1);
    assert.equal(records[0].source_tag, 'img');
    assert.equal(records[0].source_attr, 'src');
  });
});

describe('SubstitutionObserver — match_bindings + assert_rfc3986_safe (7 fixture vectors)', () => {
  const observer = new SubstitutionObserver();

  for (const vector of CATALOG_MACRO_VECTORS) {
    it(`grades ${vector.name} as pass when the seller emits the fixture-expected URL`, () => {
      const html = `<img src="${vector.expected}">`;
      const records = observer.parse_html(html);
      const matches = observer.match_bindings(records, vector.template, [
        { macro: vector.macro, vector_name: vector.name },
      ]);
      assert.ok(matches.length > 0, `expected at least one match for ${vector.name}`);
      const result = observer.assert_rfc3986_safe(matches[0]);
      assert.ok(result.ok, `expected pass, got ${JSON.stringify(result)}`);
    });
  }

  it('flags a seller that uses encodeURIComponent (sub-delims left raw)', () => {
    // encodeURIComponent leaves `( ) !` alone — fails the
    // url-scheme-injection-neutralized vector.
    const vector = CATALOG_MACRO_VECTORS.find(v => v.name === 'url-scheme-injection-neutralized');
    const permissive = encodeURIComponent(vector.value); // leaves ( and )
    const url = vector.template.replace(vector.macro, permissive);
    const html = `<img src="${url}">`;
    const records = observer.parse_html(html);
    const matches = observer.match_bindings(records, vector.template, [
      { macro: vector.macro, vector_name: vector.name },
    ]);
    assert.ok(matches.length > 0);
    const result = observer.assert_rfc3986_safe(matches[0]);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'substitution_encoding_violation');
    assert.ok(typeof result.byte_offset === 'number' && result.byte_offset >= 0);
  });

  it('uses case-insensitive hex comparison inside %NN triplets', () => {
    // Producer emits lowercase hex; the contract says verifiers MUST accept.
    const url = 'https://track.example/imp?g=00013%26cmd%3ddrop'; // lowercase '%3d' + lowercase hex 'd'
    const records = observer.parse_html(`<img src="${url}">`);
    const matches = matchBindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', vector_name: 'reserved-character-breakout' },
    ]);
    assert.ok(matches.length > 0);
    const result = assertRfc3986Safe(matches[0]);
    assert.ok(result.ok, `case-insensitive hex comparison must accept lowercase triplets`);
  });

  it('match_bindings returns no matches when the template macro is absent', () => {
    const matches = matchBindings(
      [{ url: new URL('https://track.example/imp?g=00013'), source_attr: 'src', source_tag: 'img', line_hint: null }],
      'https://track.example/imp?g={GTIN}',
      [{ macro: '{MISSING_MACRO}', vector_name: 'reserved-character-breakout' }]
    );
    assert.equal(matches.length, 0);
  });
});

describe('SubstitutionObserver — assert_no_nested_expansion', () => {
  const observer = new SubstitutionObserver();

  it('passes when braces are percent-encoded (fixture vector)', () => {
    const vector = CATALOG_MACRO_VECTORS.find(v => v.name === 'nested-expansion-preserved-as-literal');
    const html = `<img src="${vector.expected}">`;
    const matches = observer.match_bindings(observer.parse_html(html), vector.template, [
      { macro: vector.macro, vector_name: vector.name },
    ]);
    const r = assertNoNestedExpansion(matches[0]);
    assert.ok(r.ok);
  });

  it('flags a seller that left the nested macro unescaped', () => {
    // Simulate a broken encoder that leaves braces raw — the observed
    // value would then be a literal `{DEVICE_ID}` token.
    const broken = 'https://track.example/click?j=vacancy-{DEVICE_ID}-42';
    const records = [
      {
        url: new URL(broken),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
    ];
    const matches = matchBindings(records, 'https://track.example/click?j={JOB_ID}', [
      { macro: '{JOB_ID}', vector_name: 'nested-expansion-preserved-as-literal' },
    ]);
    assert.ok(matches.length > 0, `alignment produced a match`);
    const r = assertNoNestedExpansion(matches[0]);
    assert.equal(r.ok, false);
    assert.equal(r.error_code, 'nested_macro_re_expansion');
  });
});

describe('SubstitutionObserver — assert_scheme_preserved', () => {
  it('passes for non-whole-value bindings regardless of scheme', () => {
    const record = {
      url: new URL('https://track.example/go?c=javascript%3Aalert'),
      source_attr: 'src',
      source_tag: 'img',
      line_hint: null,
    };
    const match = {
      binding: { macro: '{CLICK}', vector_name: 'url-scheme-injection-neutralized' },
      raw_value: 'javascript:alert(0)',
      expected_encoded: 'javascript%3Aalert%280%29',
      observed_url: record.url,
      record,
      position: { kind: 'query', key: 'c', index: 0 },
      observed_value: 'javascript%3Aalert%280%29',
    };
    assert.ok(assertSchemePreserved(match, 'https').ok);
  });

  it('fails when the href-whole-value binding changed the scheme', () => {
    const record = { url: new URL('javascript:alert(0)'), source_attr: 'href', source_tag: 'a', line_hint: null };
    const match = {
      binding: { macro: '{CLICK}' },
      raw_value: 'javascript:alert(0)',
      expected_encoded: 'javascript%3Aalert%280%29',
      observed_url: record.url,
      record,
      position: { kind: 'href_whole_value' },
      observed_value: 'javascript:alert(0)',
    };
    const r = assertSchemePreserved(match, 'https');
    assert.equal(r.ok, false);
    assert.equal(r.error_code, 'substitution_scheme_injection');
  });
});

describe('SubstitutionObserver — assert_unreserved_only', () => {
  it('passes for fixture-conformant bytes', () => {
    const vector = CATALOG_MACRO_VECTORS.find(v => v.name === 'url-scheme-injection-neutralized');
    const match = {
      binding: { macro: vector.macro, vector_name: vector.name },
      raw_value: vector.value,
      expected_encoded: 'javascript%3Aalert%280%29',
      observed_url: new URL(vector.expected),
      record: { url: new URL(vector.expected), source_attr: 'src', source_tag: 'img', line_hint: null },
      position: { kind: 'query', key: 'c', index: 0 },
      observed_value: 'javascript%3Aalert%280%29',
    };
    assert.ok(assertUnreservedOnly(match).ok);
  });

  it('fails for raw parens (encodeURIComponent output)', () => {
    const match = {
      binding: { macro: '{CLICK}' },
      raw_value: 'alert(0)',
      expected_encoded: 'alert%280%29',
      observed_url: new URL('https://track.example/go?c=alert(0)'),
      record: {
        url: new URL('https://track.example/go?c=alert(0)'),
        source_attr: 'src',
        source_tag: 'img',
        line_hint: null,
      },
      position: { kind: 'query', key: 'c', index: 0 },
      observed_value: 'alert(0)',
    };
    const r = assertUnreservedOnly(match);
    assert.equal(r.ok, false);
    assert.equal(r.error_code, 'substitution_encoding_violation');
  });
});
