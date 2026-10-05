const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { generate } = require('ts-to-zod');

const root = path.resolve(__dirname, '..');

test('structured media-buy feature fields compile with boolean extension maps', () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.feature-index-'));
  const input = path.join(directory, 'input.ts');
  const output = path.join(directory, 'output.ts');
  const harness = path.join(directory, 'harness.ts');
  const definitions = `
export interface BiddingPolicyCapability { modes: string[]; }
export interface CatalogIngestionCapability { ingestion_modes: string[]; }
export interface MediaBuyFeatures {
  catalog_management?: boolean;
  bidding_policy?: BiddingPolicyCapability;
  catalog_ingestion?: CatalogIngestionCapability;
  [k: string]: boolean | undefined;
}
export interface ExternalCore2CanonicalMediaBuyFeatures {
  catalog_management?: boolean;
  catalog_ingestion?: {
    ingestion_modes: string[];
    nested?: { supported: boolean; };
  };
  [k: string]: boolean | undefined;
}
export interface MediaBuyFeatures1 {
  catalog_ingestion: CatalogIngestionCapability;
  [k: string]: boolean;
}
export interface Unrelated {
  enabled?: boolean;
  [k: string]: boolean | undefined;
}
const referenced: MediaBuyFeatures = {
  catalog_management: true,
  catalog_ingestion: { ingestion_modes: ['inline_items'] },
  bidding_policy: { modes: ['fixed'] },
  future_feature: true,
};
const inline: ExternalCore2CanonicalMediaBuyFeatures = {
  catalog_ingestion: { ingestion_modes: ['feed_url'], nested: { supported: true } },
};
// @ts-expect-error A named capability must retain its structured type.
const invalid: MediaBuyFeatures = { catalog_ingestion: true };
`;
  fs.writeFileSync(input, definitions);
  fs.writeFileSync(
    harness,
    `
import { readFileSync, writeFileSync } from 'node:fs';
import { widenMediaBuyFeaturesIndexSignature } from ${JSON.stringify(path.join(root, 'scripts/generate-types.ts'))};
const source = readFileSync(${JSON.stringify(input)}, 'utf8');
const result = widenMediaBuyFeaturesIndexSignature(source);
if (widenMediaBuyFeaturesIndexSignature(result) !== result) throw new Error('not idempotent');
writeFileSync(${JSON.stringify(output)}, result);
`
  );
  const diagnostics = filename =>
    ts.getPreEmitDiagnostics(
      ts.createProgram([filename], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
      })
    );
  try {
    assert.ok(
      diagnostics(input).some(d => d.code === 2411),
      'fixture reproduces SDK failure'
    );
    const result = spawnSync('npx', ['tsx', harness], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const generated = fs.readFileSync(output, 'utf8');
    assert.doesNotMatch(generated, /MediaBuyFeatures\d*\[/, 'avoid self references consumed by ts-to-zod');
    assert.ok(
      generated.includes('export interface Unrelated {\n  enabled?: boolean;\n  [k: string]: boolean | undefined;\n}')
    );
    assert.deepEqual(
      diagnostics(output).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      []
    );
    const zod = generate({ sourceText: generated });
    assert.deepEqual(zod.errors, []);
    assert.equal(zod.hasCircularDependencies, false);
    const schemas = zod.getZodSchemasFile('./output');
    const schemaPath = path.join(directory, 'schemas.ts');
    fs.writeFileSync(schemaPath, schemas);
    assert.deepEqual(
      diagnostics(schemaPath).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      []
    );
    const runtimePath = path.join(directory, 'schemas.cjs');
    fs.writeFileSync(
      runtimePath,
      ts.transpileModule(schemas, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText
    );
    const runtime = require(runtimePath);
    const value = { catalog_management: true, catalog_ingestion: { ingestion_modes: ['inline_items'] } };
    assert.deepEqual(runtime.mediaBuyFeaturesSchema.parse(value), value);
    assert.deepEqual(runtime.externalCore2CanonicalMediaBuyFeaturesSchema.parse(value), value);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
