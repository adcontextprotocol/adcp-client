const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-dmts-declarations.ts');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function createFixture(schemaDeclaration) {
  const root = mkdtempSync(path.join(tmpdir(), 'generate-dmts-'));
  const typesDir = path.join(root, 'dist', 'lib', 'types');
  const featureDir = path.join(root, 'dist', 'lib', 'feature');
  mkdirSync(typesDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  writeFileSync(path.join(typesDir, 'schemas.generated.d.ts'), schemaDeclaration);
  writeFileSync(path.join(typesDir, 'schemas.generated.js'), 'exports.ExampleSchema = {};\n');
  writeFileSync(path.join(typesDir, 'dependency.d.ts'), 'export declare const dependency: string;\n');
  writeFileSync(path.join(typesDir, 'dependency.js'), 'exports.dependency = "ok";\n');
  writeFileSync(
    path.join(featureDir, 'index.d.ts'),
    "export { dependency } from '../types/dependency';\n//# sourceMappingURL=index.d.ts.map\n"
  );

  return root;
}

function runGenerator(cwd) {
  return spawnSync(TSX, [SCRIPT], { cwd, encoding: 'utf8' });
}

test('uses an exact ESM facade for the generated schema declaration', () => {
  const root = createFixture('export declare const ExampleSchema: { readonly exact: true };\n');
  try {
    const result = runGenerator(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(path.join(root, 'dist', 'lib', 'types', 'schemas.generated.d.mts'), 'utf8'),
      "export * from './schemas.generated.js';\n"
    );
    assert.equal(
      readFileSync(path.join(root, 'dist', 'lib', 'feature', 'index.d.mts'), 'utf8'),
      "export { dependency } from '../types/dependency.mjs';\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects schema exports that export-star would omit', () => {
  for (const declaration of [
    'export default function schema() {}\n',
    'declare const schema: unknown;\nexport { schema as default };\n',
    "export { default } from './dependency';\n",
    'declare const schema: unknown;\nexport = schema;\n',
  ]) {
    const root = createFixture(declaration);
    try {
      const result = runGenerator(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /export that the ESM facade would omit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function addTypeOnlyDeclaration(root, relativePath, declaration) {
  const file = path.join(root, 'dist', 'lib', relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, declaration);
  writeFileSync(file.replace(/\.d\.ts$/, '.js'), '"use strict";\n');
}

test('uses ESM facades for the type-only generated protocol and registry declarations', () => {
  const root = createFixture('export declare const ExampleSchema: { readonly exact: true };\n');
  try {
    addTypeOnlyDeclaration(
      root,
      'types/core.generated.d.ts',
      'export interface Product {\n    enum?: string[];\n    /** declare const in prose */\n    module?: string;\n}\n'
    );
    addTypeOnlyDeclaration(
      root,
      'types/tools.generated.d.ts',
      "import type { Product } from './core.generated';\nexport type GetProducts = { products: Product[] };\n"
    );
    addTypeOnlyDeclaration(root, 'registry/types.generated.d.ts', 'export interface paths {\n}\n');
    const result = runGenerator(root);
    assert.equal(result.status, 0, result.stderr);
    for (const [relativePath, name] of [
      ['types/core.generated.d.mts', 'core.generated'],
      ['types/tools.generated.d.mts', 'tools.generated'],
      ['registry/types.generated.d.mts', 'types.generated'],
    ]) {
      assert.equal(
        readFileSync(path.join(root, 'dist', 'lib', relativePath), 'utf8'),
        `export * from './${name}.js';\n`,
        relativePath
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a type-only facade declaration that gains values or package imports', () => {
  for (const declaration of [
    'export declare const ProductSchema: unknown;\n',
    'export declare enum Status {\n    Active = "active"\n}\n',
    "import type { z } from 'zod';\nexport type Product = z.infer<never>;\n",
  ]) {
    const root = createFixture('export declare const ExampleSchema: { readonly exact: true };\n');
    try {
      addTypeOnlyDeclaration(root, 'types/core.generated.d.ts', declaration);
      const result = runGenerator(root);
      assert.notEqual(result.status, 0, declaration);
      assert.match(result.stderr, /core\.generated\.d\.ts is no longer type-only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
