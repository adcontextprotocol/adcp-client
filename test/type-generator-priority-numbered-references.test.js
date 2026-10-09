const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function runGeneratorAssertions(body) {
  const generator = path.join(root, 'scripts/generate-types.ts');
  const source = `
    import assert from 'node:assert/strict';
    import { collapseSuppressedNumberedReferences } from ${JSON.stringify(generator)};
    ${body}
  `;
  return spawnSync(path.join(root, 'node_modules/.bin/tsx'), ['--eval', source], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('priority extracted types point repeated-$ref numbered references at their base', () => {
  const result = runGeneratorAssertions(`
    const compiled = \`
export type RequestProposalsResponse =
  | {
      later_proposals?: LaterProposalsState;
    }
  | {
      later_proposals?: LaterProposalsState1;
    };
export interface LaterProposalsState {
  accepted: boolean;
}
export interface LaterProposalsState1 {
  accepted: boolean;
}
\`;
    const extracted = \`export type RequestProposalsResponse =
  | {
      later_proposals?: LaterProposalsState;
    }
  | {
      later_proposals?: LaterProposalsState1;
    };
\`;

    const collapsed = collapseSuppressedNumberedReferences(extracted, compiled, 'RequestProposalsResponse');
    assert.doesNotMatch(collapsed, /LaterProposalsState1/);
    assert.equal(collapsed.match(/later_proposals\\?: LaterProposalsState;/g).length, 2);
  `);

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test('priority extracted types keep numbered references whose bodies differ', () => {
  const result = runGeneratorAssertions(`
    const compiled = \`
export type Root = {
  a?: Variant;
  b?: Variant1;
};
export type Variant = 'x';
export type Variant1 = 'y';
\`;
    const extracted = \`export type Root = {
  a?: Variant;
  b?: Variant1;
};
\`;

    const collapsed = collapseSuppressedNumberedReferences(extracted, compiled, 'Root');
    assert.equal(collapsed, extracted);
  `);

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr + result.stdout, /Root references Variant1, which differs from Variant/);
});
