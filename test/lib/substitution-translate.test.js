const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');

const { translateUniversalMacros, UnsafeNativeMappingError } = require('../../dist/lib/index.js');

// Vendored language-neutral inputs from adcontextprotocol/adcp@acc022a53fad8ecab877d374df1760fef756325f.
const FIXTURE_PATH = path.resolve(__dirname, '../../src/lib/substitution/fixtures/universal-macro-translation.json');
const FIXTURE_SCHEMA_PATH = path.resolve(
  __dirname,
  '../../src/lib/substitution/fixtures/universal-macro-translation.schema.json'
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const fixtureSchema = JSON.parse(readFileSync(FIXTURE_SCHEMA_PATH, 'utf8'));

describe('translateUniversalMacros — canonical AdCP fixture', () => {
  it('matches the pinned language-neutral fixture schema', () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(fixtureSchema);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  });

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      if (vector.expected_error) {
        assert.throws(
          () => translateUniversalMacros(vector.input_pixel_url, vector.mapping),
          error => {
            assert.ok(error instanceof UnsafeNativeMappingError);
            assert.equal(error.code, vector.expected_error.code);
            assert.equal(error.macro, vector.expected_error.macro);
            return true;
          }
        );
        return;
      }

      assert.deepEqual(translateUniversalMacros(vector.input_pixel_url, vector.mapping), vector.expected);
    });
  }
});

describe('translateUniversalMacros — JavaScript integration mechanics', () => {
  it('rejects every C0 control character and DEL in native mappings', () => {
    const forbiddenCodePoints = [...Array.from({ length: 0x20 }, (_, codePoint) => codePoint), 0x7f];

    for (const codePoint of forbiddenCodePoints) {
      assert.throws(
        () =>
          translateUniversalMacros('https://pixel.example/i?v={VALUE}', {
            '{VALUE}': { native: `before${String.fromCharCode(codePoint)}after` },
          }),
        error =>
          error instanceof UnsafeNativeMappingError &&
          error.code === 'unsafe_native_mapping' &&
          error.macro === '{VALUE}',
        `expected U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} to be rejected`
      );
    }
  });

  it('rejects an unsafe native mapping that the input URL does not reference', () => {
    assert.throws(
      () =>
        translateUniversalMacros('https://pixel.example/i?ok={OK}', {
          '{OK}': { value: 'safe' },
          '{UNUSED}': { native: 'unsafe\nvalue' },
        }),
      error => {
        assert.ok(error instanceof UnsafeNativeMappingError);
        assert.equal(error.name, 'UnsafeNativeMappingError');
        assert.equal(error.code, 'unsafe_native_mapping');
        assert.equal(error.macro, '{UNUSED}');
        return true;
      }
    );
  });

  it('rejects the first unsafe native entry in mapping-property order', () => {
    assert.throws(
      () =>
        translateUniversalMacros('https://pixel.example/i', {
          '{FIRST}': { native: 'bad\u007f' },
          '{SECOND}': { native: 'bad\u0000' },
        }),
      error => error instanceof UnsafeNativeMappingError && error.macro === '{FIRST}'
    );
  });

  it('escapes unsafe log characters in an untyped mapping key while preserving error.macro', () => {
    const unsafeLogCharacters = [
      ['newline', '\n', '\\n'],
      ['DEL', '\u007f', '\\u007f'],
      ['C1', '\u0080', '\\u0080'],
      ['line separator', '\u2028', '\\u2028'],
      ['paragraph separator', '\u2029', '\\u2029'],
    ];

    for (const [name, character, escaped] of unsafeLogCharacters) {
      const macro = `bad${character}macro`;
      assert.throws(
        () => translateUniversalMacros('https://pixel.example/i', { [macro]: { native: 'bad\u0000value' } }),
        error => {
          assert.ok(error instanceof UnsafeNativeMappingError);
          assert.equal(error.macro, macro);
          assert.equal(error.message.includes(character), false, `${name} must not remain literal in message`);
          assert.ok(error.message.includes(`bad${escaped}macro`), `${name} must be escaped in message`);
          return true;
        }
      );
    }
  });

  it('does not broaden native rejection beyond C0 and DEL', () => {
    const result = translateUniversalMacros('https://pixel.example/i?v={VALUE}', {
      '{VALUE}': { native: 'allowed\u0080\u2028\u2029?&' },
    });

    assert.equal(result.url, 'https://pixel.example/i?v=allowed\u0080\u2028\u2029?&');
  });
});
