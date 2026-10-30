const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

function scenario(t, source) {
  const directory = mkdtempSync(path.join(tmpdir(), 'adcp-performance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'scenario.mjs');
  writeFileSync(file, source);
  return pathToFileURL(file).href;
}

test('performance budgets reject missing measurements and resource overruns', async () => {
  const { evaluateBudgets } = await import('../scripts/performance/metrics.mjs');
  assert.deepEqual(evaluateBudgets({ compilations: 0 }, { compilations: 0 }), []);
  assert.equal(evaluateBudgets({ compilations: 1 }, { compilations: 0 }).length, 1);
  assert.equal(evaluateBudgets({}, { peakRssBytes: 1024 }).length, 1);
  assert.equal(evaluateBudgets({ cpuMs: NaN }, { cpuMs: 100 }).length, 1);
  assert.equal(evaluateBudgets({}, {}).length, 1, 'an empty workload must not silently pass');
});

test('isolated measurements detect synchronous stalls, peak memory, and retained allocations', async t => {
  const { runIsolatedScenario } = await import('../scripts/performance/isolate.mjs');
  const file = scenario(
    t,
    `
    import { performance } from 'node:perf_hooks';
    let retained;
    export async function run({ measurePhase }) {
      const phase = await measurePhase('blocking allocation', () => {
        retained = new Array(1_000_000).fill(1);
        const until = performance.now() + 150;
        while (performance.now() < until) {}
      });
      return { phases: [phase], metrics: { maxStallMs: phase.eventLoopMaxMs, retainedValues: retained.length }, maximums: { maxStallMs: 50 } };
    }
  `
  );
  const result = await runIsolatedScenario({ scenario: file });
  assert.equal(result.error, undefined);
  assert.equal(result.passed, false, 'stall budget must fail, even though the workload completed');
  assert.match(result.violations[0], /maxStallMs/);
  const phase = result.phases[0];
  assert.ok(phase.afterGc.heapUsed - phase.before.heapUsed > 5 * 1024 ** 2);
  assert.ok(result.memory.peakRssBytes >= phase.before.rss);
});

test('parent watchdog terminates a worker whose main thread cannot run timers', async t => {
  const { runIsolatedScenario } = await import('../scripts/performance/isolate.mjs');
  const file = scenario(t, 'export async function run() { while (true) {} }');
  const result = await runIsolatedScenario({ scenario: file, timeoutMs: 500 });
  assert.equal(result.passed, false);
  assert.match(result.error, /wall-time budget/);
});

test('worker failures become failed reports rather than successful empty measurements', async t => {
  const { runIsolatedScenario } = await import('../scripts/performance/isolate.mjs');
  const file = scenario(t, 'export async function run() { throw new Error("workload failed"); }');
  const result = await runIsolatedScenario({ scenario: file });
  assert.equal(result.passed, false);
  assert.match(result.error, /workload failed/);
});

test('the performance CLI fails CI and preserves its report when a retention guard trips', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'adcp-performance-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'failed.json');
  const result = spawnSync(
    process.execPath,
    ['scripts/performance/run.mjs', '--scenario', 'schema-cache-churn', '--mode', 'leaky', '--output', output],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].error, undefined);
  assert.ok(report.cases[0].violations.some(violation => violation.startsWith('liveSchemas:')));
});
