#!/usr/bin/env tsx
/**
 * Vendor the AAO canonical-formats catalog
 * (`test/lib/v2-projection-fixtures/aao-reference-formats.json`) into
 * `dist/lib/v2/projection/aao-reference-formats.json` so the v1↔v2
 * projection loader can find it after `npm install`.
 *
 * The loader at `src/lib/v2/projection/catalog.ts` looks adjacent to its
 * compiled location first; the source-tree `test/` path stays as a dev
 * fallback (tests, tsx, vitest) but is not in the published `files`
 * glob.
 *
 * Invoked by `build:lib` after `tsc` emits the loader.
 */

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const src = path.join(repoRoot, 'test', 'lib', 'v2-projection-fixtures', 'aao-reference-formats.json');
  const destDir = path.join(repoRoot, 'dist', 'lib', 'v2', 'projection');
  const dest = path.join(destDir, 'aao-reference-formats.json');

  if (!existsSync(src)) {
    throw new Error(
      `[copy-v2-projection-catalog] source fixture missing: ${src}. ` +
        `The published bundle requires this file — see ` +
        `src/lib/v2/projection/catalog.ts loader resolution order.`
    );
  }

  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-v2-projection-catalog] copied ${src} → ${dest}`);
}

main();
