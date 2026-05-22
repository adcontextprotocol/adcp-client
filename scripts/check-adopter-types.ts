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

// Heap ceiling for the adopter tsc pass. The published .d.ts surface across
// `@adcp/sdk` + `@adcp/sdk/server` pulls in the full 3.1 codegen graph
// (~25K lines of generated types). On Node's default 4 GiB heap, tsc OOMs
// during type instantiation before it can emit diagnostics. 8 GiB clears
// the current surface with headroom; revisit if the schema cache grows
// substantially.
const TSC_HEAP_MB = 8192;

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

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: env ?? process.env });
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

  // @types/express, @opentelemetry/api, and redis cover transitive type
  // references from the server bundle — adopters who import
  // `@adcp/sdk/server` need these (express is the HTTP adapter,
  // opentelemetry is the optional observability peer, redis is the
  // optional peer for the Redis backends). Installing them here scopes
  // this guard to detection of `@internal`-leak class bugs (issue #1236)
  // without flagging the orthogonal "transitive types not auto-installed"
  // class, which is tracked separately.
  //
  // Why `redis` here when `pg` is NOT installed: the pg backends type
  // their public surface via the project-local `PgQueryable` shape (no
  // `import type` from `pg`), so the published `.d.ts` has no `pg`
  // reference. The Redis backends deliberately type their public surface
  // as `RedisClientType<any,any,any> | <NarrowInterface>` so node-redis
  // users pass `createClient(...)` without casts — that DX win requires
  // the adopter type-checker to be able to resolve `redis`. We install
  // it here for the same reason we install `@types/express`: the adopter
  // using these backends will have it, and the check exists to validate
  // the adopter experience, not to enforce zero-peer-dep types.
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
      'redis',
    ],
    adopterDir
  );

  console.log('[adopter-types] running tsc --noEmit against published types...');
  const tscEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${TSC_HEAP_MB}`.trim(),
  };
  try {
    run('npx', ['--no-install', 'tsc', '--noEmit'], adopterDir, tscEnv);
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
