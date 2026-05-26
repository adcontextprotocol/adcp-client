const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '../..');

test('reference seller interop keeps strict AdCP 3.0 lane blocking', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/interop-python.yml'), 'utf8');

  assert.match(workflow, /typescript-strict-adcp-3-0-reference-seller:/);
  assert.match(workflow, /STRICT_ADCP_3_0_REF:\s+88bacfdcc0fca4066462d5b621ffc2d7f7a5d348/);
  assert.match(workflow, /run_storyboard_strict_3_0_reference_seller\.sh/);
  assert.match(workflow, /github\.event_name == 'workflow_call'/);
  assert.match(workflow, /Advisory: \\`false\\`/);

  const jobStart = workflow.indexOf('typescript-strict-adcp-3-0-reference-seller:');
  const nextJobMatch = /\n  [a-zA-Z0-9_-]+:/.exec(workflow.slice(jobStart + 1));
  const nextJob = nextJobMatch ? jobStart + 1 + nextJobMatch.index : -1;
  const jobBody = nextJob === -1 ? workflow.slice(jobStart) : workflow.slice(jobStart, nextJob);

  assert.doesNotMatch(jobBody, /advisory:\s+true/);
});
