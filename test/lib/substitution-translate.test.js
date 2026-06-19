const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { universal_macro_translation } = require('../../dist/lib/index.js');

describe('universal_macro_translation — query-string macro substitution', () => {
  // ─── native insertion ────────────────────────────────────────────────────

  it('inserts a native macro raw (not percent-encoded)', () => {
    const result = universal_macro_translation('https://px.example/i?gdpr={GDPR}', {
      '{GDPR}': { native: '%%GDPR%%' },
    });
    assert.equal(result.url, 'https://px.example/i?gdpr=%%GDPR%%');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── value insertion ─────────────────────────────────────────────────────

  it('percent-encodes a value macro per RFC 3986 unreserved whitelist', () => {
    const result = universal_macro_translation('https://px.example/i?mb={MEDIA_BUY_ID}', {
      '{MEDIA_BUY_ID}': { value: 'a&b=c' },
    });
    assert.equal(result.url, 'https://px.example/i?mb=a%26b%3Dc');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── literal param untouched ─────────────────────────────────────────────

  it('leaves an already-minted literal param unchanged and substitutes the other', () => {
    const result = universal_macro_translation('https://px.example/i?pkg_id=123456&mb={MEDIA_BUY_ID}', {
      '{MEDIA_BUY_ID}': { value: 'buy-42' },
    });
    assert.equal(result.url, 'https://px.example/i?pkg_id=123456&mb=buy-42');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── unmapped macro drops the whole param ────────────────────────────────

  it('drops a param whose macro is not in the mapping', () => {
    const result = universal_macro_translation('https://px.example/i?mb={MEDIA_BUY_ID}&foo={UNSUPPORTED}', {
      '{MEDIA_BUY_ID}': { value: 'buy-42' },
    });
    assert.equal(result.url, 'https://px.example/i?mb=buy-42');
    assert.deepEqual(result.dropped_params, ['foo']);
    assert.deepEqual(result.unmapped_macros, ['{UNSUPPORTED}']);
  });

  // ─── mixed param with one unmapped macro dropped whole ───────────────────

  it('drops a param that contains even one unmapped macro', () => {
    const result = universal_macro_translation('https://px.example/i?ids={MEDIA_BUY_ID}-{UNSUPPORTED}', {
      '{MEDIA_BUY_ID}': { value: 'buy-42' },
    });
    assert.equal(result.url, 'https://px.example/i');
    assert.deepEqual(result.dropped_params, ['ids']);
    assert.deepEqual(result.unmapped_macros, ['{UNSUPPORTED}']);
  });

  // ─── no nested re-expansion ──────────────────────────────────────────────

  it('does not re-expand macros that appear inside a substituted value', () => {
    // {MEDIA_BUY_ID} maps to a value containing {GDPR} — that inner token must
    // be encoded as data, not treated as a macro.
    const result = universal_macro_translation('https://px.example/i?mb={MEDIA_BUY_ID}', {
      '{MEDIA_BUY_ID}': { value: 'has-{GDPR}-inside' },
      '{GDPR}': { native: '%%GDPR%%' },
    });
    // {GDPR} inside the value is encoded; the braces → %7B / %7D
    assert.equal(result.url, 'https://px.example/i?mb=has-%7BGDPR%7D-inside');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── no query string ─────────────────────────────────────────────────────

  it('returns the URL unchanged when there is no query string', () => {
    const url = 'https://px.example/i';
    const result = universal_macro_translation(url, { '{GDPR}': { native: '%%GDPR%%' } });
    assert.equal(result.url, url);
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── multiple macros in one param ────────────────────────────────────────

  it('translates multiple mapped macros within a single param in one pass', () => {
    const result = universal_macro_translation('https://px.example/i?ids={MEDIA_BUY_ID}_{GDPR}', {
      '{MEDIA_BUY_ID}': { value: 'buy-42' },
      '{GDPR}': { native: '%%GDPR%%' },
    });
    assert.equal(result.url, 'https://px.example/i?ids=buy-42_%%GDPR%%');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── base / path / fragment pass through ────────────────────────────────

  it('preserves scheme, host, path, and fragment verbatim', () => {
    const result = universal_macro_translation('https://px.example/path/segment?q={GDPR}#anchor', {
      '{GDPR}': { native: '%%GDPR%%' },
    });
    assert.equal(result.url, 'https://px.example/path/segment?q=%%GDPR%%#anchor');
  });

  // ─── non-universal tokens not matched ────────────────────────────────────

  it('does not treat native ad-server tokens (%%X%%) as universal macros', () => {
    const result = universal_macro_translation('https://px.example/i?gdpr=%%GDPR%%', {
      '{GDPR}': { native: '%%GDPR%%' },
    });
    // no universal macro present → param is literal, left untouched
    assert.equal(result.url, 'https://px.example/i?gdpr=%%GDPR%%');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  it('does not treat double-brace tokens ({{x}}) as universal macros', () => {
    const result = universal_macro_translation('https://px.example/i?t={{timestamp}}', {});
    assert.equal(result.url, 'https://px.example/i?t={{timestamp}}');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── empty query-param value ─────────────────────────────────────────────

  it('leaves a param with an empty value untouched', () => {
    const result = universal_macro_translation('https://px.example/i?k=', {});
    assert.equal(result.url, 'https://px.example/i?k=');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── macro token in KEY position is ignored ──────────────────────────────

  it('does not substitute, drop, or flag a macro token appearing in a key position', () => {
    // Matching runs on values only; a {MACRO} in the key must pass through raw.
    const result = universal_macro_translation('https://px.example/i?{MEDIA_BUY_ID}=v', {
      '{MEDIA_BUY_ID}': { value: 'buy-42' },
    });
    assert.equal(result.url, 'https://px.example/i?{MEDIA_BUY_ID}=v');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });

  // ─── non-ASCII value is UTF-8 percent-encoded ────────────────────────────

  it('percent-encodes non-ASCII characters in a substituted value (UTF-8)', () => {
    const result = universal_macro_translation('https://px.example/i?s={STORE_ID}', {
      '{STORE_ID}': { value: 'café' },
    });
    assert.equal(result.url, 'https://px.example/i?s=caf%C3%A9');
    assert.deepEqual(result.dropped_params, []);
    assert.deepEqual(result.unmapped_macros, []);
  });
});
