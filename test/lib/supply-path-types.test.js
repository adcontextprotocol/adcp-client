const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

test('listProducts and its status handler expose supply-path annotations', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-path-types-'));
  const fixturePath = path.join(fixtureDir, 'typecheck.ts');
  const importPath = path.relative(fixtureDir, path.join(repoRoot, 'dist/lib')).replace(/\\/g, '/');
  const modulePath = importPath.startsWith('.') ? importPath : `./${importPath}`;

  fs.writeFileSync(
    fixturePath,
    `
import type {
  AgentClient,
  ListProductsResponseWithSupplyPath,
  ListProductsStatusChangeHandler,
  SupplyPathState,
} from '${modulePath}';
import { annotateProductsSupplyPaths } from '${modulePath}';

type ListResult = Awaited<ReturnType<AgentClient['listProducts']>>;
declare const result: ListResult;
declare const response: ListProductsResponseWithSupplyPath;

if (result.success && result.status === 'completed') {
  result.data.products?.[0]?.supply_path_verification?.paths;
}
response.products?.[0]?.supply_path_state;

const handler: ListProductsStatusChangeHandler = async completed => {
  completed.products?.[0]?.supply_path_verification?.errors;
};
const replaced = annotateProductsSupplyPaths(
  [{ product_id: 'seller-authored', supply_path_state: 'verified_owner_sold' as const }],
  'https://sales.example'
);
replaced.then(products => {
  const state: SupplyPathState | undefined = products[0]?.supply_path_state;
  void state;
});
annotateProductsSupplyPaths([], 'https://sales.example', {
  source: 'authoritative',
  // @ts-expect-error Annotation property scope is always derived from each product.
  propertySelectors: [],
});
void handler;
`
  );

  try {
    const compiled = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--skipLibCheck',
        fixturePath,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }
    );
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
