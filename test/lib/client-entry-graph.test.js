// Client-facing entry points must not load the server or testing code
// (adcontextprotocol/adcp-client#3664). The check bundles each entry point from
// dist/ with esbuild and fails on any dist/lib/server/ or dist/lib/testing/
// input. The same check runs standalone as `npm run check:client-entry-graph`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = pathToFileURL(path.resolve(__dirname, '../../scripts/check-client-entry-graph.mjs')).href;

describe('client entry points load no server/ or testing/ modules', async () => {
  const { LEAN_ENTRY_POINTS, measureEntryGraph } = await import(SCRIPT);

  for (const subpath of LEAN_ENTRY_POINTS) {
    for (const condition of ['import', 'require']) {
      it(`${subpath} (${condition})`, async () => {
        const graph = await measureEntryGraph(subpath, condition);
        assert.ok(graph.modules > 0, `${subpath} resolved no SDK modules`);
        assert.deepStrictEqual(graph.forbidden, [], `${subpath} (${condition}) loads server/testing modules`);
      });
    }
  }

  it('measures the package root, which still re-exports server and testing helpers', async () => {
    // Not a budget: documents why `.` is reported rather than enforced until the
    // root stops re-exporting `./server` and `./testing` (#3664 step 2).
    const graph = await measureEntryGraph('.', 'import');
    assert.ok(graph.forbidden.length > 0);
  });
});
