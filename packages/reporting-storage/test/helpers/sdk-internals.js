'use strict';
/**
 * Test-only access to two SDK internals that have no public export: the response validator and the
 * schema-by-ref validator. The package's `src/` imports `@adcp/sdk` through public subpaths only; tests
 * may validate wire payloads against the SDK's bundled schemas through its built `dist/lib` in this
 * workspace, which the test run always builds first.
 */
const path = require('node:path');

const sdkDist = path.resolve(__dirname, '..', '..', '..', '..', 'dist', 'lib');

module.exports = {
  validateResponse: require(path.join(sdkDist, 'validation', 'schema-validator.js')).validateResponse,
  getSchemaValidatorByRef: require(path.join(sdkDist, 'validation', 'schema-loader.js')).getSchemaValidatorByRef,
};
