#!/usr/bin/env tsx
/**
 * Copy every `schemas/cache/<ver>/` directory into the built package so the
 * runtime validator (src/lib/validation/schema-loader.ts) can read them
 * without a dependency on the source tree.
 *
 * Source: schemas/cache/<ver>/{bundled,core,<domain>}/
 * Dest:   dist/lib/schemas-data/<ver>/{bundled,core,<domain>}/
 *
 * Stage 3 (per-instance schema selection) requires that every supported AdCP
 * version's bundle ship inside the npm tarball, not just the one currently
 * pinned in `ADCP_VERSION`. Consumers that pin `adcpVersion: '3.0.0'` in their
 * client config get the 3.0.0 schemas; consumers that pin `'3.0.1'` (or omit
 * the option and inherit the SDK default) get the 3.0.1 schemas. The bundle
 * grows by ~50–100 KB per AdCP minor — tolerable indefinitely; if it ever
 * becomes a problem, drop schemas more than two majors old at SDK major bumps.
 *
 * Skipped from copy:
 *   - `latest` symlink — duplicates a real version directory
 *   - `*.previous` backup snapshots from `sync-schemas` replaceTree
 *   - `tmp/`, `compliance/` subtrees — runtime validator doesn't read them
 *
 * Invoked by the `build:lib` npm script after tsc emits JS.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const cacheRoot = path.join(repoRoot, 'schemas', 'cache');
  if (!existsSync(cacheRoot)) {
    // The schema cache is fetched by `sync-schemas`. CI jobs that don't run
    // the full toolchain (e.g., the code-quality integrity check that does
    // `npm clean && build:lib` without a prior sync-schemas) would otherwise
    // break here. Skip quietly — the loader falls back to the same source
    // path, and any job that actually needs the schemas at runtime will get
    // a clear error at first use.
    console.warn(
      `[copy-schemas-to-dist] schemas/cache/ missing; skipping. ` +
        `Run \`npm run sync-schemas\` to populate it before shipping.`
    );
    return;
  }

  const destBase = path.join(repoRoot, 'dist', 'lib', 'schemas-data');
  let copied = 0;

  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    // `latest` is a symlink to the current default version; the loader
    // resolves versions by name, not via that alias, so skip the duplicate.
    if (entry.name === 'latest') continue;
    // `*.previous` are sync-schemas replaceTree backup snapshots.
    if (entry.name.endsWith('.previous')) continue;
    if (!entry.isDirectory()) {
      // Defensive: skip non-directory entries (loose files, broken symlinks).
      // `lstatSync` rather than `entry.isDirectory()` so a symlink-to-dir
      // doesn't masquerade as a real version when the link target is gone.
      const abs = path.join(cacheRoot, entry.name);
      try {
        if (!lstatSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
    }

    const version = entry.name;
    const srcRoot = path.join(cacheRoot, version);
    const destRoot = path.join(destBase, version);
    mkdirSync(destRoot, { recursive: true });

    // Copy bundled/ and every per-domain directory; the async response
    // variants live in the flat per-domain tree, plus bundled/ (sync) and
    // core/ (ref targets for async).
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
    copied++;
  }

  if (copied === 0) {
    console.warn(`[copy-schemas-to-dist] no version directories under ${cacheRoot}; bundle ships without schemas.`);
  }
}

main();
