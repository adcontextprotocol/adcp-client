const assert = require('node:assert/strict');
const test = require('node:test');

const { assertNoExampleTlds } = require('../../dist/lib/server/index.js');

test('assertNoExampleTlds throws for example domains outside allowed envs', () => {
  assert.throws(
    () =>
      assertNoExampleTlds(
        { KNOWN_PUBLISHERS: ['acmeoutdoor.example', 'seller.example'] },
        {
          allowIn: ['test', 'development'],
          checklistPath: 'examples/hello_seller_adapter_guaranteed.ts',
          env: 'production',
        }
      ),
    /Adapter forked without flipping KNOWN_PUBLISHERS; see FORK CHECKLIST in examples\/hello_seller_adapter_guaranteed\.ts/
  );
});

test('assertNoExampleTlds passes when constants have been flipped', () => {
  assert.doesNotThrow(() =>
    assertNoExampleTlds(
      { KNOWN_PUBLISHERS: ['seller.example.com', 'publisher.test'], API_URL: 'https://seller.test/api' },
      { allowIn: ['test', 'development'], env: 'production' }
    )
  );
});

test('assertNoExampleTlds is disabled in explicitly allowed envs', () => {
  assert.doesNotThrow(() =>
    assertNoExampleTlds(
      { KNOWN_PUBLISHERS: ['acmeoutdoor.example'] },
      { allowIn: ['test', 'development'], env: 'development' }
    )
  );
});
