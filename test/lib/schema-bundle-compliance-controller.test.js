/**
 * Packaging contract: the published `comply_test_controller` schemas ship inside the SDK's
 * schema bundle.
 *
 * Every supported AdCP release publishes `compliance/comply-test-controller-request.json` and
 * `compliance/comply-test-controller-response.json`, and the SDK tells adopters to drive that
 * tool. But `scripts/copy-schemas-to-dist.ts` excluded the whole `compliance/` subtree from
 * `dist/lib/schemas-data/`, so on an installed package
 * `getSchemaValidatorByRef('compliance/comply-test-controller-request.json', '3.1.31')` returned
 * `undefined` — no caller could validate either direction of the tool against the release it
 * pins, and `schemaAllowsTopLevelField` failed open for it.
 *
 * The copy now carries those two documents plus the sibling `compliance/` documents they `$ref`,
 * transitively, per selected version. 3.0.25 and 3.1.31 need only the two entry points; 3.2.8 and
 * 3.3.0-beta.4 publish a request schema that `$ref`s `compliance/task-completion-data.json`,
 * which `$ref`s `compliance/get-creative-features-completion.json` — omit either and AJV cannot
 * compile the validator. Nothing outside that closure is packaged.
 *
 * These assertions fail if the copy rule is reverted (no validator) or if the closure is trimmed
 * to the two entry points (3.2 / 3.3 compilation throws on the unresolvable `$ref`). They do NOT
 * currently distinguish the closure from an unfiltered copy of the directory: on all four
 * published caches the reachable closure IS the whole `compliance/` directory, so there is no
 * over-ship to catch yet. The load-bearing guards here are the per-version AJV compile, the
 * byte-identity check against the published cache, and real payload validation.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const {
  getSchemaDocumentByRef,
  getSchemaValidatorByRef,
  listValidatorKeys,
  schemaAllowsTopLevelField,
} = require('../../dist/lib/validation/schema-loader.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BUNDLE_ROOT = path.join(REPO_ROOT, 'dist', 'lib', 'schemas-data');
const CACHE_ROOT = path.join(REPO_ROOT, 'schemas', 'cache');

const ENTRY_POINTS = ['comply-test-controller-request.json', 'comply-test-controller-response.json'];

/** Bundle directory → the release it was cut from, read from the bundle's own index. */
function shippedBundles() {
  return readdirSync(BUNDLE_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const index = JSON.parse(readFileSync(path.join(BUNDLE_ROOT, entry.name, 'index.json'), 'utf8'));
      return { key: entry.name, version: index.adcp_version };
    })
    .filter(bundle => typeof bundle.version === 'string');
}

/**
 * The sibling `compliance/` documents reachable from the two entry points, per release.
 * Deliberately a looser, independent reimplementation of `complianceBundleFiles` — the ref regex
 * here is unanchored and has no basename charset — so a `$ref` form the production rule rejects
 * shows up as a mismatch instead of silently shipping a bundle that cannot compile.
 */
function expectedClosure(version) {
  const dir = path.join(CACHE_ROOT, version, 'compliance');
  const selected = new Set();
  const pending = [...ENTRY_POINTS];
  while (pending.length > 0) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    selected.add(name);
    for (const [, ref] of readFileSync(file, 'utf8').matchAll(/"\$ref"\s*:\s*"([^"]+)"/g)) {
      const sibling = new RegExp(
        `/schemas/${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/compliance/([^"/#]+\\.json)`
      ).exec(ref)?.[1];
      if (sibling) pending.push(sibling);
    }
  }
  return selected;
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('shipped schema bundle: comply_test_controller', () => {
  test('preconditions: the published caches this contract is measured against are present', () => {
    assert.ok(existsSync(CACHE_ROOT), `missing ${CACHE_ROOT} — run npm run build:lib (schemas:ensure)`);
    assert.ok(shippedBundles().length > 0, 'no schema bundles were built');
  });

  for (const { key, version } of shippedBundles()) {
    describe(`${key} (AdCP ${version})`, () => {
      test('both controller schemas resolve and compile from the shipped bundle', () => {
        const manifest = {};
        for (const name of ENTRY_POINTS) {
          const ref = `compliance/${name}`;
          const doc = getSchemaDocumentByRef(ref, version);
          assert.ok(doc, `${ref} is not in the shipped bundle for ${version}`);
          assert.equal(doc.resolvedVersion, version);
          assert.ok(
            String(doc.schema.$id).endsWith(`/schemas/${version}/${ref}`),
            `unexpected $id ${String(doc.schema.$id)} for ${version}/${ref}`
          );
          // Compiling walks the whole `$ref` graph: a trimmed closure throws here.
          const validator = getSchemaValidatorByRef(ref, version);
          assert.equal(typeof validator, 'function', `${ref} did not compile for ${version}`);
          manifest[name] = sha256(path.join(BUNDLE_ROOT, key, 'compliance', name));
        }
        assert.equal(Object.keys(manifest).length, 2, JSON.stringify(manifest));
      });

      test('the bundled files are byte-identical to the published cache', () => {
        for (const name of readdirSync(path.join(BUNDLE_ROOT, key, 'compliance'))) {
          const shipped = path.join(BUNDLE_ROOT, key, 'compliance', name);
          const published = path.join(CACHE_ROOT, version, 'compliance', name);
          assert.ok(existsSync(published), `${name} is not a published ${version} compliance schema`);
          assert.equal(sha256(shipped), sha256(published), `${key}/compliance/${name} drifted from the cache`);
        }
      });

      test('the bundle ships the reachable closure and nothing else from compliance/', () => {
        const shipped = new Set(readdirSync(path.join(BUNDLE_ROOT, key, 'compliance')));
        for (const name of ENTRY_POINTS) {
          // Checked before the set comparison: a renamed entry point would drop out of both the
          // shipped set and the computed closure, and the deepEqual alone would still pass.
          assert.ok(shipped.has(name), `${name} is an entry point and must ship, but is missing from ${key}`);
        }
        assert.deepEqual([...shipped].sort(), [...expectedClosure(version)].sort());
      });
    });
  }

  test('3.2.8 and 3.3.0-beta.4 carry the transitive dependency the entry points need', () => {
    // Pins the reason the closure exists rather than a literal two-file allowlist. If a future
    // release drops the dependency this fails loudly instead of silently over-shipping.
    for (const version of ['3.2.8', '3.3.0-beta.4']) {
      const closure = expectedClosure(version);
      assert.ok(
        closure.has('task-completion-data.json'),
        `${version} controller request no longer $refs task-completion-data.json — revisit the closure rule`
      );
      assert.ok(closure.has('get-creative-features-completion.json'), `${version} closure is incomplete`);
    }
    // 3.1.31 publishes only the two entry points, so the closure must not grow a third file.
    assert.deepEqual([...expectedClosure('3.1.31')].sort(), [...ENTRY_POINTS].sort());
  });

  test('the shipped request schema is usable for real controller payloads', () => {
    for (const version of ['3.1.31', '3.3.0-beta.4']) {
      const request = getSchemaValidatorByRef('compliance/comply-test-controller-request.json', version, undefined, {
        allErrors: true,
      });
      const response = getSchemaValidatorByRef('compliance/comply-test-controller-response.json', version, undefined, {
        allErrors: true,
      });
      assert.equal(
        request({
          scenario: 'force_account_status',
          account: { sandbox: true, brand: { domain: 'test.example' }, operator: 'test.example' },
          params: { account_id: 'acct_1', status: 'suspended' },
        }),
        true,
        `${version} request: ${JSON.stringify(request.errors)}`
      );
      assert.equal(request({ account: { sandbox: true } }), false, `${version} must require scenario`);
      assert.equal(
        response({ status: 'completed', success: true, previous_state: 'active', current_state: 'suspended' }),
        true,
        `${version} transition: ${JSON.stringify(response.errors)}`
      );
      assert.equal(
        response({ status: 'completed', success: false, error: 'NOT_FOUND' }),
        true,
        `${version} refusal: ${JSON.stringify(response.errors)}`
      );
      assert.equal(
        response({ status: 'completed', success: 'yes' }),
        false,
        `${version} must reject a non-boolean success`
      );
    }
  });

  test('the package does not exclude the newly bundled compliance schemas', () => {
    const files = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).files ?? [];
    for (const pattern of files) {
      if (!pattern.startsWith('!')) continue;
      assert.ok(
        !/^!dist\/lib\/schemas-data\/[^/]+\/compliance/.test(pattern),
        `package.json files excludes the bundled controller schemas: ${pattern}`
      );
    }
  });

  test('the controller is now indexed, so field gating uses its declared carriers', () => {
    // Consequence of shipping the schemas, and the reason this is a fix rather than a packaging
    // detail: `schemaAllowsTopLevelField` no longer fails open for the controller. The published
    // request declares `scenario`, `params`, `context`, `ext` and `account` — not a top-level
    // `brand`. `additionalProperties: true` means the runner's old top-level `brand` was a
    // schema-valid extension, not an invalid request; it was simply undeclared and non-canonical,
    // and the authoritative carrier for identity here is `account`. With the schema available the
    // normal field gate applies and that undeclared injection stops. `account` is declared and
    // still allowed. Nothing in the controller-touching suites depended on the injection.
    assert.equal(schemaAllowsTopLevelField('comply_test_controller', 'brand', '3.1.31'), false);
    assert.equal(schemaAllowsTopLevelField('comply_test_controller', 'account', '3.1.31'), true);
    for (const version of ['3.0.25', '3.1.31', '3.2.8', '3.3.0-beta.4']) {
      const keys = listValidatorKeys(version);
      assert.ok(keys.includes('comply_test_controller::request'), `${version} request validator not indexed`);
      assert.ok(keys.includes('comply_test_controller::sync'), `${version} response validator not indexed`);
    }
  });
});
