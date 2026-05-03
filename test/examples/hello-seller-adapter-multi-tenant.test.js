/**
 * CI gate for `examples/hello_seller_adapter_multi_tenant.ts`.
 *
 * Single gate: strict typecheck. The shared three-gate helper
 * (`runHelloAdapterGates`) requires `bootMockServer({ specialism })` plus
 * an upstream traffic façade — neither applies to the multi-tenant adapter:
 *
 *   - It hosts three specialisms (governance-spend-authority, property-lists,
 *     brand-rights) and there are no governance/property-lists/brand-rights
 *     mock-servers today (`bootMockServer` covers sales-* / creative-* /
 *     signal-marketplace / sponsored-intelligence only).
 *   - The adapter has no upstream — all tenant state is in-memory, seeded
 *     directly. The façade gate would assert against routes that don't exist.
 *
 * Storyboard validation for the multi-tenant adapter lands when a
 * governance / brand-rights mock-server ships. Until then, this test ensures
 * the adapter compiles under the same strict tsc flags as the other hello
 * adapters.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_multi_tenant.ts');

describe('examples/hello_seller_adapter_multi_tenant', () => {
  it('passes tsc with --strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noPropertyAccessFromIndexSignature', () => {
    const res = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        EXAMPLE_FILE,
        '--target',
        'ES2022',
        '--module',
        'commonjs',
        '--moduleResolution',
        'node',
        '--esModuleInterop',
        '--skipLibCheck',
        '--strict',
        '--noUncheckedIndexedAccess',
        '--exactOptionalPropertyTypes',
        '--noImplicitOverride',
        '--noFallthroughCasesInSwitch',
        '--noPropertyAccessFromIndexSignature',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }
    );
    assert.equal(res.status, 0, `tsc reported errors:\n${(res.stdout || '') + (res.stderr || '')}`);
  });
});
