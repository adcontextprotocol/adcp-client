// getSchemaDataRoots() gives the 7 schema/data loaders one shared anchor for
// the two directories they each used to locate via hand-tuned `__dirname`
// arithmetic: the built (dist) schemas-data tree and the source-tree
// schemas/cache tree.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { getSchemaDataRoots } = require('../../dist/lib/internal/schema-data-roots.js');

describe('getSchemaDataRoots', () => {
  test('builtSchemasDataRoot points at dist/lib/schemas-data under the package root', () => {
    const { builtSchemasDataRoot } = getSchemaDataRoots();
    assert.strictEqual(builtSchemasDataRoot, path.join(REPO_ROOT, 'dist', 'lib', 'schemas-data'));
  });

  test('sourceSchemasCacheRoot points at schemas/cache under the package root', () => {
    const { sourceSchemasCacheRoot } = getSchemaDataRoots();
    assert.strictEqual(sourceSchemasCacheRoot, path.join(REPO_ROOT, 'schemas', 'cache'));
  });
});
