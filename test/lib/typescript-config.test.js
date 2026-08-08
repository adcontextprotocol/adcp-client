const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '../..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

test('TypeScript avoids install-location mappings and pins the local declaration dependency', () => {
  const tsconfig = readJson('tsconfig.json');
  const examplesConfig = readJson('tsconfig.examples.json');
  const packageJson = readJson('package.json');

  assert.equal(tsconfig.compilerOptions.module, 'commonjs');
  assert.equal(tsconfig.compilerOptions.moduleResolution, 'node');
  assert.equal(tsconfig.compilerOptions.paths?.['structured-headers'], undefined);
  assert.equal(examplesConfig.compilerOptions.paths?.['structured-headers'], undefined);
  assert.equal(packageJson.dependencies['structured-headers'], '2.0.2');
});

test('a nested CommonJS source package compiles with structured-headers hoisted to an ancestor', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'adcp-hoisted-types-'));
  const nestedPackage = path.join(fixtureRoot, 'vendor', 'sdk');
  const hoistedDependency = path.join(fixtureRoot, 'node_modules', 'structured-headers');
  const installedDependency = path.dirname(path.dirname(require.resolve('structured-headers')));

  try {
    mkdirSync(path.join(nestedPackage, 'src'), { recursive: true });
    mkdirSync(path.dirname(hoistedDependency), { recursive: true });
    cpSync(installedDependency, hoistedDependency, { recursive: true });

    writeFileSync(path.join(nestedPackage, 'package.json'), '{"name":"nested-sdk","type":"commonjs"}\n');
    writeFileSync(
      path.join(nestedPackage, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          moduleResolution: 'node',
          strict: true,
          declaration: true,
          outDir: 'dist',
        },
        include: ['src/**/*'],
      })
    );
    writeFileSync(
      path.join(nestedPackage, 'src', 'structured-headers.d.ts'),
      readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'vendor-types', 'structured-headers.d.ts'), 'utf8')
    );
    writeFileSync(
      path.join(nestedPackage, 'src', 'index.ts'),
      [
        "import { ParseError, parseDictionary, serializeInnerList, type InnerList } from 'structured-headers';",
        '',
        'export function roundTrip(value: string): string {',
        '  const entry = parseDictionary(value).values().next().value;',
        "  if (!entry || !Array.isArray(entry[0])) throw new ParseError(0, 'expected inner list');",
        '  return serializeInnerList(entry as InnerList);',
        '}',
        '',
      ].join('\n')
    );

    assert.equal(existsSync(path.join(nestedPackage, 'node_modules')), false);
    const result = spawnSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['--project', nestedPackage], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const javascript = readFileSync(path.join(nestedPackage, 'dist', 'index.js'), 'utf8');
    const declaration = readFileSync(path.join(nestedPackage, 'dist', 'index.d.ts'), 'utf8');
    assert.match(javascript, /require\(["']structured-headers["']\)/);
    assert.doesNotMatch(declaration, /structured-headers/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
