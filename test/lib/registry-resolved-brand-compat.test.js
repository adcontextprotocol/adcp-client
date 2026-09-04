const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_NAME = 'registry-resolved-brand-compat.mts';

test('public ResolvedBrand retains the deprecated provenance compatibility property', () => {
  let fixtureDir;

  try {
    const contextDir = path.join(REPO_ROOT, '.context');
    fs.mkdirSync(contextDir, { recursive: true });
    fixtureDir = fs.mkdtempSync(path.join(contextDir, 'registry-resolved-brand-compat-'));
    const fixturePath = path.join(fixtureDir, FIXTURE_NAME);
    const tsconfigPath = path.join(fixtureDir, 'tsconfig.json');
    fs.writeFileSync(
      fixturePath,
      `
import type { ResolvedBrand } from '@adcp/sdk';

declare const resolved: ResolvedBrand;

const legacyProvenance: 'canonical' | 'community' | 'enriched' | undefined = resolved.provenance;
const compatibleBrand: ResolvedBrand = { ...resolved, provenance: 'canonical' };

void legacyProvenance;
void compatibleBrand;
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
            baseUrl: '../..',
            paths: { '@adcp/sdk': ['dist/lib/index'] },
          },
          files: [FIXTURE_NAME],
        },
        null,
        2
      ),
      'utf8'
    );

    const result = spawnSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['-p', tsconfigPath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    if (fixtureDir) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});
