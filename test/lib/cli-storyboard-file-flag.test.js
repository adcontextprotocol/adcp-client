const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { writeFileSync, unlinkSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpDir;
let scenarioPath;

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-'));
  scenarioPath = path.join(tmpDir, 'scenario.yaml');
  writeFileSync(
    scenarioPath,
    [
      'id: cli-file-flag-test',
      'title: CLI file-flag test',
      'protocol: media-buy',
      'phases:',
      '  - id: phase-1',
      '    title: Ping',
      '    steps:',
      '      - id: step-1',
      '        title: Ping',
      '        task: get_adcp_capabilities',
      '        request: {}',
      '',
    ].join('\n')
  );
});

after(() => {
  try {
    unlinkSync(scenarioPath);
  } catch {
    /* ignore */
  }
});

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('--file <path> (space form) loads the YAML', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--dry-run']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Running storyboard: CLI file-flag test/);
  assert.doesNotMatch(result.stderr, /Cannot combine a storyboard ID with --file/);
});

test('--file=<path> (equals form) loads the YAML', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', `--file=${scenarioPath}`, '--dry-run']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Running storyboard: CLI file-flag test/);
});

test('--file before positional agent loads the YAML', () => {
  const result = runCli(['storyboard', 'run', '--file', scenarioPath, 'test-mcp', '--dry-run']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Running storyboard: CLI file-flag test/);
});

test('--file combined with a storyboard ID is rejected', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', 'some-id', '--file', scenarioPath, '--dry-run']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Cannot combine a storyboard ID with --file/);
});
