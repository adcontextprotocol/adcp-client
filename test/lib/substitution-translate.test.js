const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');

const {
  translateUniversalMacros,
  UnsafeNativeMappingError,
  MultipleVendorConsentMacrosError,
} = require('../../dist/lib/index.js');

// Vendored from adcontextprotocol/adcp@d5f56dbea17ed190fe9b499764be1b697dd33418 (AdCP 3.3).
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
    assert.equal(fixture.version, '3.3');
  });

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      if (vector.expected_error) {
        assert.throws(
          () => translateUniversalMacros(vector.input_pixel_url, vector.mapping),
          error => {
            const ErrorClass = {
              unsafe_native_mapping: UnsafeNativeMappingError,
              multiple_vendor_consent_macros: MultipleVendorConsentMacrosError,
            }[vector.expected_error.code];
            assert.ok(ErrorClass, `unknown fixture error code: ${vector.expected_error.code}`);
            assert.ok(error instanceof ErrorClass);
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

describe('translateUniversalMacros — scoped consent safety', () => {
  function rejectsSecondConsent(url, mapping, macro) {
    assert.throws(
      () => translateUniversalMacros(url, mapping),
      error => {
        assert.ok(error instanceof MultipleVendorConsentMacrosError);
        assert.equal(error.name, 'MultipleVendorConsentMacrosError');
        assert.equal(error.code, 'multiple_vendor_consent_macros');
        assert.equal(error.macro, macro);
        return true;
      }
    );
  }

  it('counts scoped tokens across paths, query keys, and fragments in the emitted URL', () => {
    const cases = [
      [
        'https://pixel.example/${GDPR_CONSENT_755}?c={GDPR_CONSENT_42}',
        {
          '{GDPR_CONSENT_42}': { native: '${GDPR_CONSENT_42}' },
        },
      ],
      [
        'https://pixel.example/i?{GDPR_CONSENT_755}=literal&c={GDPR_CONSENT_42}',
        {
          '{GDPR_CONSENT_42}': { native: '${GDPR_CONSENT_42}' },
        },
      ],
      [
        'https://pixel.example/i?c={GDPR_CONSENT_755}#${GDPR_CONSENT_42}',
        {
          '{GDPR_CONSENT_755}': { native: '${GDPR_CONSENT_755}' },
        },
      ],
    ];
    for (const [url, mapping] of cases) rejectsSecondConsent(url, mapping, '{GDPR_CONSENT_42}');
  });

  it('checks URLs without query parameters and after bare-query normalization', () => {
    for (const url of [
      'https://pixel.example/${GDPR_CONSENT_755}/${GDPR_CONSENT_42}',
      'https://pixel.example/{GDPR_CONSENT_755}#${GDPR_CONSENT_42}',
      'https://pixel.example/${GDPR_CONSENT_755}?#${GDPR_CONSENT_42}',
    ])
      rejectsSecondConsent(url, {}, '{GDPR_CONSENT_42}');
  });

  it('preserves existing native TCF and Additional Consent tokens despite matching interior mappings', () => {
    const url = 'https://pixel.example/i?c=${GDPR_CONSENT_755}&a=${ADDTL_CONSENT}';
    const result = translateUniversalMacros(url, {
      '{GDPR_CONSENT_755}': { native: '%%CONSENT_755%%' },
      '{ADDTL_CONSENT}': { native: '%%ADDITIONAL_CONSENT%%' },
    });
    assert.equal(result.url, url);
    assert.deepEqual(result.unmapped_macros, []);
    assert.deepEqual(result.dropped_consent_macros, []);
  });

  it('counts pre-existing native aliases only when a scoped mapping identifies them', () => {
    const url = 'https://pixel.example/%%CONSENT_755%%?c=${GDPR_CONSENT_42}';
    assert.equal(translateUniversalMacros(url, {}).url, url);
    rejectsSecondConsent(
      url,
      {
        '{GDPR_CONSENT_755}': { native: '%%CONSENT_755%%' },
      },
      '{GDPR_CONSENT_42}'
    );
    rejectsSecondConsent(
      'https://pixel.example/i?c=%%CONSENT_755%%&again=%%CONSENT_755%%',
      {
        '{GDPR_CONSENT_755}': { native: '%%CONSENT_755%%' },
      },
      '{GDPR_CONSENT_755}'
    );
  });

  it('counts native tokens inserted through unrelated mappings, including multiple tokens in one replacement', () => {
    rejectsSecondConsent(
      'https://pixel.example/i?c={GDPR_CONSENT_755}&other={VENDOR_TOKEN}',
      {
        '{GDPR_CONSENT_755}': { native: '%%CONSENT_755%%' },
        '{VENDOR_TOKEN}': { native: '${GDPR_CONSENT_42}' },
      },
      '{GDPR_CONSENT_42}'
    );
    rejectsSecondConsent(
      'https://pixel.example/i?c={VENDOR_TOKEN}',
      {
        '{VENDOR_TOKEN}': { native: '${GDPR_CONSENT_755}-${GDPR_CONSENT_42}' },
      },
      '{GDPR_CONSENT_42}'
    );
    rejectsSecondConsent(
      'https://pixel.example/i?c=${GDPR_CONSENT_42}&other={VENDOR_TOKEN}',
      {
        '{GDPR_CONSENT_755}': { native: '%%CONSENT_755%%' },
        '{VENDOR_TOKEN}': { native: '%%CONSENT_755%%' },
      },
      '{GDPR_CONSENT_755}'
    );
  });

  it('does not apply the scoped limit to repeated Additional Consent or unscoped TCF tokens', () => {
    const url =
      'https://pixel.example/i?c=${GDPR_CONSENT_755}&a=${ADDTL_CONSENT}&again=${ADDTL_CONSENT}&unscoped=${GDPR_CONSENT}';
    assert.equal(translateUniversalMacros(url, {}).url, url);
  });

  it('does not count frozen or percent-encoded consent data as expandable occurrences', () => {
    const frozen = translateUniversalMacros('https://pixel.example/i?c={GDPR_CONSENT_755}&again={GDPR_CONSENT_755}', {
      '{GDPR_CONSENT_755}': { value: '${GDPR_CONSENT_42}' },
    });
    assert.equal(frozen.url, 'https://pixel.example/i?c=%24%7BGDPR_CONSENT_42%7D&again=%24%7BGDPR_CONSENT_42%7D');
    assert.deepEqual(frozen.frozen_consent_macros, ['{GDPR_CONSENT_755}']);
    assert.deepEqual(frozen.suspect_native_values, ['{GDPR_CONSENT_755}']);

    const url = 'https://pixel.example/i?c=${GDPR_CONSENT_755}&data=%24%7BGDPR_CONSENT_42%7D';
    assert.equal(
      translateUniversalMacros(url, {
        '{GDPR_CONSENT_42}': { value: 'unreferenced-consent' },
      }).url,
      url
    );

    assert.equal(
      translateUniversalMacros('https://pixel.example/i?c=${GDPR_CONSENT_42}&data={VALUE}', {
        '{GDPR_CONSENT_755}': { native: 'CONSENT_755' },
        '{VALUE}': { value: 'CONSENT_755' },
      }).url,
      'https://pixel.example/i?c=${GDPR_CONSENT_42}&data=CONSENT_755'
    );
  });

  it('counts canonical native tokens assembled across native and concrete replacement spans', () => {
    rejectsSecondConsent(
      'https://pixel.example/i?a={PREFIX}{ID}{SUFFIX}&c=${GDPR_CONSENT_42}',
      {
        '{PREFIX}': { native: '${GDPR_CONSENT_' },
        '{ID}': { value: '755' },
        '{SUFFIX}': { native: '}' },
      },
      '{GDPR_CONSENT_42}'
    );
  });

  it('counts known native aliases assembled across native and concrete replacement spans', () => {
    rejectsSecondConsent(
      'https://pixel.example/i?a={PREFIX}{ID}{SUFFIX}&c=${GDPR_CONSENT_42}',
      {
        '{GDPR_CONSENT_755}': { native: '%%CONSENT_755%%' },
        '{PREFIX}': { native: '%%CONSENT_' },
        '{ID}': { value: '755' },
        '{SUFFIX}': { native: '%%' },
      },
      '{GDPR_CONSENT_42}'
    );
  });

  it('counts known unreserved aliases assembled across native and concrete replacement spans', () => {
    rejectsSecondConsent(
      'https://pixel.example/i?a={PREFIX}{ID}&c=${GDPR_CONSENT_42}',
      {
        '{GDPR_CONSENT_755}': { native: 'CONSENT_755' },
        '{PREFIX}': { native: 'CONSENT_' },
        '{ID}': { value: '755' },
      },
      '{GDPR_CONSENT_42}'
    );
  });

  it('keeps known unreserved aliases assembled entirely from adjacent concrete values as data', () => {
    const result = translateUniversalMacros('https://pixel.example/i?a={PREFIX}{ID}&c=${GDPR_CONSENT_42}', {
      '{GDPR_CONSENT_755}': { native: 'CONSENT_755' },
      '{PREFIX}': { value: 'CONSENT_' },
      '{ID}': { value: '755' },
    });
    assert.equal(result.url, 'https://pixel.example/i?a=CONSENT_755&c=${GDPR_CONSENT_42}');
  });

  it('keeps later valid scoped tokens visible after malformed native openers', () => {
    for (const url of [
      'https://pixel.example/{{BROKEN${GDPR_CONSENT_755}/${GDPR_CONSENT_42}',
      'https://pixel.example/%%BROKEN${GDPR_CONSENT_755}/${GDPR_CONSENT_42}',
    ]) {
      rejectsSecondConsent(url, {}, '{GDPR_CONSENT_42}');
    }
  });

  it('drops unsupported parameters before counting their existing native tokens', () => {
    const result = translateUniversalMacros(
      'https://pixel.example/i?discard=${GDPR_CONSENT_42}-{UNKNOWN}&c={GDPR_CONSENT_755}',
      { '{GDPR_CONSENT_755}': { native: '${GDPR_CONSENT_755}' } }
    );
    assert.equal(result.url, 'https://pixel.example/i?c=${GDPR_CONSENT_755}');
    assert.deepEqual(result.dropped_params, ['discard']);
    assert.deepEqual(result.unmapped_macros, ['{UNKNOWN}']);
    assert.deepEqual(result.dropped_consent_macros, []);
  });

  it('identifies the second emitted occurrence in URL order rather than mapping order', () => {
    rejectsSecondConsent(
      'https://pixel.example/{GDPR_CONSENT_755}?c={GDPR_CONSENT_42}#${GDPR_CONSENT_900}',
      {
        '{GDPR_CONSENT_900}': { native: '${GDPR_CONSENT_900}' },
        '{GDPR_CONSENT_42}': { native: '%%CONSENT_42%%' },
        '{GDPR_CONSENT_755}': { native: '${GDPR_CONSENT_755}' },
      },
      '{GDPR_CONSENT_42}'
    );
  });

  it('throws without exposing the URL, mapping, or consent values in the error', () => {
    const url =
      'https://pixel.example/private-path?c=${GDPR_CONSENT_755}&again=${GDPR_CONSENT_42}&secret=private-consent';
    assert.throws(
      () => translateUniversalMacros(url, { '{ADDTL_CONSENT}': { value: 'private-mapping-consent' } }),
      error => {
        assert.ok(error instanceof MultipleVendorConsentMacrosError);
        assert.equal(error.macro, '{GDPR_CONSENT_42}');
        for (const field of ['url', 'input_pixel_url', 'mapping', 'value']) {
          assert.equal(Object.hasOwn(error, field), false, `${field} must not be retained`);
        }
        for (const rendered of [error.message, error.stack, JSON.stringify(error)]) {
          for (const secret of [url, 'private-path', 'private-consent', 'private-mapping-consent']) {
            assert.equal(rendered.includes(secret), false, 'error must not expose URL or consent data');
          }
        }
        return true;
      }
    );
  });
});

describe('translateUniversalMacros — public entrypoint exports', () => {
  const entrypoints = [
    ['root CommonJS', () => require('../../dist/lib/index.js')],
    ['substitution CommonJS', () => require('../../dist/lib/substitution/index.js')],
    ['root ESM', () => import('../../dist/lib/index.mjs')],
    ['substitution ESM', () => import('../../dist/lib/substitution/index.mjs')],
  ];
  for (const [label, load] of entrypoints) {
    it(`${label} exports the typed errors thrown by its translator`, async () => {
      const api = await load();
      assert.equal(typeof api.translateUniversalMacros, 'function');
      assert.equal(typeof api.MultipleVendorConsentMacrosError, 'function');
      assert.equal(typeof api.UnsafeNativeMappingError, 'function');
      assert.throws(
        () =>
          api.translateUniversalMacros('https://pixel.example/i?c=${GDPR_CONSENT_755}&again=${GDPR_CONSENT_42}', {}),
        error =>
          error instanceof api.MultipleVendorConsentMacrosError &&
          error.code === 'multiple_vendor_consent_macros' &&
          error.macro === '{GDPR_CONSENT_42}'
      );
      assert.throws(
        () => api.translateUniversalMacros('https://pixel.example/i?v={VALUE}', { '{VALUE}': { native: 'bad\u0000' } }),
        error =>
          error instanceof api.UnsafeNativeMappingError &&
          error.code === 'unsafe_native_mapping' &&
          error.macro === '{VALUE}'
      );
    });
  }
});
