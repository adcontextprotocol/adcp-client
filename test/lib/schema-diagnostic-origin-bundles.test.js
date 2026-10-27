const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ADCP_VERSION } = require('../../dist/lib/version');
const {
  getValidator,
  listValidatorKeys,
  resolveValidatorDiagnosticPath,
} = require('../../dist/lib/validation/schema-loader');

for (const version of new Set(['3.0.25', '3.1.29', '3.2.7', ADCP_VERSION])) {
  test(`${version}: every shipped request/sync root with its own errors retains diagnostic origins`, () => {
    let checked = 0;
    for (const key of listValidatorKeys(version)) {
      const [tool, direction] = key.split('::');
      if (direction !== 'request' && direction !== 'sync') continue;
      const validate = getValidator(tool, direction, version);
      assert.ok(validate, key);
      if (!validate.toString().includes('schemaPath:')) continue;
      const id = validate.schema.$id;
      assert.equal(typeof id, 'string', key);
      const rootPath = id.replace(/#.*$/, '') + '#';
      assert.ok(resolveValidatorDiagnosticPath(validate, rootPath), `${key}: own errors have no exact origin`);
      checked++;
    }
    assert.ok(checked > 50, `only ${checked} real roots were checked`);
  });
}
