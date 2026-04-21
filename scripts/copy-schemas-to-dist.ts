#!/usr/bin/env tsx
/**
 * Copy the bundled + core JSON schemas into the built package so the
 * runtime validator (src/lib/validation/schema-loader.ts) can read them
 * without a dependency on the source tree.
 *
 * Source: schemas/cache/<ver>/{bundled,core,<domain>}/
 * Dest:   dist/lib/schemas-data/<ver>/{bundled,core,<domain>}/
 *
 * Invoked by the `build:lib` npm script after tsc emits JS.
 */

import { cpSync, existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const versionFile = path.join(repoRoot, 'ADCP_VERSION');
  if (!existsSync(versionFile)) {
    throw new Error(`ADCP_VERSION file not found at ${versionFile}`);
  }
  const version = readFileSync(versionFile, 'utf-8').trim();
  if (!version) throw new Error('ADCP_VERSION file is empty.');

  const srcRoot = path.join(repoRoot, 'schemas', 'cache', version);
  if (!existsSync(srcRoot)) {
    // The schema cache is fetched by `sync-schemas`. CI jobs that don't run
    // the full toolchain (e.g., the code-quality integrity check that does
    // `npm clean && build:lib` without a prior sync-schemas) would otherwise
    // break here. Skip quietly — the loader falls back to the same source
    // path, and any job that actually needs the schemas at runtime will get
    // a clear error at first use.
    console.warn(
      `[copy-schemas-to-dist] schema cache missing at ${srcRoot}; skipping. ` +
        `Run \`npm run sync-schemas\` to populate it before shipping.`
    );
    return;
  }

  const destRoot = path.join(repoRoot, 'dist', 'lib', 'schemas-data', version);
  mkdirSync(destRoot, { recursive: true });

  // Copy bundled/ and every per-domain directory except registry extras.
  // The async response variants live in the flat per-domain tree; we need
  // them plus bundled/ (sync) and core/ (ref targets for async).
  cpSync(srcRoot, destRoot, {
    recursive: true,
    // Skip heavy subtrees that the runtime validator doesn't read.
    filter: src => {
      const rel = path.relative(srcRoot, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (top === 'tmp' || top === 'compliance') return false;
      return true;
    },
  });

  console.log(`[copy-schemas-to-dist] copied ${srcRoot} → ${destRoot}`);
}

main();
