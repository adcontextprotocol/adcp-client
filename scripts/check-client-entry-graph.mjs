#!/usr/bin/env node
/**
 * Fails when a client-facing entry point's module graph reaches the server or
 * testing code (adcontextprotocol/adcp-client#3664).
 *
 * Each entry point is bundled from the built `dist/lib/` tree with esbuild, once
 * per export condition (`import` and `require`), and every SDK module in the
 * resulting metafile is checked. Dependencies stay external, so the inputs are
 * the SDK modules a Node process can load for that entry point. Lazy
 * `import()` and `require()` targets with literal specifiers count too: a
 * module the entry point can load later is still part of its graph. The ESM
 * build loads a few heavy modules through `createRequire`, which esbuild cannot
 * follow; the `require` pass sees the same modules, which is why both export
 * conditions are checked.
 *
 * The check asserts zero `dist/lib/server/` and `dist/lib/testing/` inputs
 * rather than a module-count budget, so unrelated growth never trips it.
 *
 *   npm run build:lib && npm run check:client-entry-graph
 *
 * The package root (`.`) and `./client` still re-export server and testing
 * helpers; they are measured and printed but not yet enforced.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Entry points whose graph must not include `server/` or `testing/` modules. */
export const LEAN_ENTRY_POINTS = Object.freeze([
  './client/core',
  './client/account-changes',
  './client/webhook-stores',
  './errors',
  './version',
  './registry',
  './utils',
  './discovery',
  './media-buy',
  './media-buy/actions',
]);

/** Entry points that are measured for the report but not yet enforced. */
export const REPORTED_ENTRY_POINTS = Object.freeze(['.', './client']);

const CONDITIONS = Object.freeze(['import', 'require']);
const FORBIDDEN_DIRS = Object.freeze(['dist/lib/server/', 'dist/lib/testing/']);

/**
 * Bundle one entry point for one export condition and classify its SDK inputs.
 *
 * @param {string} subpath package export key, e.g. `./errors`
 * @param {'import' | 'require'} condition
 * @returns {Promise<{ subpath: string, condition: string, file: string, modules: number, forbidden: string[] }>}
 */
export async function measureEntryGraph(subpath, condition, { root = ROOT } = {}) {
  const esbuild = require('esbuild');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const target = pkg.exports?.[subpath]?.[condition]?.default;
  if (typeof target !== 'string') {
    throw new Error(`package.json exports has no ${condition} target for ${subpath}`);
  }
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, target)],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    outfile: 'entry-graph.mjs',
  });
  const inputs = Object.keys(result.metafile.inputs).filter(input => input.startsWith('dist/lib/'));
  const forbidden = inputs.filter(input => FORBIDDEN_DIRS.some(dir => input.startsWith(dir))).sort();
  return { subpath, condition, file: target, modules: inputs.length, forbidden };
}

async function main() {
  const rows = [];
  for (const subpath of [...REPORTED_ENTRY_POINTS, ...LEAN_ENTRY_POINTS]) {
    for (const condition of CONDITIONS) rows.push(await measureEntryGraph(subpath, condition));
  }

  console.log('entry point                  condition  SDK modules  server/  testing/');
  for (const row of rows) {
    const server = row.forbidden.filter(file => file.startsWith('dist/lib/server/')).length;
    const testing = row.forbidden.length - server;
    console.log(
      `${row.subpath.padEnd(28)} ${row.condition.padEnd(10)} ${String(row.modules).padStart(11)}  ` +
        `${String(server).padStart(7)}  ${String(testing).padStart(8)}`
    );
  }

  const empty = rows.filter(row => row.modules === 0);
  if (empty.length > 0) {
    // Nothing matched `dist/lib/`, so nothing was checked (e.g. a symlinked dist).
    console.error('\nNo SDK modules resolved for:');
    for (const row of empty) console.error(`  ${row.subpath} (${row.condition}) -> ${row.file}`);
    process.exitCode = 1;
    return;
  }

  const failures = rows.filter(row => LEAN_ENTRY_POINTS.includes(row.subpath) && row.forbidden.length > 0);
  if (failures.length > 0) {
    console.error('\nClient entry points must not load server/ or testing/ modules:');
    for (const row of failures) {
      console.error(`  ${row.subpath} (${row.condition}): ${row.forbidden.join(', ')}`);
    }
    console.error(
      '\nMove the shared code out of src/lib/server/ or src/lib/testing/ (leave a re-export there for deep imports),' +
        ' or stop importing it from the client-side module.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n${LEAN_ENTRY_POINTS.length} client entry points load no server/ or testing/ modules.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
