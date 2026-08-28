const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Node/Undici runtime compatibility policy', () => {
  it('accepts the published Undici 6 range on the minimum Node line', async () => {
    const { checkRuntimeCompatibility } = await import('../scripts/check-runtime-compat.mjs');
    assert.match(checkRuntimeCompatibility('^20.19.0 || >=22.12.0', '^6.28.0'), /Runtime policy OK/);
  });

  it('rejects Node ranges that admit runtimes without default require(esm)', async () => {
    const { checkRuntimeCompatibility } = await import('../scripts/check-runtime-compat.mjs');
    assert.throws(() => checkRuntimeCompatibility('>=20.19.0', '^6.28.0'), /not contained by the SDK runtime policy/);
    assert.throws(() => checkRuntimeCompatibility('>=22.0.0', '^6.28.0'), /not contained by the SDK runtime policy/);
  });

  it('rejects ranges that can drift into an unreviewed Undici major', async () => {
    const { checkRuntimeCompatibility } = await import('../scripts/check-runtime-compat.mjs');
    assert.throws(
      () => checkRuntimeCompatibility('^20.19.0 || >=22.12.0', '>=6.28.0'),
      /not contained by the reviewed 6\.x policy/
    );
    assert.throws(
      () => checkRuntimeCompatibility('^20.19.0 || >=22.12.0', '^6.28.0 || ^7.29.0'),
      /not contained by the reviewed 6\.x policy/
    );
  });

  it('enforces the reviewed security and Node floors for Undici 7', async () => {
    const { checkRuntimeCompatibility } = await import('../scripts/check-runtime-compat.mjs');
    assert.throws(() => checkRuntimeCompatibility('^20.19.0', '^7.28.0'), /not contained/);
    assert.match(checkRuntimeCompatibility('^20.19.0', '^7.29.0'), /Runtime policy OK/);
  });
});
