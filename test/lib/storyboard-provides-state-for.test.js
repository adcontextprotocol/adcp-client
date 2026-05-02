/**
 * Coverage for the AdCP 3.0.3 `provides_state_for` field (adcp#3734) and its
 * deprecated `peer_substitutes_for` synonym. Both should parse identically;
 * the loader normalizes onto both fields so consumer code reading either name
 * keeps working. Mismatched declarations across both fields are rejected at
 * parse time. Tracked: adcp-client#1267.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');

function minimalStoryboard(stepLines) {
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
    '  - id: account_setup',
    '    title: Account setup',
    '    steps:',
    stepLines,
  ].join('\n');
}

const TWO_STEPS_BASE = [
  '      - id: sync_accounts',
  '        title: Sync',
  '        task: sync_accounts',
  '        sample_request: { account_id: a }',
  '        stateful: true',
  '      - id: list_accounts',
  '        title: List',
  '        task: list_accounts',
  '        stateful: true',
].join('\n');

describe('storyboard loader: provides_state_for / peer_substitutes_for', () => {
  it('parses `provides_state_for` (the AdCP 3.0.3 canonical name)', () => {
    const yamlContent = minimalStoryboard(`${TWO_STEPS_BASE}
        provides_state_for: sync_accounts`);
    const sb = parseStoryboard(yamlContent);
    const list = sb.phases[0].steps.find(s => s.id === 'list_accounts');
    assert.equal(list.provides_state_for, 'sync_accounts');
    // Loader normalizes onto both fields so legacy reader code keeps working.
    assert.equal(list.peer_substitutes_for, 'sync_accounts');
  });

  it('parses `peer_substitutes_for` (the deprecated synonym)', () => {
    const yamlContent = minimalStoryboard(`${TWO_STEPS_BASE}
        peer_substitutes_for: sync_accounts`);
    const sb = parseStoryboard(yamlContent);
    const list = sb.phases[0].steps.find(s => s.id === 'list_accounts');
    assert.equal(list.peer_substitutes_for, 'sync_accounts');
    // Loader normalizes the canonical field too so the runner's read site finds it.
    assert.equal(list.provides_state_for, 'sync_accounts');
  });

  it('accepts both fields when they declare the same target', () => {
    const yamlContent = minimalStoryboard(`${TWO_STEPS_BASE}
        provides_state_for: sync_accounts
        peer_substitutes_for: sync_accounts`);
    const sb = parseStoryboard(yamlContent);
    const list = sb.phases[0].steps.find(s => s.id === 'list_accounts');
    assert.equal(list.provides_state_for, 'sync_accounts');
    assert.equal(list.peer_substitutes_for, 'sync_accounts');
  });

  it('rejects both fields with mismatching values', () => {
    // `sync_accounts` exists; we reuse it as the second target so the only
    // failure mode is the mismatch — not "target step does not exist".
    const TWO_STEPS_PLUS_THIRD = [
      '      - id: sync_accounts',
      '        title: Sync',
      '        task: sync_accounts',
      '        sample_request: { account_id: a }',
      '        stateful: true',
      '      - id: peer_one',
      '        title: Peer one',
      '        task: list_accounts',
      '        stateful: true',
      '      - id: list_accounts',
      '        title: List',
      '        task: list_accounts',
      '        stateful: true',
    ].join('\n');
    const yamlContent = minimalStoryboard(`${TWO_STEPS_PLUS_THIRD}
        provides_state_for: sync_accounts
        peer_substitutes_for: peer_one`);
    assert.throws(() => parseStoryboard(yamlContent), /declared with different values/);
  });

  it('rejects `provides_state_for` on a non-stateful step', () => {
    const yamlContent = minimalStoryboard(`      - id: sync_accounts
        title: Sync
        task: sync_accounts
        sample_request: { account_id: a }
        stateful: true
      - id: list_accounts
        title: List
        task: list_accounts
        provides_state_for: sync_accounts`);
    assert.throws(() => parseStoryboard(yamlContent), /only legal on stateful steps/);
  });

  it('rejects `provides_state_for` referencing a non-stateful target', () => {
    const yamlContent = minimalStoryboard(`      - id: sync_accounts
        title: Sync
        task: sync_accounts
        sample_request: { account_id: a }
      - id: list_accounts
        title: List
        task: list_accounts
        stateful: true
        provides_state_for: sync_accounts`);
    assert.throws(() => parseStoryboard(yamlContent), /must be stateful/);
  });

  it('rejects self-reference', () => {
    const yamlContent = minimalStoryboard(`      - id: sync_accounts
        title: Sync
        task: sync_accounts
        sample_request: { account_id: a }
        stateful: true
      - id: list_accounts
        title: List
        task: list_accounts
        stateful: true
        provides_state_for: list_accounts`);
    assert.throws(() => parseStoryboard(yamlContent), /cannot reference itself/);
  });
});
