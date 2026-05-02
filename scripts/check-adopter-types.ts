#!/usr/bin/env tsx
/**
 * Adopter type-check guard.
 *
 * Packs the SDK as it would ship to npm, scaffolds a minimal adopter
 * project that imports every public subpath, and runs `tsc --noEmit`
 * against it. Catches the class of bug where an internal symbol or
 * `declare`-only binding ends up referenced by a public `.d.ts` but
 * stripped from the emitted bundle — which compiles cleanly inside the
 * monorepo but fails on every adopter (issue #1236).
 *
 * Run via `npm run check:adopter-types`. Exits non-zero on any tsc
 * diagnostic against the scaffold.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');

const ADOPTER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: ['node'],
    ignoreDeprecations: '6.0',
  },
  include: ['adopter.ts'],
};

const ADOPTER_SOURCE = `
// Mirrors the repro from issue #1236 — minimal adopter import via the
// subpaths that produced TS2304 leaks (\`stripInternal\` deleted the
// declaration but consumers kept referencing it). Narrow on purpose:
// pulling \`@adcp/sdk/server\`'s full transitive surface drags in
// peerDependency type errors (express, @opentelemetry/api) that are
// orthogonal to this guard's scope. Widen when those are addressed.
import type { AdcpServer } from '@adcp/sdk/server';
import { createSingleAgentClient, extractAdcpErrorFromMcp, extractAdcpErrorFromTransport } from '@adcp/sdk';

declare const _server: AdcpServer;
void _server;
void createSingleAgentClient;
void extractAdcpErrorFromMcp;
void extractAdcpErrorFromTransport;
`;

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function main(): void {
  console.log('[adopter-types] packing SDK...');
  const tarballDir = mkdtempSync(join(tmpdir(), 'adcp-adopter-pack-'));
  run('npm', ['pack', '--pack-destination', tarballDir, '--silent'], REPO_ROOT);
  const tarball = readdirSync(tarballDir).find(f => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack did not produce a tarball');
  const tarballPath = join(tarballDir, tarball);

  console.log('[adopter-types] scaffolding adopter project...');
  const adopterDir = mkdtempSync(join(tmpdir(), 'adcp-adopter-check-'));
  writeFileSync(
    join(adopterDir, 'package.json'),
    JSON.stringify({ name: 'adopter-types-check', version: '0.0.0', private: true })
  );
  writeFileSync(join(adopterDir, 'tsconfig.json'), JSON.stringify(ADOPTER_TSCONFIG, null, 2));
  writeFileSync(join(adopterDir, 'adopter.ts'), ADOPTER_SOURCE);

  // @types/express and @opentelemetry/api cover transitive type references
  // from the server bundle — adopters who import `@adcp/sdk/server` need
  // these (express is the HTTP adapter, opentelemetry is the optional
  // observability peer). Installing them here scopes this guard to
  // detection of `@internal`-leak class bugs (issue #1236) without flagging
  // the orthogonal "transitive types not auto-installed" class, which is
  // tracked separately.
  console.log('[adopter-types] installing tarball + adopter peers...');
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--silent',
      tarballPath,
      'typescript',
      '@types/node',
      '@types/express',
      '@opentelemetry/api',
    ],
    adopterDir
  );

  console.log('[adopter-types] running tsc --noEmit against published types...');
  try {
    run('npx', ['--no-install', 'tsc', '--noEmit'], adopterDir);
    console.log('[adopter-types] PASS — published .d.ts files type-check cleanly for an adopter.');
  } catch {
    console.error('[adopter-types] FAIL — published .d.ts files do not type-check on a clean adopter project.');
    console.error(`  Scaffold preserved at: ${adopterDir}`);
    console.error(`  Reproduce: cd ${adopterDir} && npx tsc --noEmit`);
    process.exit(1);
  }

  rmSync(tarballDir, { recursive: true, force: true });
  rmSync(adopterDir, { recursive: true, force: true });
}

main();
