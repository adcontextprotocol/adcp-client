const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { writeFileSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
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

function writeComplianceIndex(complianceDir, version) {
  mkdirSync(complianceDir, { recursive: true });
  writeFileSync(
    path.join(complianceDir, 'index.json'),
    JSON.stringify({ adcp_version: version, universal: [], protocols: [], specialisms: [] })
  );
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

test('--compliance-version fails before dry-run when matching schemas are unavailable', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-compliance-missing-schema-'));
  const complianceDir = path.join(tempRoot, 'compliance-cache', '9.9.0-beta.1');
  const oldComplianceDir = process.env.ADCP_COMPLIANCE_DIR;
  const oldSchemaRoot = process.env.ADCP_SCHEMA_ROOT;
  try {
    process.env.ADCP_COMPLIANCE_DIR = complianceDir;
    delete process.env.ADCP_SCHEMA_ROOT;
    writeComplianceIndex(complianceDir, '9.9.0-beta.1');

    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--dry-run',
      '--compliance-version',
      '9.9.0-beta.1',
    ]);

    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--compliance-version 9\.9\.0-beta\.1 selected AdCP compliance version/);
    assert.match(result.stderr, /installed default schemas/);
    assert.match(result.stderr, /--schema-root/);
  } finally {
    if (oldComplianceDir === undefined) delete process.env.ADCP_COMPLIANCE_DIR;
    else process.env.ADCP_COMPLIANCE_DIR = oldComplianceDir;
    if (oldSchemaRoot === undefined) delete process.env.ADCP_SCHEMA_ROOT;
    else process.env.ADCP_SCHEMA_ROOT = oldSchemaRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
