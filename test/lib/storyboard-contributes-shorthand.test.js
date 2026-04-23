const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');

function yaml(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += String(values[i]);
  });
  return out;
}

function minimalStoryboard(phases) {
  return [
    'id: test_storyboard',
    'version: "1.0"',
    'title: Test',
    'category: test',
    'summary: s',
    'narrative: n',
    'agent:',
    '  interaction_model: async',
    '  capabilities: []',
    'caller:',
    '  role: buyer',
    'phases:',
    phases,
  ].join('\n');
}

describe('storyboard loader: branch_set + contributes shorthand', () => {
  it("resolves `contributes: true` to the enclosing phase's branch_set.id", () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: past_start_reject_path
    title: Reject path
    optional: true
    branch_set:
      id: past_start_handled
      semantics: any_of
    steps:
      - id: create_buy_past_start_reject
        title: Reject
        task: get_media_buys
        contributes: true`
    );
    const parsed = parseStoryboard(yamlContent);
    const step = parsed.phases[0].steps[0];
    assert.strictEqual(step.contributes_to, 'past_start_handled');
    assert.strictEqual(step.contributes, undefined);
  });

  it('treats `contributes: false` as non-contributing and clears the field', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      id: f
      semantics: any_of
    steps:
      - id: s
        title: S
        task: get_media_buys
        contributes: false`
    );
    const parsed = parseStoryboard(yamlContent);
    const step = parsed.phases[0].steps[0];
    assert.strictEqual(step.contributes_to, undefined);
    assert.strictEqual(step.contributes, undefined);
  });

  it('preserves the string form `contributes_to:` unchanged', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      id: f
      semantics: any_of
    steps:
      - id: s
        title: S
        task: get_media_buys
        contributes_to: f`
    );
    const parsed = parseStoryboard(yamlContent);
    assert.strictEqual(parsed.phases[0].steps[0].contributes_to, 'f');
  });

  it('rejects a step that declares both `contributes` and `contributes_to`', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      id: f
      semantics: any_of
    steps:
      - id: s
        title: S
        task: get_media_buys
        contributes: true
        contributes_to: f`
    );
    assert.throws(() => parseStoryboard(yamlContent), /both 'contributes' and 'contributes_to'/);
  });

  it('rejects `contributes: true` outside a branch_set phase', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    steps:
      - id: s
        title: S
        task: get_media_buys
        contributes: true`
    );
    assert.throws(() => parseStoryboard(yamlContent), /only legal inside a phase that declares branch_set/);
  });

  it('rejects `contributes_to:` inside a branch_set phase that disagrees with branch_set.id', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      id: f
      semantics: any_of
    steps:
      - id: s
        title: S
        task: get_media_buys
        contributes_to: other_flag`
    );
    assert.throws(() => parseStoryboard(yamlContent), /must equal enclosing phase's branch_set\.id/);
  });

  it('rejects a branch_set phase that is not optional', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    branch_set:
      id: f
      semantics: any_of
    steps: []`
    );
    assert.throws(() => parseStoryboard(yamlContent), /must set 'optional: true'/);
  });

  it('rejects unknown branch_set.semantics values (adcp#2646 lint rule 2)', () => {
    const yamlContent = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      id: f
      semantics: all_of
    steps: []`
    );
    assert.throws(() => parseStoryboard(yamlContent), /semantics='all_of' is not supported/);
  });

  it('rejects a branch_set missing id or semantics', () => {
    const missingId = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      semantics: any_of
    steps: []`
    );
    assert.throws(() => parseStoryboard(missingId), /branch_set\.id/);

    const missingSemantics = minimalStoryboard(
      yaml`  - id: p
    title: P
    optional: true
    branch_set:
      id: f
    steps: []`
    );
    assert.throws(() => parseStoryboard(missingSemantics), /branch_set\.semantics/);
  });
});
