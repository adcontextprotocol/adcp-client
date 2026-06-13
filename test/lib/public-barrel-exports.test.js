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
  createLazyBackend,
  ensureGetProductsCacheScope,
  resolveTaskState,
  type CanonicalFormatParams,
  type EffectiveTaskState,
  type GetProductsResponse,
  type Placement,
  type ProductFormatDeclaration,
  type ResolvedTaskState,
  type SyncCreativesPayload,
} from '@adcp/sdk';
import type {
  LazyBackendFactory,
  LazyBackendOptions,
  ListCreativeFormatsPayload,
  SyncCreativesPayload as ServerSyncCreativesPayload,
} from '@adcp/sdk/server';
import {
  createCanonicalReferenceResolver,
  type CanonicalRef,
  type CanonicalReferenceResolutionResult,
} from '@adcp/sdk/v2/format-schema';
import { CreateMediaBuyRequestSchema } from '@adcp/sdk/schemas';
import {
  AuthInvalidError,
  AuthMissingError,
  AuthRequiredError,
  createLazyBackend as createServerLazyBackend,
} from '@adcp/sdk/server';
import type {
  ProductFormatDeclaration as TypesProductFormatDeclaration,
  Placement as TypesPlacement,
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
const mediaBuyShape = CreateMediaBuyRequestSchema.shape;

const syncError: SyncCreativesPayload = {
  errors: [{ code: 'INVALID_REQUEST', message: 'invalid creative batch' }],
};
const serverSyncError: ServerSyncCreativesPayload = syncError;

const acceptsListPayload = (_payload: ListCreativeFormatsPayload) => {};
acceptsListPayload({ formats: [] });

const authErrors = [new AuthMissingError(), new AuthInvalidError(), new AuthRequiredError()];

const lazyBackendFactory: LazyBackendFactory = async () => ({
  async get() { return null; },
  async putIfAbsent() { return true; },
  async put() {},
  async delete() {},
});
const lazyBackendOptions: LazyBackendOptions = { clearAll: false };
const lazyBackend = createLazyBackend(lazyBackendFactory);
const serverLazyBackend = createServerLazyBackend(lazyBackendFactory, lazyBackendOptions);

const canonicalResolver = createCanonicalReferenceResolver();
const canonicalRef: CanonicalRef = {
  uri: 'https://creative.adcontextprotocol.org/schemas/example.json',
  digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
};
const acceptsCanonicalResult = (_result: CanonicalReferenceResolutionResult) => {};
void canonicalResolver;
void canonicalRef;
void acceptsCanonicalResult;

const scoped = ensureGetProductsCacheScope({ products: [], cache_scope: 'legacy' as string });
const scope: 'public' | 'account' = scoped.cache_scope;
const taskState = resolveTaskState({
  success: true,
  status: 'completed',
  data: { status: 'submitted', task_id: 'task_1' },
  metadata: {
    taskId: 'client-task-1',
    taskName: 'create_media_buy',
    agent: { id: 'agent-1', name: 'Agent', protocol: 'mcp' },
    responseTimeMs: 1,
    timestamp: '2026-06-13T00:00:00Z',
    clarificationRounds: 0,
    status: 'completed',
  },
}, { toolName: 'create_media_buy' });
const effectiveState: EffectiveTaskState = taskState.effectiveState;
const resolvedTaskState: ResolvedTaskState<{ status: string; task_id: string }> = taskState;

const required: RequireCacheScopeWhenProducts<{ products: unknown[]; cache_scope?: 'public' | 'account' }> = scoped;

const normalizeGeneratedResponse = (response: GetProductsResponse) => ensureGetProductsCacheScope(response);
void normalizeGeneratedResponse;

const generatedResponse = { status: 'completed', products: [], cache_scope: 'public' } satisfies GetProductsResponse;
const generatedScoped = ensureGetProductsCacheScope(generatedResponse);
const generatedScope: 'public' | 'account' = generatedScoped.cache_scope;

const generatedMissingScope = ensureGetProductsCacheScope({
  status: 'completed',
  products: [],
} satisfies Omit<GetProductsResponse, 'cache_scope'>);
const generatedInjectedScope: 'public' | 'account' = generatedMissingScope.cache_scope;

const acceptsRootPlacement = (_placement: Placement) => {};
const acceptsTypesPlacement = (_placement: TypesPlacement) => {};

void typedNative;
void builtKind;
void mediaBuyShape;
void serverSyncError;
void authErrors;
void lazyBackend;
void lazyBackendOptions;
void serverLazyBackend;
void scope;
void effectiveState;
void resolvedTaskState;
void required;
void generatedScope;
void generatedInjectedScope;
void acceptsRootPlacement;
void acceptsTypesPlacement;
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
            '@adcp/sdk/v2/format-schema': ['dist/lib/v2/format-schema/index'],
            '@adcp/sdk/schemas': ['dist/lib/schemas/index'],
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

test('schema exports stay behind @adcp/sdk/schemas', () => {
  const root = require('../../dist/lib/index.js');
  const types = require('../../dist/lib/types/index.js');
  const schemas = require('../../dist/lib/schemas/index.js');

  assert.strictEqual(root.CreateMediaBuyRequestSchema, undefined);
  assert.strictEqual(root.TOOL_REQUEST_SCHEMAS, undefined);
  assert.strictEqual(root.TOOL_RESPONSE_SCHEMAS, undefined);
  assert.strictEqual(root.SyncCreativesItemSchema, undefined);
  assert.strictEqual(types.CreateMediaBuyRequestSchema, undefined);
  assert.ok(schemas.CreateMediaBuyRequestSchema);
  assert.ok(schemas.TOOL_REQUEST_SCHEMAS.create_media_buy);
  assert.ok(schemas.TOOL_RESPONSE_SCHEMAS.create_media_buy);
  assert.ok(schemas.SyncCreativesItemSchema);
});
