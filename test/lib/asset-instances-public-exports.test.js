const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const schemaRoot = path.resolve(__dirname, '../../schemas/cache/latest');
const registryPath = path.join(schemaRoot, 'creative/asset-types/index.json');
const unionPath = path.join(schemaRoot, 'core/assets/asset-union.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeAssetSchemaRef(ref) {
  return ref.replace(/^\/schemas\/(?:[^/]+\/)?core\/assets\//, '/schemas/core/assets/');
}

test('generated asset union stays aligned with the creative asset-type registry', () => {
  const registry = readJson(registryPath);
  const union = readJson(unionPath);
  const registryRefs = [];

  for (const [assetType, entry] of Object.entries(registry.asset_types)) {
    const normalizedRef = normalizeAssetSchemaRef(entry.schema);
    registryRefs.push(normalizedRef);

    const assetSchema = readJson(path.join(schemaRoot, 'core/assets', path.basename(normalizedRef)));
    assert.strictEqual(
      assetSchema.properties?.asset_type?.const,
      assetType,
      `${entry.schema} must declare asset_type=${assetType}`
    );
  }

  const unionRefs = union.oneOf.map(branch => normalizeAssetSchemaRef(branch.$ref));
  assert.deepStrictEqual(
    [...unionRefs].sort(),
    [...registryRefs].sort(),
    'asset-union.json must contain exactly the schemas declared by the creative asset-type registry'
  );
});

test('asset instance types resolve from ESM and CJS public entrypoints', () => {
  const contextDir = path.resolve(__dirname, '../../.context');
  fs.mkdirSync(contextDir, { recursive: true });

  const registry = readJson(registryPath);
  const assetTypeNames = Object.values(registry.asset_types).map(entry => {
    const assetSchema = readJson(path.join(schemaRoot, 'core/assets', path.basename(entry.schema)));
    return assetSchema.title.replace(/\s+/g, '');
  });
  const rootTypeImports = assetTypeNames.map(name => `${name} as Root${name}`).join(',\n  ');
  const rootTypeUnion = assetTypeNames.map(name => `Root${name}`).join('\n  | ');
  const typesTypeImports = assetTypeNames.join(',\n  ');
  const typesTypeUnion = assetTypeNames.join('\n  | ');

  const source = `
import type {
  AssetInstance as RootAssetInstance,
  ${rootTypeImports},
} from '@adcp/sdk';
import type {
  AssetInstance,
  ${typesTypeImports},
} from '@adcp/sdk/types';

const post: PublishedPostAsset = {
  asset_type: 'published_post',
  platform: 'meta',
  platform_post_id: 'page_post',
};
const asset: AssetInstance = post;
const rootPost: RootPublishedPostAsset = post;
const rootAsset: RootAssetInstance = rootPost;

function narrow(candidate: AssetInstance): string | undefined {
  if (candidate.asset_type === 'published_post') return candidate.platform_post_id;
  return undefined;
}

type RootPublicVariants =
  | ${rootTypeUnion};
type TypesPublicVariants =
  | ${typesTypeUnion};
declare const rootAssetCandidate: RootAssetInstance;
declare const typesAssetCandidate: AssetInstance;
declare const rootVariant: RootPublicVariants;
declare const typesVariant: TypesPublicVariants;
const rootUnionCoversAsset: RootPublicVariants = rootAssetCandidate;
const rootAssetCoversUnion: RootAssetInstance = rootVariant;
const typesUnionCoversAsset: TypesPublicVariants = typesAssetCandidate;
const typesAssetCoversUnion: AssetInstance = typesVariant;

void asset;
void rootAsset;
void narrow;
void rootUnionCoversAsset;
void rootAssetCoversUnion;
void typesUnionCoversAsset;
void typesAssetCoversUnion;
`;

  const cjsPath = path.join(contextDir, 'asset-instance-entrypoints.cts');
  const esmPath = path.join(contextDir, 'asset-instance-entrypoints.mts');
  const tsconfigPath = path.join(contextDir, 'asset-instance-entrypoints-tsconfig.json');
  fs.writeFileSync(cjsPath, source, 'utf8');
  fs.writeFileSync(esmPath, source, 'utf8');
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
        },
        files: ['asset-instance-entrypoints.cts', 'asset-instance-entrypoints.mts'],
      },
      null,
      2
    ),
    'utf8'
  );

  const result = spawnSync('npx', ['tsc', '-p', tsconfigPath], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });

  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
