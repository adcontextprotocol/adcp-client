const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

test('generated beta.9 account-change docs include the complete success page', () => {
  for (const file of ['docs/TYPE-SUMMARY.md', 'docs/llms.txt']) {
    const contents = readFileSync(file, 'utf8');
    const section = contents.split(/list_account_changes/)[1]?.split(/list_accounts/)[0] ?? '';
    for (const field of ['changes', 'cursor', 'has_more', 'available_since', 'generated_at', 'source_coverage']) {
      assert.match(section, new RegExp(`\\b${field}\\b`), `${file} must document ${field}`);
    }
  }
});

test('generated success-branch docs omit fields forbidden by the selected union arm', () => {
  const docs = readFileSync('docs/TYPE-SUMMARY.md', 'utf8');
  const section = name => docs.split(`**\`${name}\`**`)[1]?.split(/^\*\*\`/m)[0] ?? '';
  assert.doesNotMatch(section('request_proposals'), /^\s+(reason|suggestions|purchase_continuation|task_id):/m);
  assert.doesNotMatch(section('refine_proposals'), /^\s+task_id:/m);
  assert.doesNotMatch(section('decline_proposals'), /^\s+(status|task_id):/m);
});

test('generated request docs resolve JSON Pointer field references', () => {
  const docs = readFileSync('docs/TYPE-SUMMARY.md', 'utf8');
  const section = docs.split('**`get_products`**')[1]?.split(/^\*\*\`/m)[0] ?? '';
  assert.match(section, /fields: \('product_id' \| 'name' \|/);
  assert.doesNotMatch(section, /fields: \(Items \|/);
});
