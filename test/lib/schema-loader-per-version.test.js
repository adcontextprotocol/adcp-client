// Phase A of Stage 3: schema-loader holds per-version state, keyed by the
// resolved bundle key (`MAJOR.MINOR` for stable, full version for prereleases).
//
// Asserts that:
//   - Stable patch pins (`'3.0.0'`, `'3.0.1'`, `'3.0'`) collapse to one
//     compiled validator — the SDK doesn't ship distinct schemas per patch.
//   - Distinct minors (`'3.0'` vs a synthetic `'1.0'` fixture) produce
//     distinct compiled validators.
//   - Prereleases stay exact (cached separately from any stable bundle).
//
// The test creates a synthetic minor directory in `dist/lib/schemas-data/`
// so the assertions don't depend on whichever AdCP versions happen to be in
// the local cache. The build collapses stable patches to MAJOR.MINOR keys
// (see scripts/copy-schemas-to-dist.ts).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  getValidator,
  getSchemaValidatorByRef,
  listValidatorKeys,
  resolveBundleKey,
  hasSchemaBundle,
  _resetValidationLoader,
} = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const ADCP_RELEASE_PRECISION = ADCP_VERSION.replace(/^(\d+)\.(\d+)\.\d+-(.+)$/, '$1.$2-$3');
const ADCP_PRERELEASE_FAMILY = ADCP_RELEASE_PRECISION.replace(/\.\d+$/, '');

// Synthetic fixture under a different MAJOR.MINOR so the loader's state map
// keeps it separate from the real bundle.
const FIXTURE_KEY = '1.0';
const FIXTURE_VERSION_PIN = '1.0.0';
const PRERELEASE_SORT_OLD = '9.9.0-rc.9';
const PRERELEASE_SORT_NEW = '9.9.0-rc.10';
const PRERELEASE_SORT_FAMILY = '9.9-rc';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMAS_DATA_ROOT = path.resolve(__dirname, '..', '..', 'dist', 'lib', 'schemas-data');
const SOURCE_DIR = path.join(SCHEMAS_DATA_ROOT, resolveBundleKey(ADCP_VERSION));
const FIXTURE_DIR = path.join(SCHEMAS_DATA_ROOT, FIXTURE_KEY);

function writeMinimalGetProductsBundle(root, version, sentinel) {
  const bundledDir = path.join(root, 'bundled', 'media-buy');
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundledDir, 'get-products-request.json'),
    JSON.stringify({
      $id: `/schemas/${version}/bundled/media-buy/get-products-request.json`,
      type: 'object',
      properties: { sentinel: { const: sentinel } },
      required: ['sentinel'],
      additionalProperties: false,
    })
  );
}

function runPrereleaseSortFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-schema-loader-prerelease-sort-'));
  try {
    const tempDist = path.join(tempRoot, 'dist');
    fs.cpSync(path.join(REPO_ROOT, 'dist'), tempDist, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
    const tempSchemasData = path.join(tempDist, 'lib', 'schemas-data');
    writeMinimalGetProductsBundle(path.join(tempSchemasData, PRERELEASE_SORT_OLD), PRERELEASE_SORT_OLD, 'old');
    writeMinimalGetProductsBundle(path.join(tempSchemasData, PRERELEASE_SORT_NEW), PRERELEASE_SORT_NEW, 'new');

    const loaderPath = path.join(tempDist, 'lib', 'validation', 'schema-loader.js').replace(/\\/g, '/');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
const { getValidator } = require(${JSON.stringify(loaderPath)});
const validator = getValidator('get_products', 'request', ${JSON.stringify(PRERELEASE_SORT_FAMILY)});
console.log(JSON.stringify({
  hasValidator: !!validator,
  acceptsNew: validator ? validator({ sentinel: 'new' }) : false,
  acceptsOld: validator ? validator({ sentinel: 'old' }) : false,
  errors: validator?.errors ?? null,
}));
`,
      ],
      { cwd: tempRoot, encoding: 'utf-8' }
    );
    assert.strictEqual(result.status, 0, `fixture process failed:\nstdout:${result.stdout}\nstderr:${result.stderr}`);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

before(() => {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Test setup expects ${SOURCE_DIR} to exist. Run \`npm run build:lib\` first.`);
  }
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
  fs.cpSync(SOURCE_DIR, FIXTURE_DIR, { recursive: true });
});

after(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

describe('schema-loader per-version state', () => {
  test('default version (no argument) uses ADCP_VERSION', () => {
    _resetValidationLoader();
    const keys = listValidatorKeys();
    assert.ok(keys.length > 0, 'default loader has validators');
    assert.ok(keys.includes('get_products::request'), 'expected get_products::request in default version');
  });

  test('resolveBundleKey collapses stable patches to MAJOR.MINOR', () => {
    assert.strictEqual(resolveBundleKey('3.0.0'), '3.0');
    assert.strictEqual(resolveBundleKey('3.0.1'), '3.0');
    assert.strictEqual(resolveBundleKey('3.0'), '3.0');
    assert.strictEqual(resolveBundleKey('3.1.0'), '3.1');
  });

  test('resolveBundleKey keeps prereleases exact', () => {
    assert.strictEqual(resolveBundleKey('3.1.0-beta.5'), '3.1.0-beta.5');
    assert.strictEqual(resolveBundleKey(ADCP_VERSION), ADCP_VERSION);
  });

  test('stable patch pins share a compiled validator (1.0.0 ≡ 1.0.1 ≡ 1.0 via fixture)', () => {
    // ADCP_VERSION is a prerelease bundle (kept exact)
    // so the stable-patch-collapse invariant is exercised against the synthetic
    // 1.0 fixture this suite creates in before(). Pre-3.1 beta this test
    // used the (then-shipped) 3.0.x bundle directly.
    _resetValidationLoader();
    const v100 = getValidator('get_products', 'request', '1.0.0');
    const v101 = getValidator('get_products', 'request', '1.0.1');
    const vMinor = getValidator('get_products', 'request', '1.0');
    assert.ok(v100, '1.0.0 resolves to a compiled validator');
    assert.strictEqual(v100, v101, 'patch pins in same minor share a state');
    assert.strictEqual(v101, vMinor, 'minor pin shares the same state');
  });

  test('distinct minors produce distinct compiled validators', () => {
    _resetValidationLoader();
    const vCurrent = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixture = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    assert.ok(vCurrent, `${ADCP_VERSION} validator compiled`);
    assert.ok(vFixture, `${FIXTURE_VERSION_PIN} validator compiled`);
    assert.notStrictEqual(vCurrent, vFixture, 'distinct minors compile distinct validator instances');
  });

  test('listValidatorKeys is per-bundle', () => {
    _resetValidationLoader();
    const keysCurrent = listValidatorKeys(ADCP_VERSION);
    const keysFixture = listValidatorKeys(FIXTURE_VERSION_PIN);
    assert.deepStrictEqual(keysCurrent, keysFixture);
  });

  test('repeated calls cache the per-bundle validator', () => {
    _resetValidationLoader();
    const first = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    const second = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    assert.strictEqual(first, second);
  });

  test('unknown version throws with a clear message', () => {
    _resetValidationLoader();
    assert.throws(
      () => getValidator('get_products', 'request', '99.99.99-not-a-real-version'),
      err => /AdCP schema data for version "99\.99\.99-not-a-real-version" not found/.test(err.message)
    );
  });

  test('default version path aliases to ADCP_VERSION explicit path', () => {
    _resetValidationLoader();
    const fromDefault = getValidator('get_products', 'request');
    const fromExplicit = getValidator('get_products', 'request', ADCP_VERSION);
    assert.strictEqual(fromDefault, fromExplicit);
  });

  test('_resetValidationLoader(version) clears one bundle, leaves others', () => {
    _resetValidationLoader();
    const vCurrentFirst = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixtureFirst = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    _resetValidationLoader(ADCP_VERSION);
    const vCurrentAfter = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixtureAfter = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    assert.notStrictEqual(vCurrentFirst, vCurrentAfter, 'reset bundle re-compiles');
    assert.strictEqual(vFixtureFirst, vFixtureAfter, 'untouched bundle stays cached');
  });

  test('reset by stable patch pin clears the same bundle as the minor pin', () => {
    // Uses the synthetic 1.0 fixture (see top of file) because no stable 3.x
    // bundle ships on the current 3.1 beta; the invariant under test is generic.
    _resetValidationLoader();
    const beforeReset = getValidator('get_products', 'request', '1.0');
    _resetValidationLoader('1.0.1'); // patch-pinned reset must clear the '1.0' bundle
    const afterReset = getValidator('get_products', 'request', '1.0');
    assert.notStrictEqual(beforeReset, afterReset, 'resetting via a patch-pin clears the resolved minor bundle');
  });

  test('hasSchemaBundle returns true for shipped versions', () => {
    // ADCP_VERSION is a prerelease bundle (kept exact, no patch-collapse).
    // The stable-bundle-collapse behavior is covered against the synthetic
    // 1.0 fixture in the patch-pin-share test above; no stable 3.x bundle
    // ships today, so we assert directly against the shipped prerelease key.
    assert.strictEqual(hasSchemaBundle(ADCP_VERSION), true);
    assert.strictEqual(hasSchemaBundle('1.0.0'), true, '1.0.0 (fixture) collapses to the 1.0 bundle');
    assert.strictEqual(hasSchemaBundle('1.0'), true, 'bare minor resolves to the same bundle');
  });

  test('hasSchemaBundle returns false for unshipped versions', () => {
    assert.strictEqual(hasSchemaBundle('4.0.0'), false, 'no major-4 bundle');
    assert.strictEqual(hasSchemaBundle('99.0.0-beta.1'), false, 'no synthetic prerelease bundle');
  });

  test('hasSchemaBundle returns false for non-version garbage (defense in depth)', () => {
    // resolveBundleKey throws ConfigurationError for unrecognized shapes;
    // hasSchemaBundle's try/catch surfaces the throw as `false` so a
    // malformed input never reaches `path.join` as a directory component.
    assert.strictEqual(hasSchemaBundle('../etc'), false);
    assert.strictEqual(hasSchemaBundle('3foo'), false);
    assert.strictEqual(hasSchemaBundle(''), false);
  });

  test('release-precision prerelease family aliases prefer numeric newest bundle', () => {
    const result = runPrereleaseSortFixture();
    assert.strictEqual(result.hasValidator, true, `${PRERELEASE_SORT_FAMILY} get_products::request must compile`);
    assert.strictEqual(result.acceptsNew, true, 'rc.10 must sort newer than rc.9');
    assert.strictEqual(result.acceptsOld, false, 'rc.9 must not win lexicographically over rc.10');
  });

  test('resolveBundleKey rejects prerelease tags with non-SemVer chars (path-traversal hardening)', () => {
    // Prerelease group restricts to [0-9A-Za-z-] so traversal-like strings
    // can't slip through verbatim into `path.join`. SemVer §9 identifiers
    // are dot-separated alphanumerics; anything else is rejected.
    assert.throws(
      () => resolveBundleKey('3.0.0-/../etc'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
    assert.throws(
      () => resolveBundleKey('3.0.0-foo/bar'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
    assert.throws(
      () => resolveBundleKey('3.0.0-..'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
    assert.strictEqual(hasSchemaBundle('3.0.0-/../etc'), false);
    // Valid SemVer prereleases still pass through.
    assert.strictEqual(resolveBundleKey(ADCP_VERSION), ADCP_VERSION);
    assert.strictEqual(resolveBundleKey('3.0.0-beta-final'), '3.0.0-beta-final');
  });

  test('resolveBundleKey throws ConfigurationError for non-version input', () => {
    assert.throws(
      () => resolveBundleKey('../etc'),
      err => err.code === 'CONFIGURATION_ERROR' && /not a recognized version format/.test(err.message)
    );
    assert.throws(
      () => resolveBundleKey('3foo'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
  });

  test('resolveBundleKey accepts legacy v-prefix aliases', () => {
    assert.strictEqual(resolveBundleKey('v3'), 'v3');
    assert.strictEqual(resolveBundleKey('v2.5'), 'v2.5');
    assert.strictEqual(resolveBundleKey('v2.6'), 'v2.6');
  });

  test(`${ADCP_VERSION} opt-in bundle compiles and accepts wholesale-feed request fields`, () => {
    // Runtime guard for the 3.1 prerelease opt-in: a consumer pinning the
    // current prerelease gets a compiled validator that accepts the wholesale-feed
    // request fields (if_wholesale_feed_version / if_pricing_version) the type
    // surface exposes via `@adcp/sdk/types/v3-1-beta`. Without this, the
    // type-side worked but the wire-side could regress silently.
    _resetValidationLoader(ADCP_VERSION);
    const v = getValidator('get_products', 'request', ADCP_VERSION);
    assert.ok(v, '3.1 prerelease get_products::request must compile from the opt-in bundle');
    const ok = v({
      adcp_version: ADCP_RELEASE_PRECISION,
      brief: 'wholesale catalog mirror probe',
      buying_mode: 'wholesale',
      if_wholesale_feed_version: 'v2026-05-18T08:00:00Z-acme-rev412',
    });
    assert.strictEqual(
      ok,
      true,
      `if_wholesale_feed_version-bearing request must validate: ${JSON.stringify(v.errors)}`
    );
    // The dependencies constraint (if_pricing_version requires if_wholesale_feed_version)
    // must still be enforced at runtime by Ajv after stripIfThenElse in codegen.
    const dependenciesViolation = v({
      adcp_version: ADCP_RELEASE_PRECISION,
      brief: 'wholesale catalog mirror probe',
      buying_mode: 'wholesale',
      if_pricing_version: 'v-pricing-only',
    });
    assert.strictEqual(
      dependenciesViolation,
      false,
      'if_pricing_version without if_wholesale_feed_version must be rejected by Ajv'
    );
    // Release-precision family pin resolves to the same on-disk bundle via
    // resolveSchemaRoot's prerelease fuzzy-match (a distinct compiled validator
    // instance, but loaded from the same schema files).
    const vRP = getValidator('get_products', 'request', ADCP_PRERELEASE_FAMILY);
    assert.ok(vRP, `${ADCP_PRERELEASE_FAMILY} must compile from the cached prerelease bundle`);
    assert.strictEqual(
      vRP({
        adcp_version: ADCP_RELEASE_PRECISION,
        brief: 'wholesale catalog mirror probe',
        buying_mode: 'wholesale',
        if_wholesale_feed_version: 'v2026-05-18T08:00:00Z-acme-rev412',
      }),
      true,
      `${ADCP_PRERELEASE_FAMILY} validator must accept the same wholesale-feed payload as ${ADCP_VERSION}`
    );

    const syncAccounts = getValidator('sync_accounts', 'request', ADCP_VERSION);
    assert.ok(syncAccounts, '3.1 prerelease sync_accounts::request must compile from the opt-in bundle');
    assert.strictEqual(
      syncAccounts({
        adcp_version: ADCP_RELEASE_PRECISION,
        idempotency_key: 'settings-notification-config',
        accounts: [
          {
            account: { account_id: 'acc_acme_pinnacle' },
            notification_configs: [
              {
                subscriber_id: 'wholesale-feed-sync',
                url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
                event_types: [
                  'product.created',
                  'product.updated',
                  'product.priced',
                  'product.removed',
                  'signal.created',
                  'signal.updated',
                  'signal.priced',
                  'signal.removed',
                  'wholesale_feed.bulk_change',
                ],
                active: true,
              },
            ],
          },
        ],
      }),
      true,
      `sync_accounts notification_configs with wholesale feed events must validate: ${JSON.stringify(syncAccounts.errors)}`
    );
  });

  test('ensureCoreLoaded narrowing keeps v3 bundled-path validators intact', () => {
    // Regression guard for the v2.5-schemas branch: when ensureCoreLoaded was
    // narrowed from "skip all fileIndex entries" to "skip only response tool
    // files" so v2.5 flat-tree fragments register, v3's bundled-path
    // validators must still resolve through getValidator unchanged. Bundled
    // and flat-tree request schemas have distinct $ids (bundled has
    // `/schemas/<v>/bundled/...` vs flat `/schemas/<v>/...`), so no
    // AJV-side collision; this test pins that invariant. Targets the
    // currently-shipped bundle (ADCP_VERSION); on 3.0.x it pinned '3.0.1'.
    _resetValidationLoader(ADCP_VERSION);
    const v = getValidator('create_media_buy', 'request', ADCP_VERSION);
    assert.ok(v, 'v3 create_media_buy::request must compile after narrowing');
    // Schema reference should point at the bundled file (the path the loader
    // selects when the bundled tree exists).
    const schema = v.schema;
    assert.match(
      schema.$id,
      /\/bundled\//,
      `expected bundled $id, got: ${schema.$id} — bundled-path priority must survive ensureCoreLoaded narrowing`
    );
  });

  test('getSchemaValidatorByRef compiles MCP webhook payload schema with nested refs', () => {
    _resetValidationLoader(ADCP_VERSION);
    const validate = getSchemaValidatorByRef('core/mcp-webhook-payload.json', ADCP_VERSION);
    assert.ok(validate, 'MCP webhook payload schema must compile');

    const ok = validate({
      idempotency_key: 'evt_schema_ref_0000001',
      operation_id: 'op_schema_ref',
      task_id: 'task_schema_ref',
      task_type: 'create_media_buy',
      status: 'completed',
      timestamp: '2026-05-26T09:00:44.582Z',
      result: {
        status: 'completed',
        media_buy_id: 'mb_1',
        packages: [],
      },
    });
    assert.strictEqual(ok, true, JSON.stringify(validate.errors));

    const missingEnvelopeFields = validate({
      idempotency_key: 'evt_schema_ref_0000001',
      task_id: 'task_schema_ref',
      task_type: 'create_media_buy',
      status: 'completed',
      result: { status: 'completed', media_buy_id: 'mb_1', packages: [] },
    });
    assert.strictEqual(missingEnvelopeFields, false, 'schema should reject missing operation_id and timestamp');
  });
});
