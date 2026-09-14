const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const GENERATOR = path.join(ROOT, 'scripts/generate-types.ts');

// `core/targeting-input.json` reaches each dimension through a JSON-pointer $ref
// into `core/targeting.json#/properties/<dimension>`. Where that array has no
// `title` of its own, json-schema-to-typescript names the result after the
// items' canonical $ref, so the Input side declares the scalar enum where the
// wire carries an array. `alignTargetingInputArrayCardinality` repairs that from
// the invariant the two schemas satisfy: identical property sets, so Input is
// Overlay plus `| null` per dimension.
//
// The generator is TypeScript, so the cases run through one `tsx` harness —
// the same pattern test/generate-zod-*.test.js uses.
function unit({ overlay, input }) {
  const render = (name, properties) =>
    `export type ${name} = SomeConstraint &\n  OtherConstraint & {\n` +
    properties.map(([property, type]) => `    /** doc for ${property} */\n    ${property}?: ${type};`).join('\n') +
    '\n  };\n';
  return `${render('TargetingOverlay', overlay)}\n${render('TargetingOverlayInput', input)}`;
}

const ITEMS = {
  geo_countries: 'GeoCountry',
  device_platform: 'DevicePlatform',
  device_type: 'DeviceType',
  browser: 'BrowserFamily',
};
const arrayOf = name => `[${ITEMS[name]}, ...${ITEMS[name]}[]]`;
const FOUR = Object.keys(ITEMS);

const CASES = {
  single: unit({
    overlay: [['device_platform', arrayOf('device_platform')]],
    input: [['device_platform', 'DevicePlatform | null']],
  }),
  // The original implementation computed the block offsets once and then mutated
  // the string inside the loop, so each repair shifted the window and a later
  // declaration could fall outside it — silently unrepaired while still being
  // logged as fixed. Four repairs with the last property affected exposes it.
  four: unit({
    overlay: FOUR.map(name => [name, arrayOf(name)]),
    input: FOUR.map(name => [name, `${ITEMS[name]} | null`]),
  }),
  correctAlias: unit({
    overlay: [['device_platform_exclude', arrayOf('device_platform')]],
    input: [['device_platform_exclude', 'DevicePlatformExclude | null']],
  }),
  scalarDimension: unit({
    overlay: [['axe_include_segment', 'string']],
    input: [['axe_include_segment', 'string | null']],
  }),
  overlayOnly: 'export type TargetingOverlay = A &\n  B & {\n    x?: [Y, ...Y[]];\n  };\n',
  empty: '',
};

let output;

before(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '.targeting-cardinality-'));
  const inputPath = path.join(directory, 'cases.json');
  const outputPath = path.join(directory, 'out.json');
  const harnessPath = path.join(directory, 'harness.ts');
  fs.writeFileSync(inputPath, JSON.stringify(CASES));
  fs.writeFileSync(
    harnessPath,
    `
import { readFileSync, writeFileSync } from 'node:fs';
import { alignTargetingInputArrayCardinality } from ${JSON.stringify(GENERATOR)};
const cases = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(
  Object.fromEntries(Object.entries(cases).map(([id, source]) => [id, alignTargetingInputArrayCardinality(source as string)]))
));
`
  );
  try {
    const result = spawnSync('npx', ['tsx', harnessPath], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `cardinality harness failed:\n${result.stderr}\n${result.stdout}`);
    output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const declared = (source, name, property) =>
  new RegExp(`export type ${name} =[\\s\\S]*?\\n    ${property}\\?: ([^;]+);`).exec(source)?.[1];

describe('alignTargetingInputArrayCardinality', () => {
  test('repairs a dimension collapsed to its array item type', () => {
    assert.equal(
      declared(output.single, 'TargetingOverlayInput', 'device_platform'),
      '[DevicePlatform, ...DevicePlatform[]] | null'
    );
  });

  test('repairs every collapsed dimension, including the last one in the block', () => {
    for (const name of FOUR) {
      assert.equal(
        declared(output.four, 'TargetingOverlayInput', name),
        `${arrayOf(name)} | null`,
        `${name} must be repaired`
      );
    }
  });

  test('leaves a correct array alias untouched', () => {
    // The Input side is an alias, not the item type, so there is nothing to
    // prove wrong — rewriting it would replace a clean name with an inline tuple.
    assert.equal(output.correctAlias, CASES.correctAlias);
  });

  test('leaves a non-array dimension untouched', () => {
    assert.equal(output.scalarDimension, CASES.scalarDimension);
  });

  test('preserves the per-property JSDoc it repairs around', () => {
    assert.equal((output.single.match(/\/\*\* doc for device_platform \*\//g) ?? []).length, 2);
  });

  test('is a no-op when either type is absent from the unit', () => {
    assert.equal(output.overlayOnly, CASES.overlayOnly);
    assert.equal(output.empty, CASES.empty);
  });
});
