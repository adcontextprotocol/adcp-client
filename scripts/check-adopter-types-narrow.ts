#!/usr/bin/env tsx
/**
 * Narrow-import adopter type-check guard for the per-tool `.d.ts`
 * slices emitted by `scripts/generate-per-tool-types.ts` (#1944 lever
 * 3).
 *
 * Packs the SDK as-shipped, scaffolds an adopter that imports a single
 * per-tool slice via the `@adcp/sdk/types/<tool>` subpath, and runs
 * `tsc --noEmit` against it under a tight heap cap. The per-tool
 * slices are self-contained — an adopter pulling in only
 * `sync-accounts` should peak at well under 256 MB, vs the 4-6 GB the
 * full surface needs. Regression here would mean the extractor's
 * dependency walk missed a transitive reference, or the slice picked
 * up a stray non-self-contained `import` somewhere.
 *
 * The companion `check-adopter-types.ts` exercises the root surface
 * (`@adcp/sdk` / `@adcp/sdk/server`) and is intentionally generous
 * with the heap. This script enforces the opposite end of the same
 * design: tight memory for narrow imports.
 *
 * @public
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolNameToKebab, toolNameToPascal } from './generate-per-tool-types';

const REPO_ROOT = join(__dirname, '..');

// Heap cap for the narrow tsc run. The `sync_accounts` slice peaks at
// ~50 MB on this codegen; 512 MB gives generous headroom for future
// growth without masking a real regression. If the slice ever needs
// significantly more, the dependency walk has probably gone wrong.
const NARROW_HEAP_MB = 512;

// Tools to exercise. Keep the list short — every entry is one tsc
// invocation. Pick tools that span the dependency-closure variety
// AND the toolNameToPascal carve-outs (`adcp`, `si`) so the guard
// surfaces both extractor and naming-helper regressions.
const NARROW_TOOLS = [
  'sync_accounts', // dense envelope + provisioning union
  'create_media_buy', // wide deps via creative manifest
  'get_products', // wholesale-feed branch + cache_scope
  'get_adcp_capabilities', // exercises the `adcp` AdCP carve-out
  'si_get_offering', // exercises the `si` SI carve-out
];

// `moduleResolution: node16` (or newer: nodenext / bundler) is required
// to resolve the `@adcp/sdk/types/<tool>` subpath via the
// `package.json` `exports` field. Most modern adopters already use
// node16+; older `moduleResolution: node` adopters fall back to the
// root `@adcp/sdk` import and won't see the per-tool slices at all,
// which is the same compatibility surface as today.
const ADOPTER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'node16',
    moduleResolution: 'node16',
    esModuleInterop: true,
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: ['node'],
    ignoreDeprecations: '6.0',
  },
  include: ['adopter.ts'],
};

function adopterSource(toolName: string): string {
  const pascal = toolNameToPascal(toolName);
  const kebab = toolNameToKebab(toolName);
  // The slice always exports `${Pascal}Request` and `${Pascal}Response`
  // because the extractor seeds from those names. Other variants
  // (Success/Error/Submitted) are present when they exist on the spec.
  return `
import type { ${pascal}Request, ${pascal}Response } from '@adcp/sdk/types/${kebab}';

declare const _req: ${pascal}Request;
declare const _res: ${pascal}Response;
void _req;
void _res;
`;
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: env ?? process.env });
}

function main(): void {
  console.log('[narrow-types] packing SDK...');
  const tarballDir = mkdtempSync(join(tmpdir(), 'adcp-narrow-pack-'));
  let exitCode = 0;
  try {
    run('npm', ['pack', '--pack-destination', tarballDir, '--silent'], REPO_ROOT);
    const tarball = readdirSync(tarballDir).find(f => f.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack did not produce a tarball');
    const tarballPath = join(tarballDir, tarball);

    let failed = 0;
    for (const tool of NARROW_TOOLS) {
      const kebab = toolNameToKebab(tool);
      console.log(`[narrow-types] scaffolding ${tool} adopter...`);
      const adopterDir = mkdtempSync(join(tmpdir(), `adcp-narrow-${kebab}-`));
      writeFileSync(
        join(adopterDir, 'package.json'),
        JSON.stringify({ name: `narrow-${kebab}`, version: '0.0.0', private: true })
      );
      writeFileSync(join(adopterDir, 'tsconfig.json'), JSON.stringify(ADOPTER_TSCONFIG, null, 2));
      writeFileSync(join(adopterDir, 'adopter.ts'), adopterSource(tool));

      run(
        'npm',
        ['install', '--no-audit', '--no-fund', '--silent', tarballPath, 'typescript', '@types/node'],
        adopterDir
      );

      // Verify the published package actually exposes the subpath we
      // expect — protects against `exports` map regressions and slice
      // emission misses.
      const slicePath = join(adopterDir, 'node_modules', '@adcp', 'sdk', 'dist', 'lib', 'types', `${kebab}.d.ts`);
      if (!existsSync(slicePath)) {
        console.error(`[narrow-types] FAIL — ${slicePath} missing from packed tarball`);
        failed++;
        continue;
      }

      console.log(`[narrow-types] running tsc --noEmit on ${tool} slice...`);
      const tscEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${NARROW_HEAP_MB}`].filter(Boolean).join(' '),
      };
      try {
        run('npx', ['--no-install', 'tsc', '--noEmit'], adopterDir, tscEnv);
        console.log(`[narrow-types] PASS — ${tool}`);
        rmSync(adopterDir, { recursive: true, force: true });
      } catch {
        console.error(`[narrow-types] FAIL — ${tool} slice does not type-check at ${NARROW_HEAP_MB} MB heap`);
        console.error(`  Scaffold preserved at: ${adopterDir}`);
        failed++;
        // Scaffold preserved on purpose for debugging — don't clean up.
      }
    }

    if (failed > 0) {
      console.error(`[narrow-types] ${failed} of ${NARROW_TOOLS.length} narrow imports failed`);
      exitCode = 1;
    } else {
      console.log(
        `[narrow-types] ${NARROW_TOOLS.length}/${NARROW_TOOLS.length} per-tool slices type-check cleanly at ${NARROW_HEAP_MB} MB heap`
      );
    }
  } finally {
    // Always clean the tarball directory even on failure — preserving
    // it leaks across CI runs and gives no debugging value (the .tgz
    // is reproducible from `npm pack`).
    rmSync(tarballDir, { recursive: true, force: true });
  }
  if (exitCode !== 0) process.exit(exitCode);
}

main();
