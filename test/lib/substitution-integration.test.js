/**
 * End-to-end fixture-agent integration. Simulates a runner consuming
 * preview_html from an agent under test: the fixture agent "emits"
 * a preview HTML using SubstitutionEncoder (the seller-side surface);
 * a runner instance of SubstitutionObserver grades the output. Pass
 * = encoder and observer share one RFC 3986 implementation, as the
 * contract requires.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SubstitutionEncoder,
  SubstitutionObserver,
  CATALOG_MACRO_VECTORS,
  extractTrackerUrls,
} = require('../../dist/lib/index.js');

/** A minimal fixture agent that emits a preview containing one tracker
 *  URL per declared vector binding. Uses SubstitutionEncoder — the
 *  exact code path production sellers use.
 */
function fixtureAgentEmitPreview(bindings) {
  const encoder = new SubstitutionEncoder();
  const lines = [];
  for (const b of bindings) {
    const encoded = encoder.encode_for_url_context(b.raw_value);
    const url = b.template.split(b.macro).join(encoded);
    lines.push(`  <img src="${url}" alt="${b.vector_name}">`);
  }
  return `<!DOCTYPE html><html><head><title>Preview</title></head><body>
${lines.join('\n')}
</body></html>`;
}

describe('fixture agent + observer integration — all 7 vectors', () => {
  it('observer grades every vector as pass (one preview per binding, as storyboards invoke)', () => {
    const observer = new SubstitutionObserver();

    for (const vector of CATALOG_MACRO_VECTORS) {
      const binding = {
        macro: vector.macro,
        vector_name: vector.name,
        raw_value: vector.value,
        template: vector.template,
      };
      const html = fixtureAgentEmitPreview([binding]);
      const records = observer.parse_html(html);
      const matches = observer.match_bindings(records, binding.template, [binding]);
      assert.ok(matches.length > 0, `no match for ${binding.vector_name}`);
      const result = observer.assert_rfc3986_safe(matches[0]);
      assert.ok(result.ok, `assert_rfc3986_safe must pass for ${binding.vector_name}: ${JSON.stringify(result)}`);
    }
  });

  it('preserves line_hint in parsed records', () => {
    const html = `<html><body>\n<img src="https://a.example/x">\n<img src="https://b.example/y">\n</body></html>`;
    const records = extractTrackerUrls(html);
    assert.equal(records.length, 2);
    assert.ok(records[0].line_hint >= 1);
    assert.ok(records[1].line_hint > records[0].line_hint);
  });

  it('runner detects a non-compliant encoder (encodeURIComponent substitute)', () => {
    // "Broken" agent emits encodeURIComponent output — parens are left raw.
    const vector = CATALOG_MACRO_VECTORS.find(v => v.name === 'url-scheme-injection-neutralized');
    const permissive = encodeURIComponent(vector.value);
    const url = vector.template.replace(vector.macro, permissive);
    const html = `<img src="${url}">`;

    const observer = new SubstitutionObserver();
    const records = observer.parse_html(html);
    const matches = observer.match_bindings(records, vector.template, [
      { macro: vector.macro, vector_name: vector.name },
    ]);
    assert.ok(matches.length > 0);
    const result = observer.assert_rfc3986_safe(matches[0]);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'substitution_encoding_violation');
  });

  it('runner detects a missing binding (seller stripped the macro)', () => {
    const observer = new SubstitutionObserver();
    const records = observer.parse_html('<img src="https://track.example/imp">');
    const matches = observer.match_bindings(records, 'https://track.example/imp?g={GTIN}', [
      { macro: '{GTIN}', vector_name: 'reserved-character-breakout' },
    ]);
    // With no 'g' query pair present, no match is produced.
    assert.equal(matches.length, 0);
  });
});
