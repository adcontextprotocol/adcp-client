/**
 * Native controller-schema packaging on maintained SDK16.
 *
 * Adapted from the reviewed a3c4 main regression, using only actual retained
 * 3.0.25 / 3.1.33 / primary 3.2.10 schemas. The older controller declares neither
 * account nor brand and composes no protocol envelope; later releases declare
 * the sandbox account carrier and require task status on responses. Keep these
 * contracts distinct rather than imposing newer fields on the frozen release.
 *
 * `SELECTED` names the release each shipped bundle actually resolves to, not
 * every corpus the package carries. Schema bundles collapse by minor and ship
 * the highest patch, so the `3.1` bundle selects 3.1.33 once that release is
 * adopted.
 *
 * `CACHE_ROOT` below is `schemas/cache` — JSON schema inputs. It is NOT the
 * storyboard corpus at `compliance/cache/<version>/`, and nothing in this file
 * inspects that corpus or proves its packaged byte identity. Retention of the
 * 3.1.30 corpus is a separate claim with its own separate evidence: the real
 * pre/post-sync hashes of `compliance/cache/3.1.30/` taken at adoption time,
 * plus the actual `npm pack` and installed-package bytes. Do not read anything
 * here as that guarantee.
 *
 * The reachable closure currently equals each compliance directory. These
 * tests therefore prove native compilation, byte identity and real versioned
 * payload behavior; they do not claim to distinguish today's closure from an
 * unfiltered directory copy.
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
const SELECTED = [
  { key: '3.0', version: '3.0.25', declaresAccount: false, protocolEnvelope: false, closureSize: 2 },
  // closureSize here is the expectation to re-confirm against the real published
  // 3.1.33 corpus at adoption time; a wrong value fails this suite loudly rather
  // than passing silently, which is the intended behaviour.
  { key: '3.1', version: '3.1.33', declaresAccount: true, protocolEnvelope: true, closureSize: 2 },
  { key: '3.2', version: '3.2.10', declaresAccount: true, protocolEnvelope: true, closureSize: 4 },
];
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function shippedBundles() {
  return readdirSync(BUNDLE_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      key: entry.name,
      version: readJson(path.join(BUNDLE_ROOT, entry.name, 'index.json')).adcp_version,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Independent closure check: a deliberately looser reference matcher than the
 * production basename/containment filter, so rejected published reference
 * forms surface as a mismatch instead of agreeing with the copy by construction.
 */
function expectedClosure(version) {
  const dir = path.join(CACHE_ROOT, version, 'compliance');
  const selected = new Set();
  const pending = [...ENTRY_POINTS];
  while (pending.length > 0) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    const file = path.join(dir, name);
    assert.ok(existsSync(file), `${version} published closure dependency is missing: ${name}`);
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

function nativeValidator(version, direction) {
  const ref = `compliance/comply-test-controller-${direction}.json`;
  const doc = getSchemaDocumentByRef(ref, version);
  assert.ok(doc, `${version}/${ref} is missing from native dist`);
  assert.equal(doc.resolvedVersion, version);
  assert.ok(String(doc.schema.$id).endsWith(`/schemas/${version}/${ref}`));
  const validate = getSchemaValidatorByRef(ref, version, undefined, { allErrors: true });
  assert.equal(typeof validate, 'function', `${version}/${ref} did not compile`);
  assert.equal(validate.schema.$id, doc.schema.$id, 'compiled ID must bind the selected native document');
  return { doc, validate };
}

function hasProtocolEnvelope(schema) {
  return (schema.allOf ?? []).some(part => String(part.$ref ?? '').endsWith('/core/protocol-envelope.json'));
}

function assertValid(validate, value, reason) {
  assert.equal(validate(value), true, `${reason}: ${JSON.stringify(validate.errors)}`);
}

describe('SDK16 native controller schemas', () => {
  test('only the actual retained stable schema releases are selected', () => {
    assert.ok(existsSync(CACHE_ROOT), 'run the normal build/schema ensure before this test');
    assert.deepEqual(
      shippedBundles(),
      SELECTED.map(({ key, version }) => ({ key, version }))
    );
  });

  for (const { key, version, declaresAccount, protocolEnvelope, closureSize } of SELECTED) {
    describe(`${key} selected from ${version}`, () => {
      test('both native entry points resolve and compile at the selected release', () => {
        nativeValidator(version, 'request');
        nativeValidator(version, 'response');
      });

      test('all copied native compliance files are byte-identical to the published cache', () => {
        const dir = path.join(BUNDLE_ROOT, key, 'compliance');
        for (const name of readdirSync(dir)) {
          const published = path.join(CACHE_ROOT, version, 'compliance', name);
          assert.ok(existsSync(published), `${version}/${name} was not published`);
          assert.equal(sha256(path.join(dir, name)), sha256(published), `${key}/${name} drifted`);
        }
      });

      test('the exact reachable controller closure ships with every entry point', () => {
        const shipped = readdirSync(path.join(BUNDLE_ROOT, key, 'compliance')).sort();
        for (const name of ENTRY_POINTS) assert.ok(shipped.includes(name), `${key} lacks ${name}`);
        const expected = [...expectedClosure(version)].sort();
        assert.equal(expected.length, closureSize, 'revisit the real published closure if it changes');
        assert.deepEqual(shipped, expected);
      });

      test('success and refusal payloads obey this release account/status contract', () => {
        const { doc: requestDoc, validate: request } = nativeValidator(version, 'request');
        const { doc: responseDoc, validate: response } = nativeValidator(version, 'response');
        const publishedRequest = readJson(path.join(CACHE_ROOT, version, 'compliance', ENTRY_POINTS[0]));
        const publishedResponse = readJson(path.join(CACHE_ROOT, version, 'compliance', ENTRY_POINTS[1]));
        assert.deepEqual(requestDoc.schema, publishedRequest);
        assert.deepEqual(responseDoc.schema, publishedResponse);
        assert.equal(Object.hasOwn(publishedRequest.properties ?? {}, 'account'), declaresAccount);
        assert.equal(hasProtocolEnvelope(publishedResponse), protocolEnvelope);
        const params = { scenario: 'force_account_status', params: { account_id: 'acct_test', status: 'suspended' } };
        const account = { sandbox: true, brand: { domain: 'test.example' }, operator: 'test.example' };
        assertValid(request, { ...params, ...(declaresAccount && { account }) }, `${version} valid request`);
        assert.equal(request({ ...(declaresAccount && { account }) }), false, 'scenario remains required');
        if (declaresAccount) {
          assert.equal(request(params), false, 'the selected release requires its sandbox account carrier');
          assert.equal(request({ ...params, account: { ...account, sandbox: false } }), false);
        } else {
          assertValid(request, params, '3.0.25 has no required or declared account carrier');
        }
        const taskStatus = protocolEnvelope ? { status: 'completed' } : {};
        const transition = { success: true, previous_state: 'active', current_state: 'suspended' };
        const refusal = { success: false, error: 'NOT_FOUND' };
        assertValid(response, { ...taskStatus, ...transition }, `${version} transition`);
        assertValid(response, { ...taskStatus, ...refusal }, `${version} refusal`);
        assert.equal(response({ ...taskStatus, success: 'yes' }), false, 'success must be boolean');
        if (protocolEnvelope) {
          assert.equal(response(transition), false, `${version} requires root task status`);
          assert.equal(response(refusal), false, `${version} refusal requires root task status`);
        } else {
          assertValid(response, transition, '3.0.25 has no protocol-envelope status requirement');
          assertValid(response, refusal, '3.0.25 refusal has no task status requirement');
        }
      });

      test('native field gating and validator indexing use only declared carriers', () => {
        const published = readJson(path.join(CACHE_ROOT, version, 'compliance', ENTRY_POINTS[0]));
        assert.equal(Object.hasOwn(published.properties ?? {}, 'brand'), false);
        assert.equal(schemaAllowsTopLevelField('comply_test_controller', 'brand', version), false);
        assert.equal(schemaAllowsTopLevelField('comply_test_controller', 'account', version), declaresAccount);
        const keys = listValidatorKeys(version);
        assert.ok(keys.includes('comply_test_controller::request'));
        assert.ok(keys.includes('comply_test_controller::sync'));
      });
    });
  }

  test('primary 3.2.10 retains both transitive completion dependencies', () => {
    assert.deepEqual([...expectedClosure('3.0.25')].sort(), [...ENTRY_POINTS].sort());
    assert.deepEqual([...expectedClosure('3.1.33')].sort(), [...ENTRY_POINTS].sort());
    assert.deepEqual(
      [...expectedClosure('3.2.10')].sort(),
      [...ENTRY_POINTS, 'task-completion-data.json', 'get-creative-features-completion.json'].sort()
    );
  });

  test('the package file rules include native schemas without excluding compliance', () => {
    const files = readJson(path.join(REPO_ROOT, 'package.json')).files ?? [];
    assert.ok(files.includes('dist/lib/**/*'));
    for (const pattern of files) {
      assert.ok(!/^!dist\/lib\/schemas-data\/[^/]+\/compliance/.test(pattern), `native schemas excluded: ${pattern}`);
    }
  });
});
