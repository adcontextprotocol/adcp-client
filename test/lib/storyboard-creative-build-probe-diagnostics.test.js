const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCreativeBuildProbe } = require('../../dist/lib/testing');
const { getSchemaValidatorByRef, withExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader');

let temporaryRoot;
before(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-probe-diagnostics-'));
  fs.cpSync(path.join(__dirname, '../../dist/lib/schemas-data/3.2'), temporaryRoot, { recursive: true });
  // A future trusted schema can admit dictionaries whose keys originate with
  // the producer. Exercise actual AJV paths, not hand-written error objects.
  for (const ref of ['core/creative-operation-format-declaration.json', 'formats/canonical/image.json']) {
    const file = path.join(temporaryRoot, ref);
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    schema.properties.diagnostic_dictionary = { type: 'object', additionalProperties: { type: 'number' } };
    fs.writeFileSync(file, JSON.stringify(schema));
  }
});
after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

for (const location of ['format', 'params']) {
  test(`actual ${location} AJV diagnostics escape and bound producer dictionary keys`, () => {
    const key = '\x1b[31mspoof\nrow\r\t\x7f\u009b\u2028\u2029' + 'x'.repeat(10000);
    const format = { format_kind: 'image', params: {} };
    const dictionary = { [key]: 'not a number' };
    (location === 'format' ? format : format.params).diagnostic_dictionary = dictionary;
    const creative = { supports_transformation: true, supported_formats: [{ capability_id: 'build', format }] };
    const original = structuredClone(creative);
    withExternalSchemaRoot('3.2.5', temporaryRoot, () => {
      const validate = getSchemaValidatorByRef(
        location === 'format' ? 'core/creative-operation-format-declaration.json' : 'formats/canonical/image.json',
        '3.2.5'
      );
      assert.equal(validate(location === 'format' ? format : format.params), false);
      assert.ok(
        validate.errors.some(error => error.instancePath.includes(key)),
        'the schema produces a real hostile instancePath'
      );
      const result = resolveCreativeBuildProbe(
        creative,
        { context_prefix: 'build', message: 'Build' },
        {
          creative_build_probes: [
            {
              match: [{ path: '/capability_id', operator: 'equals', value: 'build' }],
              input: { creative_manifest: { format_kind: 'image', assets: {} } },
            },
          ],
        },
        '3.2.5'
      );
      assert.equal(result.status, 'failed');
      assert.doesNotMatch(result.detail, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      assert.ok(result.detail.includes('\\u001b'));
      assert.ok(result.detail.includes('\\n'));
      assert.ok(result.detail.length < 2200);
    });
    assert.deepEqual(creative, original);
  });
  test(`valid ${location} dictionary remains resolvable with provisioned input`, () => {
    const format = { format_kind: 'image', params: {} };
    (location === 'format' ? format : format.params).diagnostic_dictionary = { trusted_key: 3 };
    const creative = { supports_transformation: true, supported_formats: [{ capability_id: 'build', format }] };
    const original = structuredClone(creative);
    const result = withExternalSchemaRoot('3.2.5', temporaryRoot, () =>
      resolveCreativeBuildProbe(
        creative,
        { context_prefix: 'build', message: 'Build' },
        {
          creative_build_probes: [
            {
              match: [{ path: '/capability_id', operator: 'equals', value: 'build' }],
              input: { creative_manifest: { format_kind: 'image', assets: {} } },
            },
          ],
        },
        '3.2.5'
      )
    );
    assert.equal(result.status, 'resolved');
    assert.equal(result.capabilityId, 'build');
    assert.deepEqual(creative, original);
  });
}
