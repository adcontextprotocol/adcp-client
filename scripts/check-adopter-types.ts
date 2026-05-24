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

// Heap ceiling for the adopter tsc pass. The published `.d.ts` surface
// across `@adcp/sdk` + `@adcp/sdk/server` pulls in the full 3.1 codegen
// graph (~25K lines of generated types) without the monorepo's
// project-wide tsconfig optimizations. On Node's default 4 GiB heap, tsc
// OOMs during type instantiation before it can emit diagnostics — so
// adopters debugging the published types get a heap-exhaustion stack
// trace, not a useful tsc error. 8 GiB clears the current surface with
// headroom; revisit if the schema cache grows substantially further.
const TSC_HEAP_MB = 8192;

const REPO_ROOT = join(__dirname, '..');

const ADOPTER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
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
// Mirrors the repro from issue #1236 and locks the server-side handler
// payload typing surface that adopters consume from a packed SDK tarball.
import type {
  AdcpServer,
  CheckGovernancePayload,
  CreatePropertyListPayload,
  ListContentStandardsPayload,
  OperationalContext,
  OperationalPlatform,
  SalesCorePlatform,
  SalesIngestionPlatform,
  ServerPayload,
  SIGetOfferingPayload,
} from '@adcp/sdk/server';
import { createAdcpServerFromPlatform, defineOperationalPlatform } from '@adcp/sdk/server';
import { createAdcpServer as createLegacyAdcpServer } from '@adcp/sdk/server/legacy/v5';
import { createSingleAgentClient, extractAdcpErrorFromMcp, extractAdcpErrorFromTransport } from '@adcp/sdk';
import type { CreateMediaBuySuccess, ServerPayload as ServerPayloadFromTypes } from '@adcp/sdk/types';

declare const _server: AdcpServer;
void _server;
void createSingleAgentClient;
void extractAdcpErrorFromMcp;
void extractAdcpErrorFromTransport;
void createAdcpServerFromPlatform;

const _legacyServer = createLegacyAdcpServer({
  name: 'packed-adopter',
  version: '1.0.0',
  mediaBuy: {
    getProducts: async () => ({ products: [], cache_scope: 'account' }),
    createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [] }),
    getMediaBuys: async () => ({ media_buys: [] }),
    getMediaBuyDelivery: async () => ({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
  },
});
void _legacyServer;

const _sales: SalesCorePlatform & SalesIngestionPlatform = {
  getProducts: async () => ({ products: [], cache_scope: 'account' }),
  createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [] }),
  updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
  getMediaBuys: async () => ({ media_buys: [] }),
  getMediaBuyDelivery: async () => ({
    reporting_period: { start: '2026-01-01', end: '2026-01-31' },
    media_buy_deliveries: [],
  }),
  syncCreatives: async () => [],
};
void _sales;

interface OpsCtx extends OperationalContext {
  advertiserId: string;
}

const _ops: OperationalPlatform<OpsCtx> = defineOperationalPlatform<OpsCtx>({
  platformId: 'packed-adopter',
  extractContext: async () => ({ accessToken: undefined, advertiserId: 'adv_1' }),
  updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
  getMediaBuyDelivery: async () => ({
    reporting_period: { start: '2026-01-01', end: '2026-01-31' },
    media_buy_deliveries: [],
  }),
  getProducts: async () => ({ products: [], cache_scope: 'account' }),
});
void _ops;

const _checkGovernancePayload: CheckGovernancePayload = {
  check_id: 'check_1',
  verdict: 'approved',
  plan_id: 'plan_1',
  explanation: 'Approved',
  governance_context: 'gc_123',
};
const _propertyListPayload: CreatePropertyListPayload = {
  list: { list_id: 'list_1', name: 'Test list' },
  auth_token: 'token_1',
};
const _contentStandardsPayload: ListContentStandardsPayload = { standards: [] };
const _siPayload: SIGetOfferingPayload = { available: true };
void _checkGovernancePayload;
void _propertyListPayload;
void _contentStandardsPayload;
void _siPayload;

const _serverPayload: ServerPayload<CreateMediaBuySuccess> = {
  media_buy_id: 'mb_1',
  packages: [],
  status: 'active',
};
const _typesPayload: ServerPayloadFromTypes<CreateMediaBuySuccess> = _serverPayload;
void _typesPayload;

// @ts-expect-error ServerPayload must preserve required domain fields.
const _missingRequiredDomainField: ServerPayload<CreateMediaBuySuccess> = { packages: [] };
void _missingRequiredDomainField;
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
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${TSC_HEAP_MB}`].filter(Boolean).join(' '),
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
