#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runIsolatedScenario } from './isolate.mjs';

const scenarios = [
  {
    name: 'mcp-discovery',
    file: new URL('./scenarios/mcp-discovery.mjs', import.meta.url).href,
    negativeMode: 'uncached',
  },
  {
    name: 'mcp-output-validation',
    file: new URL('./scenarios/mcp-output-validation.mjs', import.meta.url).href,
    negativeMode: 'unfactored',
  },
  {
    name: 'schema-cache-churn',
    file: new URL('./scenarios/schema-cache-churn.mjs', import.meta.url).href,
    negativeMode: 'leaky',
  },
];

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', multiple: true },
    compare: { type: 'boolean', default: false },
    mode: { type: 'string', default: 'cached' },
    connections: { type: 'string', default: '3' },
    listings: { type: 'string', default: '2' },
    tools: { type: 'string' },
    'adcp-version': { type: 'string', default: '3.2.7' },
    'timeout-ms': { type: 'string', default: '180000' },
    'heap-mb': { type: 'string', default: '2048' },
    output: { type: 'string', default: '.context/performance.json' },
  },
});

function integer(name, minimum) {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return value;
}

const selected = values.scenario ?? scenarios.map(scenario => scenario.name);
for (const name of selected)
  if (!scenarios.some(scenario => scenario.name === name)) throw new Error(`Unknown scenario: ${name}`);
if (values.compare && values.mode !== 'cached') throw new Error('--compare cannot be combined with --mode');
const options = {
  connections: integer('connections', 2),
  listings: integer('listings', 2),
  adcpVersion: values['adcp-version'],
  ...(values.tools && { tools: [...new Set(values.tools.split(','))] }),
};
const timeoutMs = integer('timeout-ms', 1);
const heapMb = integer('heap-mb', 32);
const report = {
  formatVersion: 1,
  timestamp: new Date().toISOString(),
  environment: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
  },
  cases: [],
};
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true });
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
save();

let passed = true;
for (const scenario of scenarios.filter(scenario => selected.includes(scenario.name))) {
  const modes = values.compare ? [scenario.negativeMode, 'cached'] : [values.mode];
  for (const mode of modes) {
    if (mode !== 'cached' && mode !== scenario.negativeMode)
      throw new Error(`Unsupported mode ${mode} for ${scenario.name}`);
    console.log(`Running ${scenario.name} (${mode}) in an isolated process...`);
    const result = await runIsolatedScenario({ scenario: scenario.file, mode, options, timeoutMs, heapMb });
    const expectedRegression = values.compare && mode === scenario.negativeMode;
    // A killed/crashed negative control is not evidence that our metric
    // budgets detect regressions: it must finish and fail an actual guard.
    const accepted = expectedRegression ? !result.error && result.violations?.length > 0 : result.passed === true;
    passed &&= accepted;
    report.cases.push({ scenario: scenario.name, mode, expectedRegression, accepted, ...result });
    save();
    console.log(`${accepted ? 'PASS' : 'FAIL'}${expectedRegression ? ' (negative control must trip a guard)' : ''}`);
    for (const violation of result.violations ?? []) console.log(`  ${violation}`);
    if (result.error) console.error(result.error, result.output ?? '');
  }
}

const number = value => (Number.isFinite(value) ? value.toFixed(1) : '—');
const rows = report.cases.map(result => {
  const m = result.metrics ?? {};
  return `| ${result.scenario} | ${result.mode} | ${number(m.warmCompilations)} | ${number(m.warmCpuMsPerListing)} | ${number(m.warmEventLoopMaxMs)} | ${number(result.memory?.peakRssBytes / 1024 ** 2)} | ${number(m.largestFunctionBytes / 1024)} | ${number(m.liveSchemas)} | ${result.accepted ? 'PASS' : 'FAIL'} |`;
});
const summary = [
  '### SDK performance regression checks',
  '',
  '| Workload | Mode | Warm compiles | CPU/list (ms) | Max warm stall (ms) | Process peak RSS (MiB) | Largest function (KiB) | Live schemas | Check |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ...rows,
  '',
  'Uncached/unfactored/leaky modes are negative controls: PASS means the guards detected the regression.',
  'RSS is the OS process high-water mark, including setup and cold compilation; it captures peaks during main-thread stalls.',
  '',
].join('\n');
console.log(summary);
console.log(`Full phase timings, memory samples, schema hashes and budgets: ${output}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
report.passed = passed;
save();
if (!passed) process.exitCode = 1;
