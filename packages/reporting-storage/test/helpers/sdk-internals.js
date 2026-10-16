'use strict';
/**
 * Test-only access to two SDK internals that have no public export: the response validator and the
 * schema-by-ref validator. The package's `src/` imports `@adcp/sdk` through public subpaths only; tests
 * may validate wire payloads against the SDK's bundled schemas through its built `dist/lib` in this
 * workspace, which the test run always builds first.
 */
const { existsSync } = require('node:fs');
const path = require('node:path');

// The SDK this package resolves (the workspace root here), not a guessed relative path.
const sdkDist = path.join(path.dirname(require.resolve('@adcp/sdk/package.json')), 'dist', 'lib');
if (!existsSync(path.join(sdkDist, 'validation', 'schema-validator.js'))) {
  throw new Error(`${sdkDist} is not built. Run \`npm run build\` at the repository root first.`);
}

module.exports = {
  validateResponse: require(path.join(sdkDist, 'validation', 'schema-validator.js')).validateResponse,
  getSchemaValidatorByRef: require(path.join(sdkDist, 'validation', 'schema-loader.js')).getSchemaValidatorByRef,
};
