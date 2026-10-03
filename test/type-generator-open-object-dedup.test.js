const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('numbered types are deduplicated after residual open-object markers are removed', () => {
  const generator = path.join(root, 'scripts/generate-types.ts');
  const source = `
    import assert from 'node:assert/strict';
    import {
      removeNumberedTypeDuplicates,
      stabilizeEmptyNumberedInterfacesAfterOpenObjectCleanup,
    } from ${JSON.stringify(generator)};

    const generated = \`
export interface ContextObject {
}

/** Media-buy-specific correlation data. */
export interface ContextObject2 {
  [k: string]: unknown | undefined;
}

export interface CreateMediaBuyResponse {
  context?: ContextObject2;
}
\`;

    const beforeCleanup = removeNumberedTypeDuplicates(generated);
    assert.match(beforeCleanup, /export interface ContextObject2/);

    const stabilized = stabilizeEmptyNumberedInterfacesAfterOpenObjectCleanup(beforeCleanup);
    assert.doesNotMatch(stabilized, /ContextObject2/);
    assert.doesNotMatch(stabilized, /Media-buy-specific/);
    assert.match(stabilized, /context\\?: ContextObject;/);
  `;
  const result = spawnSync(path.join(root, 'node_modules/.bin/tsx'), ['--eval', source], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});
