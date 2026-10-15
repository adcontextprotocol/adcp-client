require('tsx/cjs');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { compile } = require('json-schema-to-typescript');
const { extractFromSource } = require('../scripts/generate-enum-arrays.ts');
const {
  enforceStrictSchema,
  stabilizeEmptyNumberedInterfacesAfterOpenObjectCleanup,
} = require('../scripts/generate-types.ts');
const { injectJsdocConstraints, removeArrayLengthConstraints } = require('../scripts/schema-utils.ts');

describe('enum-array extraction', () => {
  it('keeps finite string members when jsts widens an enum with a pattern', async () => {
    const schema = {
      title: 'Universal Macro',
      type: 'string',
      anyOf: [{ enum: ['GDPR', 'GDPR_CONSENT', 'ADDTL_CONSENT'] }, { pattern: '^GDPR_CONSENT_[1-9][0-9]*$' }],
    };
    const generated = await compile(
      enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema))),
      'UniversalMacro',
      {
        bannerComment: '',
        style: { semi: true, singleQuote: true },
        additionalProperties: false,
        strictIndexSignatures: true,
      }
    );
    const expected = [{ name: 'UniversalMacro', values: ['GDPR', 'GDPR_CONSENT', 'ADDTL_CONSENT'], source: 'core' }];

    assert.deepEqual(extractFromSource(generated, 'core'), expected);
    assert.deepEqual(
      extractFromSource(stabilizeEmptyNumberedInterfacesAfterOpenObjectCleanup(generated), 'core'),
      expected
    );
  });

  it('handles nested, parenthesized open string unions in source order', () => {
    const source = `
export type OpenVocabulary = (
  | (| 'first' | ('second' | 'third'))
  | string
);
export type ParameterizedVocabulary = 'fixed' | \`PREFIX_\${number}\`;
export type BrandedOpenVocabulary = 'known' | (string & {});
`;
    assert.deepEqual(extractFromSource(source, 'tools'), [
      { name: 'OpenVocabulary', values: ['first', 'second', 'third'], source: 'tools' },
      { name: 'ParameterizedVocabulary', values: ['fixed'], source: 'tools' },
      { name: 'BrandedOpenVocabulary', values: ['known'], source: 'tools' },
    ]);
  });

  it('reads decoded literals without splitting pipes, quotes, or semicolons inside values', () => {
    const source = String.raw`
export type Punctuation = 'a|b' | 'it\'s' | "double\"quote" | 'back\\slash' | 'line\nfeed' | 'semi;colon';
`;
    assert.deepEqual(extractFromSource(source, 'core'), [
      {
        name: 'Punctuation',
        values: ['a|b', "it's", 'double"quote', 'back\\slash', 'line\nfeed', 'semi;colon'],
        source: 'core',
      },
    ]);
  });

  it('does not infer enum values from structural, mixed, referenced, or non-exported aliases', () => {
    const source = `
export type ObjectValue = { kind: 'object'; nested: 'hidden' };
export type MixedObject = 'fixed' | { kind: 'object' };
export type MixedNumber = 'fixed' | number;
export type MixedLiteral = 'fixed' | 42;
export type MixedReference = 'fixed' | Other;
export type BrandedValue = ('fixed' | string) & { brand: 'hidden' };
export type ArrayValue = ('fixed' | 'other')[];
export type TupleValue = ['fixed', 'other'];
export type RecordValue = Record<string, 'hidden'>;
export type GenericValue<T> = 'fixed' | 'other';
export type OpenString = string;
export type OpenTemplate = \`PREFIX_\${number}\`;
export type lowerCase = 'hidden';
type PrivateValue = 'hidden';
// export type CommentValue = 'hidden';
export type ClosedValue = 'visible';
`;
    assert.deepEqual(extractFromSource(source, 'core'), [{ name: 'ClosedValue', values: ['visible'], source: 'core' }]);
  });

  it('preserves every existing generated literal array without changing its values or order', () => {
    const root = path.resolve(__dirname, '..');
    const extracted = new Map();
    for (const label of ['core', 'tools']) {
      const source = readFileSync(path.join(root, `src/lib/types/${label}.generated.ts`), 'utf8');
      for (const entry of extractFromSource(source, label)) {
        if (extracted.has(entry.name)) {
          assert.deepEqual(entry.values, extracted.get(entry.name), `${entry.name} agrees across source files`);
        } else {
          extracted.set(entry.name, entry.values);
        }
      }
    }
    const arrays = require('../src/lib/types/enums.generated.ts');
    let checked = 0;
    for (const name of Object.keys(arrays).filter(name => name.endsWith('Values'))) {
      if (name === 'SignalCatalogTypeValues') continue; // Existing compatibility alias.
      const values = extracted.get(name.slice(0, -'Values'.length));
      assert.ok(values, `${name} remains generated`);
      assert.deepEqual(values, [...arrays[name]], `${name} retains its values and order`);
      checked++;
    }
    assert.ok(checked >= 100, `expected the complete enum vocabulary, got ${checked}`);
  });
});
