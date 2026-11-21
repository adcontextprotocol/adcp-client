// Importing the SDK does not register the draft identity schemas with Ajv; the
// first validateIdentity33Schema call does, once. Observed in a fresh child
// process by counting Ajv.prototype.addSchema calls on the SDK's own `ajv`
// dependency for documents carrying the identity draft `$id`s (`/schemas/...`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SDK_ROOT = path.resolve(__dirname, '../..');

const CHILD = String.raw`
const path = require('node:path');
const sdkRoot = process.env.SDK_ROOT;
const ajvModule = require(require.resolve('ajv', { paths: [sdkRoot] }));
const Ajv = ajvModule.default || ajvModule;
let identitySchemaAdds = 0;
const original = Ajv.prototype.addSchema;
Ajv.prototype.addSchema = function countingAddSchema(schema, ...rest) {
  const schemas = Array.isArray(schema) ? schema : [schema];
  for (const s of schemas) if (s && typeof s.$id === 'string' && s.$id.startsWith('/schemas/')) identitySchemaAdds++;
  return original.call(this, schema, ...rest);
};
require(path.join(sdkRoot, process.env.ENTRY));
const afterImport = identitySchemaAdds;
const { validateIdentity33Schema } = require(path.join(sdkRoot, 'dist/lib/identity-3.3'));
const afterImportBoth = identitySchemaAdds;
const results = {
  validBrandId: validateIdentity33Schema('core/brand-id', 'air_jordan'),
  invalidBrandId: validateIdentity33Schema('core/brand-id', 'Air Jordan'),
};
const afterFirstValidation = identitySchemaAdds;
results.unknownSchema = validateIdentity33Schema('core/not-an-identity-schema', {});
results.validAgain = validateIdentity33Schema('core/brand-id', 'tide');
const afterRepeatValidation = identitySchemaAdds;
process.stdout.write(JSON.stringify({ afterImport, afterImportBoth, afterFirstValidation, afterRepeatValidation, results }));
`;

function runChild(entry) {
  const child = spawnSync(process.execPath, ['-e', CHILD], {
    cwd: SDK_ROOT,
    env: { ...process.env, SDK_ROOT, ENTRY: entry, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.status, 0, `child for ${entry} exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

for (const entry of ['dist/lib/index.js', 'dist/lib/identity-3.3/index.js', 'dist/lib/identity-3.3/trust.js']) {
  test(`importing ${entry} registers no identity schema until validateIdentity33Schema runs`, () => {
    const observed = runChild(entry);
    assert.equal(observed.afterImport, 0, `identity schemas registered at import: ${JSON.stringify(observed)}`);
    assert.equal(observed.afterImportBoth, 0, 'requiring the identity entry alone registers nothing either');
    assert.ok(observed.afterFirstValidation > 0, 'the first validation registers the identity schemas');
    assert.equal(
      observed.afterRepeatValidation,
      observed.afterFirstValidation,
      'later validations reuse the registered schemas'
    );
    assert.deepEqual(observed.results, {
      validBrandId: true,
      invalidBrandId: false,
      unknownSchema: false,
      validAgain: true,
    });
  });
}
