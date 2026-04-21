/**
 * CLI plumbing for `--invariants` — lets operators dynamic-import assertion
 * modules before `runStoryboard` resolves `storyboard.invariants: [...]`.
 *
 * The runtime already supports the registry (adcp#2639); without a CLI
 * surface, storyboards that declare invariants would fail at runner start
 * with "Storyboard references unregistered assertion" because no module
 * ever called `registerAssertion(...)`.
 *
 * Tests cover flag parsing, module-load success + failure, and the
 * positional-filter interaction — not the registry itself, which is
 * covered in `test/lib/storyboard-assertion-registry.test.js`.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { writeFileSync, mkdtempSync, rmSync, statSync, existsSync, unlinkSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
const SDK_INDEX = path.resolve(__dirname, '../../dist/lib/testing/storyboard/index.js');

let tmpDir;
let scenarioPath;
let goodModulePath;
let secondModulePath;
let brokenModulePath;
let goodMarker;
let secondMarker;

function writeInvariantsModule(filePath, { marker, assertionId }) {
  writeFileSync(
    filePath,
    [
      `import { registerAssertion } from '${SDK_INDEX}';`,
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
      'registerAssertion({',
      `  id: ${JSON.stringify(assertionId)},`,
      `  description: ${JSON.stringify(`${assertionId} — test invariant`)},`,
      '});',
      '',
    ].join('\n')
  );
}

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-invariants-'));

  scenarioPath = path.join(tmpDir, 'scenario.yaml');
  writeFileSync(
    scenarioPath,
    [
      'id: cli-invariants-test',
      'title: CLI invariants test',
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

  // Each module writes a marker file at import time so the test can verify
  // the CLI actually loaded it — registry state doesn't survive the
  // child-process boundary, but filesystem side effects do.
  goodMarker = path.join(tmpDir, 'good-marker');
  secondMarker = path.join(tmpDir, 'second-marker');
  goodModulePath = path.join(tmpDir, 'good-invariants.mjs');
  secondModulePath = path.join(tmpDir, 'second-invariants.mjs');

  writeInvariantsModule(goodModulePath, { marker: goodMarker, assertionId: 'demo.first' });
  writeInvariantsModule(secondModulePath, { marker: secondMarker, assertionId: 'demo.second' });

  brokenModulePath = path.join(tmpDir, 'broken-invariants.mjs');
  writeFileSync(brokenModulePath, "throw new Error('intentional broken module');\n");
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runCli(args, env = {}, { timeout = 10_000 } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
    killSignal: 'SIGKILL',
  });
}

describe('storyboard run --invariants', () => {
  test('loads a single local module before dry-run preview', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--invariants',
      goodModulePath,
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.doesNotThrow(() => statSync(goodMarker));
  });

  test('loads multiple comma-separated modules', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--invariants',
      `${goodModulePath},${secondModulePath}`,
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotThrow(() => statSync(goodMarker));
    assert.doesNotThrow(() => statSync(secondMarker));
  });

  test('rejects --invariants without a value', () => {
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--invariants', '--dry-run']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--invariants requires a value/);
  });

  test('fails fast when a module throws at import time', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--invariants',
      brokenModulePath,
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /failed to load invariants module/);
    assert.match(result.stderr, /intentional broken module/);
  });

  test('fails fast when a module path does not resolve', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.mjs');
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--invariants',
      missingPath,
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /failed to load invariants module/);
  });

  test('module-specifier value is not confused with a positional agent arg', () => {
    // If the filter missed `--invariants <value>`, `goodModulePath` would be
    // treated as the agent arg and resolveAgent would fail on an unknown alias.
    // Success here means the filter excluded the value correctly.
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--invariants',
      goodModulePath,
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  });

  test('rejects whitespace-only / empty-after-split value', () => {
    // Silently no-oping on `--invariants " , , "` would hide a typo; a user
    // who asked for invariants expects something to load. Make it an error.
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--invariants',
      ' , , ',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /at least one non-empty module specifier/);
  });

  test('also loads invariants in multi-instance mode', () => {
    // Regression guard for the second call site in handleMultiInstanceStoryboardRun.
    // Delete the marker first so its existence after the run proves the
    // multi-instance path re-imported (markers from earlier tests would
    // otherwise make this assertion always pass).
    if (existsSync(goodMarker)) unlinkSync(goodMarker);
    const result = runCli([
      'storyboard',
      'run',
      '--file',
      scenarioPath,
      '--url',
      'https://a.example.com/mcp/',
      '--url',
      'https://b.example.com/mcp/',
      '--invariants',
      goodModulePath,
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotThrow(() => statSync(goodMarker));
  });
});
