// Regression tests for scripts/generate-media-buy-update-fields.ts (#2887).
//
// AdCP 3.2 (adcontextprotocol/adcp#7449) added a structured-only media-buy
// action, `update_media_buy_frequency_cap`, whose `update_fields` binding lives
// in `core/media-buy-available-action-id.json#/enumMetadata` rather than in
// the deprecated flat enum `enums/media-buy-valid-action.json`. The generator
// must merge both blocks (legacy wins on agreement, conflict aborts) and keep
// working against caches that predate the id schema.
//
// The generator is exercised against vendored fixtures so these assertions
// hold regardless of which AdCP version `ADCP_VERSION` currently pins.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const REPO_ROOT = path.join(__dirname, '../..');
const GENERATOR = path.join(REPO_ROOT, 'scripts/generate-media-buy-update-fields.ts');
const MERGED_FIXTURE = path.join(REPO_ROOT, 'test/fixtures/media-buy-update-fields/merged');
const LEGACY_ENUM = 'enums/media-buy-valid-action.json';
const ID_SCHEMA = 'core/media-buy-available-action-id.json';

const FREQUENCY_CAP_ACTION = 'update_media_buy_frequency_cap';
const PACKAGE_FREQUENCY_CAP_FIELD = 'packages[].targeting_overlay.frequency_cap';

let scratchRoot;

before(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-fields-generator-'));
});

after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

function scratchDir(name) {
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(path.join(dir, 'enums'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  return dir;
}

function copyFixture(dir, relative) {
  fs.copyFileSync(path.join(MERGED_FIXTURE, relative), path.join(dir, relative));
}

function writeIdSchema(dir, mutate) {
  const schema = JSON.parse(fs.readFileSync(path.join(MERGED_FIXTURE, ID_SCHEMA), 'utf8'));
  mutate(schema);
  fs.writeFileSync(path.join(dir, ID_SCHEMA), JSON.stringify(schema, null, 2));
}

/** Run the generator against `schemaDir`; returns the emitted module source plus stdout. */
function runGenerator(schemaDir) {
  const outPath = path.join(schemaDir, 'update-fields.generated.ts');
  const stdout = execFileSync('npx', ['tsx', GENERATOR], {
    cwd: REPO_ROOT,
    env: { ...process.env, SCHEMA_DIR: schemaDir, OUT_PATH: outPath, SCHEMA_PATH: '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { source: fs.readFileSync(outPath, 'utf8'), stdout, outPath };
}

function runGeneratorExpectingFailure(schemaDir) {
  try {
    runGenerator(schemaDir);
  } catch (error) {
    return `${error.stderr ?? ''}${error.stdout ?? ''}`;
  }
  assert.fail('generator was expected to abort');
}

/** Evaluate the generated module as CommonJS so assertions run on real values, not regexes. */
function evaluateModule(source) {
  const standalone = source
    .replace(/^import type .*$/m, '')
    .replace(/^export \{ LEGACY_COARSE_ACTIONS \} from '\.\/types';$/m, '')
    .replace(/^export type \{ LegacyCoarseAction \} from '\.\/types';$/m, '');
  const { outputText } = ts.transpileModule(standalone, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', outputText)(mod, mod.exports);
  return mod.exports;
}

describe('generate-media-buy-update-fields: merged enumMetadata (#2887)', () => {
  let generated;
  let source;
  let legacyEnum;

  before(() => {
    const dir = scratchDir('merged');
    copyFixture(dir, LEGACY_ENUM);
    copyFixture(dir, ID_SCHEMA);
    ({ source } = runGenerator(dir));
    generated = evaluateModule(source);
    legacyEnum = JSON.parse(fs.readFileSync(path.join(MERGED_FIXTURE, LEGACY_ENUM), 'utf8')).enum;
  });

  it('binds update_media_buy_frequency_cap -> ["frequency_cap"] from the id schema', () => {
    assert.deepEqual(generated.UPDATE_FIELDS_BY_ACTION[FREQUENCY_CAP_ACTION], {
      update_fields: ['frequency_cap'],
      rollup: null,
      deprecated: false,
    });
    assert.deepEqual(generated.ACTIONS_BY_FIELD.frequency_cap, [FREQUENCY_CAP_ACTION]);
  });

  it('still binds update_frequency_caps -> ["packages[].targeting_overlay.frequency_cap"] from the legacy enum', () => {
    assert.deepEqual(generated.UPDATE_FIELDS_BY_ACTION.update_frequency_caps, {
      update_fields: [PACKAGE_FREQUENCY_CAP_FIELD],
      rollup: null,
      deprecated: false,
    });
    assert.deepEqual(generated.ACTIONS_BY_FIELD[PACKAGE_FREQUENCY_CAP_FIELD], ['update_frequency_caps']);
  });

  it('lists the structured-only ids and appends them after the legacy enum order', () => {
    assert.deepEqual(generated.STRUCTURED_ONLY_MEDIA_BUY_ACTIONS, [FREQUENCY_CAP_ACTION]);
    const keys = Object.keys(generated.UPDATE_FIELDS_BY_ACTION);
    assert.deepEqual(keys, [...legacyEnum, FREQUENCY_CAP_ACTION]);
  });

  it('keeps legacy rollup / deprecation metadata intact', () => {
    assert.deepEqual(generated.UPDATE_FIELDS_BY_ACTION.update_packages.rollup, [
      'update_targeting',
      'update_pacing',
      'update_bidding',
      'update_frequency_caps',
      'reallocate_budget',
      'remove_packages',
    ]);
    assert.equal(generated.UPDATE_FIELDS_BY_ACTION.update_packages.deprecated, true);
    // Deprecated coarse rows never feed the inverse index.
    for (const actions of Object.values(generated.ACTIONS_BY_FIELD)) {
      assert.ok(!actions.includes('update_packages'), 'deprecated action leaked into ACTIONS_BY_FIELD');
    }
  });

  it('types the table by the widened action union and documents both sources', () => {
    assert.match(
      source,
      /export type MediaBuyUpdateFieldAction = MediaBuyValidAction \| StructuredOnlyMediaBuyAction;/
    );
    assert.match(source, /Record<MediaBuyUpdateFieldAction, UpdateFieldEntry>/);
    assert.match(source, /Record<string, readonly MediaBuyUpdateFieldAction\[\]>/);
    assert.match(source, /enums\/media-buy-valid-action\.json/);
    assert.match(source, /core\/media-buy-available-action-id\.json\n/);
    assert.doesNotMatch(source, /absent from this cache/);
  });
});

describe('generate-media-buy-update-fields: caches that predate the id schema', () => {
  it('emits the legacy-only table without failing', () => {
    const dir = scratchDir('legacy-only');
    copyFixture(dir, LEGACY_ENUM);
    const { source, stdout } = runGenerator(dir);
    const generated = evaluateModule(source);

    assert.deepEqual(generated.STRUCTURED_ONLY_MEDIA_BUY_ACTIONS, []);
    assert.equal(generated.UPDATE_FIELDS_BY_ACTION[FREQUENCY_CAP_ACTION], undefined);
    assert.equal(generated.ACTIONS_BY_FIELD.frequency_cap, undefined);
    assert.deepEqual(generated.UPDATE_FIELDS_BY_ACTION.update_frequency_caps.update_fields, [
      PACKAGE_FREQUENCY_CAP_FIELD,
    ]);
    assert.match(source, /absent from this cache; legacy-only table/);
    assert.match(stdout, /legacy-only table/);
  });

  it('still refuses a pre-3.1 cache with no enumMetadata at all', () => {
    const dir = scratchDir('pre-3-1');
    const schema = JSON.parse(fs.readFileSync(path.join(MERGED_FIXTURE, LEGACY_ENUM), 'utf8'));
    delete schema.enumMetadata;
    fs.writeFileSync(path.join(dir, LEGACY_ENUM), JSON.stringify(schema));
    const output = runGeneratorExpectingFailure(dir);
    assert.match(output, /no enumMetadata block/);
    assert.match(output, /core\/media-buy-available-action-id\.json/);
  });
});

describe('generate-media-buy-update-fields: conflict checks', () => {
  it('aborts when a shared key carries different update_fields in the two blocks', () => {
    const dir = scratchDir('conflict');
    copyFixture(dir, LEGACY_ENUM);
    writeIdSchema(dir, schema => {
      schema.enumMetadata.update_frequency_caps = { update_fields: ['frequency_cap'] };
    });
    const output = runGeneratorExpectingFailure(dir);
    assert.match(output, /enumMetadata conflict for "update_frequency_caps"/);
    assert.match(output, /refusing to merge/);
  });

  it('accepts a shared key when both blocks agree (legacy row is authoritative)', () => {
    const dir = scratchDir('agree');
    copyFixture(dir, LEGACY_ENUM);
    writeIdSchema(dir, schema => {
      schema.enumMetadata.update_frequency_caps = { update_fields: [PACKAGE_FREQUENCY_CAP_FIELD] };
    });
    const generated = evaluateModule(runGenerator(dir).source);
    assert.deepEqual(generated.UPDATE_FIELDS_BY_ACTION.update_frequency_caps.update_fields, [
      PACKAGE_FREQUENCY_CAP_FIELD,
    ]);
    assert.deepEqual(generated.STRUCTURED_ONLY_MEDIA_BUY_ACTIONS, [FREQUENCY_CAP_ACTION]);
  });

  it('aborts when a structured-only const has no update_fields binding', () => {
    const dir = scratchDir('unbound-const');
    copyFixture(dir, LEGACY_ENUM);
    writeIdSchema(dir, schema => {
      delete schema.enumMetadata[FREQUENCY_CAP_ACTION];
    });
    const output = runGeneratorExpectingFailure(dir);
    assert.match(
      output,
      new RegExp(`Structured-only action "${FREQUENCY_CAP_ACTION}".*no enumMetadata\\.update_fields`)
    );
  });

  it('aborts when the id schema carries metadata for an undeclared action', () => {
    const dir = scratchDir('undeclared');
    copyFixture(dir, LEGACY_ENUM);
    writeIdSchema(dir, schema => {
      schema.enumMetadata.update_something_else = { update_fields: ['something_else'] };
    });
    const output = runGeneratorExpectingFailure(dir);
    assert.match(output, /"update_something_else", which is neither/);
  });
});

describe('checked-in update-fields table tracks the pinned schema cache', () => {
  let mediaBuy;
  let pinShipsIdSchema;

  before(async () => {
    mediaBuy = await import('../../dist/lib/media-buy/index.js');
    const adcpVersion = fs.readFileSync(path.join(REPO_ROOT, 'ADCP_VERSION'), 'utf8').trim();
    pinShipsIdSchema = fs.existsSync(path.join(REPO_ROOT, 'schemas/cache', adcpVersion, ID_SCHEMA));
  });

  it('binds update_frequency_caps to the package-level path', () => {
    assert.deepEqual(mediaBuy.UPDATE_FIELDS_BY_ACTION.update_frequency_caps.update_fields, [
      PACKAGE_FREQUENCY_CAP_FIELD,
    ]);
  });

  it('carries the MediaBuy-level frequency_cap binding exactly when the pinned cache ships the id schema', () => {
    if (pinShipsIdSchema) {
      assert.deepEqual(mediaBuy.STRUCTURED_ONLY_MEDIA_BUY_ACTIONS, [FREQUENCY_CAP_ACTION]);
      assert.deepEqual(mediaBuy.UPDATE_FIELDS_BY_ACTION[FREQUENCY_CAP_ACTION].update_fields, ['frequency_cap']);
      assert.deepEqual(mediaBuy.ACTIONS_BY_FIELD.frequency_cap, [FREQUENCY_CAP_ACTION]);
    } else {
      assert.deepEqual(mediaBuy.STRUCTURED_ONLY_MEDIA_BUY_ACTIONS, []);
      assert.equal(mediaBuy.ACTIONS_BY_FIELD.frequency_cap, undefined);
    }
  });
});

// Codegen invariant (#2887): every wire site that carries a structured
// action id must resolve to the same generated type. json-schema-to-typescript
// degrades later occurrences of the `anyOf [$ref enum, const]` alias in a large
// root to a numbered copy of the legacy enum, which the numbered-dedupe pass
// folds back to `MediaBuyValidAction`. `scripts/generate-types.ts` owns
// `MediaBuyAvailableAction` / `ProductAllowedAction` as priority canonical
// schemas so first-definition wins; this pins that wiring.
describe('generated wire types share one action id type', () => {
  const core = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/types/core.generated.ts'), 'utf8');
  const tools = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/types/tools.generated.ts'), 'utf8');

  function propertyType(source, interfaceName, property) {
    const block = source.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `${interfaceName} must be declared in core.generated.ts`);
    const line = block[1].match(new RegExp(`\\n  ${property}\\??: ([^;]+);`));
    assert.ok(line, `${interfaceName}.${property} must be declared`);
    return line[1].trim();
  }

  it('available_actions[].action, allowed_actions[].action and attempted_action agree', () => {
    const attempted = propertyType(core, 'ActionNotAllowedDetails', 'attempted_action');
    assert.equal(propertyType(core, 'MediaBuyAvailableAction', 'action'), attempted);
    assert.equal(propertyType(core, 'ProductAllowedAction', 'action'), attempted);
    assert.match(attempted, /^MediaBuy(ValidAction|AvailableActionID)$/);
  });

  it('tools.generated.ts imports the action-bearing interfaces from core instead of redeclaring them', () => {
    assert.doesNotMatch(tools, /^export interface MediaBuyAvailableAction \{/m);
    assert.doesNotMatch(tools, /^export interface ProductAllowedAction \{/m);
    assert.match(tools, /^  MediaBuyAvailableAction,$/m);
    assert.match(tools, /^  ProductAllowedAction,$/m);
  });
});
