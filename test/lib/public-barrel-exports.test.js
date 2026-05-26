const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('public barrels expose canonical format and payload helper types', () => {
  const contextDir = path.resolve(__dirname, '../../.context');
  fs.mkdirSync(contextDir, { recursive: true });

  const sourcePath = path.join(contextDir, 'public-barrel-smoke.ts');
  const tsconfigPath = path.join(contextDir, 'public-barrel-tsconfig.json');

  fs.writeFileSync(
    sourcePath,
    `
import {
  CanonicalFormat,
  ensureGetProductsCacheScope,
  type CanonicalFormatParams,
  type ProductFormatDeclaration,
  type SyncCreativesPayload,
} from '@adcp/sdk';
import type {
  ListCreativeFormatsPayload,
  SyncCreativesPayload as ServerSyncCreativesPayload,
} from '@adcp/sdk/server';
import type {
  ProductFormatDeclaration as TypesProductFormatDeclaration,
  RequireCacheScopeWhenProducts,
} from '@adcp/sdk/types';

const native: ProductFormatDeclaration = {
  format_kind: 'native_in_feed',
  params: {},
  seller_preference: 'preferred',
};
const typedNative: TypesProductFormatDeclaration = native;

const built = CanonicalFormat.nativeInFeed(
  {} as CanonicalFormatParams<'native_in_feed'>,
  { seller_preference: 'preferred', capability_id: 'native_feed' }
);
const builtKind: 'native_in_feed' = built.format_kind;

const syncError: SyncCreativesPayload = {
  errors: [{ code: 'INVALID_REQUEST', message: 'invalid creative batch' }],
};
const serverSyncError: ServerSyncCreativesPayload = syncError;

const acceptsListPayload = (_payload: ListCreativeFormatsPayload) => {};
acceptsListPayload({ formats: [] });

const scoped = ensureGetProductsCacheScope({ products: [], cache_scope: 'legacy' as string });
const scope: 'public' | 'account' = scoped.cache_scope;

const required: RequireCacheScopeWhenProducts<{ products: unknown[]; cache_scope?: 'public' | 'account' }> = scoped;

void typedNative;
void builtKind;
void serverSyncError;
void scope;
void required;
`,
    'utf8'
  );

  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          baseUrl: '..',
          paths: {
            '@adcp/sdk': ['dist/lib/index'],
            '@adcp/sdk/server': ['dist/lib/server/index'],
            '@adcp/sdk/types': ['dist/lib/types/index'],
          },
        },
        files: ['public-barrel-smoke.ts'],
      },
      null,
      2
    ),
    'utf8'
  );

  const result = spawnSync('npx', ['tsc', '-p', tsconfigPath], {
    cwd: contextDir,
    encoding: 'utf8',
  });

  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
