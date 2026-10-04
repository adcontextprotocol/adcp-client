const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAdcpVersionAtLeast, sellerAdvertises31, shouldOmit31Fields, redactSecrets } = require('../../dist/lib');
test('public compatibility helpers use the same decisions as the client', async () => {
  const esm = await import('../../dist/lib/index.mjs');
  for (const name of ['isAdcpVersionAtLeast', 'sellerAdvertises31', 'shouldOmit31Fields', 'redactSecrets'])
    assert.equal(typeof esm[name], 'function');
  assert.equal(isAdcpVersionAtLeast('3.1.0', '3.1'), true);
  assert.equal(isAdcpVersionAtLeast('3.0.0', '3.1'), false);
  assert.equal(sellerAdvertises31({ supportedVersions: ['3.1.0'] }), true);
  assert.equal(sellerAdvertises31({ buildVersion: '3.1.0' }), false);
  assert.equal(shouldOmit31Fields('3.0', { supportedVersions: ['3.1.0'] }), true);
  assert.equal(shouldOmit31Fields('3.1', { supportedVersions: ['3.1.0'] }), false);
  const input = { nested: [{ authorization: 'Bearer value', name: 'Kept' }] };
  assert.deepEqual(redactSecrets(input), { nested: [{ authorization: '[redacted]', name: 'Kept' }] });
  assert.equal(input.nested[0].authorization, 'Bearer value');
});
