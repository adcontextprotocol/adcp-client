/**
 * Parity between three things that MUST agree, enforced in one place:
 *
 *   1. `CATALOG_MACRO_VECTORS` constants in `src/lib/substitution/vectors.ts`.
 *   2. The shipped JSON fixture at
 *      `src/lib/substitution/fixtures/catalog-macro-substitution.json`.
 *   3. The contract's #2620 encoder semantics, i.e., every vector's
 *      `expected` URL is `template` with `{MACRO}` replaced by
 *      `encodeUnreserved(value)`.
 *
 * If any of those drift, the library silently becomes non-compliant.
 */

const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CATALOG_MACRO_VECTORS, encodeUnreserved } = require('../../dist/lib/index.js');

const FIXTURE_PATH = path.resolve(__dirname, '../../src/lib/substitution/fixtures/catalog-macro-substitution.json');

describe('substitution vectors — parity with shipped JSON fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  it('fixture file contains exactly the same vectors as CATALOG_MACRO_VECTORS', () => {
    const jsonByName = new Map(fixture.vectors.map(v => [v.name, v]));
    const tsByName = new Map(CATALOG_MACRO_VECTORS.map(v => [v.name, v]));
    assert.deepEqual([...jsonByName.keys()].sort(), [...tsByName.keys()].sort());
    for (const name of jsonByName.keys()) {
      const j = jsonByName.get(name);
      const t = tsByName.get(name);
      assert.equal(t.macro, j.macro, `${name}: macro drift`);
      assert.equal(t.value, j.value, `${name}: raw value drift`);
      assert.equal(t.template, j.template, `${name}: template drift`);
      assert.equal(t.expected, j.expected, `${name}: expected URL drift`);
    }
  });
});

describe('substitution vectors — encoder produces the fixture-expected URL', () => {
  for (const vector of CATALOG_MACRO_VECTORS) {
    it(`${vector.name}: encodeUnreserved(value) substituted into template equals fixture.expected`, () => {
      const encoded = encodeUnreserved(vector.value);
      const substituted = vector.template.split(vector.macro).join(encoded);
      assert.equal(
        substituted,
        vector.expected,
        `encoder output diverged from fixture — either the encoder is broken or the fixture needs updating`
      );
    });
  }
});
