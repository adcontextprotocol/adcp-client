/**
 * CLI plumbing for `--local-agent` + `--format junit`.
 *
 * Covers the full seller path: import a user module, spin up the agent,
 * run storyboards, emit JUnit XML. If the wiring regresses, CI
 * pipelines fronting `adcp storyboard run --local-agent ... --format junit`
 * will either crash or emit non-conformant XML.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpDir;
let agentModulePath;

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-local-agent-cli-'));
  agentModulePath = path.join(tmpDir, 'agent.cjs');

  // Minimal agent module — same pattern docs will show users. The CLI
  // imports this at runtime; the module must resolve `createAdcpServer`
  // from the built dist so a test run doesn't require users to install a
  // compile step.
  const distPath = path.resolve(__dirname, '../../dist/lib/server/index.js');
  writeFileSync(
    agentModulePath,
    `const { createAdcpServer } = require(${JSON.stringify(distPath)});

module.exports = {
  createAgent: () =>
    createAdcpServer({
      name: 'CLI Test Agent',
      version: '0.0.1',
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
    }),
};
`
  );
});

after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('--local-agent imports the module and passes capability_discovery', () => {
  const res = spawnSync('node', [CLI, 'storyboard', 'run', '--local-agent', agentModulePath, 'capability_discovery'], {
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.strictEqual(res.status, 0, `CLI exited non-zero:\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.match(res.stdout, /capability_discovery/);
});

test('--format junit emits valid JUnit XML on stdout', () => {
  const res = spawnSync(
    'node',
    [CLI, 'storyboard', 'run', '--local-agent', agentModulePath, 'capability_discovery', '--format', 'junit'],
    { encoding: 'utf8', timeout: 45_000 }
  );
  assert.strictEqual(res.status, 0, `CLI exited non-zero:\nstderr:${res.stderr}`);
  assert.match(res.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(res.stdout, /<testsuites[^>]+tests="\d+"/);
  assert.match(res.stdout, /<testsuite[^>]+name="[^"]+"/);
  assert.match(res.stdout, /<testcase[^>]+classname="capability_discovery"/);
});

test('--local-agent rejects modules without a createAgent export', () => {
  const brokenPath = path.join(tmpDir, 'broken.cjs');
  writeFileSync(brokenPath, 'module.exports = { notCreateAgent: () => null };');
  const res = spawnSync('node', [CLI, 'storyboard', 'run', '--local-agent', brokenPath, 'capability_discovery'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /must export `createAgent`/);
});

test('--format junit without --local-agent or storyboard-id is rejected for full assessment', () => {
  const res = spawnSync('node', [CLI, 'storyboard', 'run', 'test-mcp', '--format', 'junit'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--format junit requires/);
});
