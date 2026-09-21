#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep a local test-runner process well below the cumulative heap footprint of
// the whole suite.  Each batch is a fresh Node process, so its heap is released
// before the next batch starts.  This intentionally does not apply to CI
// shards or focused-file runs, whose one-process behavior is useful and
// established.
export const LOCAL_TEST_BATCH_SIZE = 25;

export const SLOW_NODE_TESTS = new Set([
  'test/lib/account-change-feed-packed.test.js',
  'test/canonical-creatives-a2a-e2e.test.js',
  'test/generate-zod-object-intersections.test.js',
  'test/generate-zod-reporting-status.test.js',
  'test/server-decisioning-from-platform.test.js',
  // Starts a real seller, storyboard receiver, and terminal webhook delivery.
  // Its integration baseline exceeds the fast-suite 60s ceiling.
  'test/examples/hello-seller-adapter-guaranteed.test.js',
  'test/lib/cli-auth-scheme.test.js',
  'test/lib/cli-removed-flags.test.js',
  'test/lib/cli-soft-fail.test.js',
  // Spawns the CLI fifteen times while repairing and validating compliance
  // bundles. It takes ~41s standing alone, leaving too little margin under the
  // fast suite's 60s per-file ceiling once a cold shard runs concurrently.
  'test/lib/cli-test-kit-compliance-version.test.js',
  // Each case spawns the CLI against a live mock agent (flag threading through
  // --file, and the runFullAssessment → comply() assessment path). ~25s on an
  // idle machine, which has no margin under the fast suite's 60s per-file
  // ceiling once a shard runs files concurrently — same class as its CLI
  // siblings here.
  'test/lib/cli-storyboard-signing-threading.test.js',
  'test/lib/cli-webhook-receiver-flag.test.js',
  'test/lib/conformance-cli.test.js',
  // Boots a real seller and runs the conformance runner end to end. It needs
  // ~27s standing alone on an idle machine, which leaves no margin under the
  // fast suite's 60s per-file ceiling once the shard runs files concurrently —
  // it timed out at exactly 60.00s on two of three recent runs with `# fail 0`,
  // i.e. never on an assertion. Its siblings below are here for the same
  // reason; this one was simply missed.
  'test/lib/conformance-integration.test.js',
  'test/lib/conformance-seeder.test.js',
  'test/lib/media-buy-lifecycle-release-gate.test.js',
  'test/lib/storyboard-notices.test.js',
  'test/lib/storyboard-requires-gate.test.js',
  // Boots live MCP agents and loads two real compliance bundles; ~25s standing
  // alone, which leaves no margin under the fast suite's 60s per-test ceiling
  // once a shard runs files concurrently.
  'test/lib/storyboard-capability-rollup.test.js',
  // Boots ~20 live MCP/HTTP mock agents across 54 suites, including a full
  // comply() run and a deliberately slow SSE flood. ~29s standing alone, which
  // is past the point where the fast suite's 60s per-file ceiling still has
  // margin once a shard runs files concurrently — same reasoning as its
  // siblings above.
  'test/lib/storyboard-security.test.js',
]);

function normalizeTestPath(testPath) {
  return testPath.split(path.sep).join('/');
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function discoverTestsIn(relativeDirectory) {
  const directory = path.join(REPO_ROOT, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => `${relativeDirectory}/${entry.name}`)
    .sort();
}

export function discoverNodeTests(scope = 'node') {
  if (scope === 'lib') return discoverTestsIn('test/lib');
  if (scope === 'node') return [...discoverTestsIn('test'), ...discoverTestsIn('test/lib')];
  throw new Error(`Unknown test scope: ${scope}`);
}

export function selectNodeTests(files, group = 'all') {
  if (!['all', 'fast', 'slow'].includes(group)) {
    throw new Error(`Unknown test group: ${group}`);
  }

  return files.filter(file => {
    const isSlow = SLOW_NODE_TESTS.has(normalizeTestPath(file));
    if (group === 'slow') return isSlow;
    if (group === 'fast') return !isSlow;
    return true;
  });
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function isCiEnvironment(env) {
  return env.CI !== undefined && !['', '0', 'false'].includes(String(env.CI).toLowerCase());
}

export function resolveTestConcurrency({
  cliValue,
  env = process.env,
  group = 'fast',
  parallelism = availableParallelism(),
} = {}) {
  if (cliValue !== undefined) return parsePositiveInteger(cliValue, '--concurrency');
  if (env.TEST_CONCURRENCY !== undefined) {
    return parsePositiveInteger(env.TEST_CONCURRENCY, 'TEST_CONCURRENCY');
  }

  // Preserve CI's existing machine-derived behavior. Local runs are deliberately
  // conservative because many test files spawn their own tsc or CLI processes.
  if (isCiEnvironment(env)) return undefined;
  if (group === 'slow') return 1;
  return Math.max(1, Math.min(2, parallelism));
}

function parseOptionValue(argv, index, option) {
  const argument = argv[index];
  const prefix = `${option}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  if (argument === option) {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseRunnerArgs(argv) {
  const options = {
    group: 'all',
    scope: 'node',
    shard: undefined,
    concurrency: undefined,
    list: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const group = parseOptionValue(argv, index, '--group');
    const scope = parseOptionValue(argv, index, '--scope');
    const shard = parseOptionValue(argv, index, '--shard');
    const concurrency = parseOptionValue(argv, index, '--concurrency');

    if (group) {
      options.group = group.value;
      index += group.consumed;
    } else if (scope) {
      options.scope = scope.value;
      index += scope.consumed;
    } else if (shard) {
      options.shard = shard.value;
      index += shard.consumed;
    } else if (concurrency) {
      options.concurrency = concurrency.value;
      index += concurrency.consumed;
    } else if (argument === '--shard-env') {
      if (!process.env.TEST_SHARD) throw new Error('--shard-env requires TEST_SHARD');
      options.shard = process.env.TEST_SHARD;
    } else if (argument === '--list') {
      options.list = true;
    } else if (argument === '--') {
      options.files.push(...argv.slice(index + 1));
      break;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.files.push(argument);
    }
  }

  return options;
}

function parseShard(shard) {
  if (shard === undefined) return undefined;
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
    throw new Error(`--shard must use the form N/M; received ${JSON.stringify(shard)}`);
  }
  const [index, total] = shard.split('/').map(Number);
  if (index > total) throw new Error(`--shard index ${index} exceeds shard count ${total}`);
  return { index, total };
}

function resolveRequestedFiles(options) {
  if (options.files.length > 0) {
    return options.files.map(file => normalizeTestPath(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file))));
  }
  return selectNodeTests(discoverNodeTests(options.scope), options.group);
}

export function buildNodeTestArgs(options, env = process.env) {
  if (!['all', 'fast', 'slow'].includes(options.group)) {
    throw new Error(`Unknown test group: ${options.group}`);
  }
  if (!['node', 'lib'].includes(options.scope)) {
    throw new Error(`Unknown test scope: ${options.scope}`);
  }
  const shard = parseShard(options.shard);
  const requestedFiles = resolveRequestedFiles(options);
  if (requestedFiles.length === 0) throw new Error('No test files matched the requested scope and group');

  // Explicit/focused file execution retains Node's native sharding semantics.
  // Only discovered CI suites use recorded-duration balancing.
  const weightedShard = shard !== undefined && options.files.length === 0;
  const timingData = weightedShard ? loadTestTimings(env.TEST_TIMINGS_FILE) : { tests: {}, source: 'not used' };
  const assignment = weightedShard ? assignWeightedShards(requestedFiles, shard.total, timingData.tests) : undefined;
  const files = assignment ? assignment.shards[shard.index - 1].files : requestedFiles;
  const nodeShard = weightedShard ? undefined : options.shard;

  const containsSlowTest = files.some(file => SLOW_NODE_TESTS.has(normalizeTestPath(file)));
  const timeoutMs = options.group === 'slow' || containsSlowTest ? 180_000 : 60_000;
  const concurrency = resolveTestConcurrency({
    cliValue: options.concurrency,
    env,
    group: options.group,
  });
  const args = buildNodeTestArgsForFiles({
    concurrency,
    files,
    reporter: env.TEST_TIMINGS_OUTPUT ? './scripts/node-test-timing-reporter.mjs' : undefined,
    shard: nodeShard,
    timeoutMs,
  });

  return {
    args,
    assignment,
    concurrency,
    files,
    nodeShard,
    requestedFiles,
    timeoutMs,
    timingSource: timingData.source,
  };
}

export function loadTestTimings(file) {
  if (!file) return { tests: {}, source: 'no timing file configured' };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || parsed.tests === null || typeof parsed.tests !== 'object') {
      throw new Error('expected a version 1 object with a tests map');
    }
    const tests = {};
    for (const [testPath, durationMs] of Object.entries(parsed.tests)) {
      if (typeof testPath === 'string' && Number.isFinite(durationMs) && durationMs > 0) {
        tests[normalizeTestPath(testPath)] = durationMs;
      }
    }
    return { tests, source: `${file} (${Object.keys(tests).length} recorded files)` };
  } catch (error) {
    return { tests: {}, source: `${file} unavailable: ${error.message}` };
  }
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

export function assignWeightedShards(files, shardCount, timings = {}) {
  const total = parsePositiveInteger(shardCount, 'shard count');
  const normalizedFiles = [...new Set(files.map(normalizeTestPath))].sort(comparePaths);
  if (normalizedFiles.length !== files.length) throw new Error('Test file list contains duplicates');

  const measuredDurations = normalizedFiles
    .map(file => timings[file])
    .filter(durationMs => Number.isFinite(durationMs) && durationMs > 0);
  // New or renamed files get the median known cost. With no history at all,
  // every file gets 1 second and the deterministic tie-breakers distribute
  // them evenly until the first trusted main-branch timing refresh completes.
  const fallbackDurationMs = measuredDurations.length > 0 ? median(measuredDurations) : 1_000;
  const weightedFiles = normalizedFiles
    .map(file => ({
      file,
      durationMs: Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : fallbackDurationMs,
      measured: Number.isFinite(timings[file]) && timings[file] > 0,
    }))
    .sort((left, right) => right.durationMs - left.durationMs || comparePaths(left.file, right.file));
  const shards = Array.from({ length: total }, (_, index) => ({
    index: index + 1,
    files: [],
    estimatedDurationMs: 0,
    measuredFiles: 0,
    fallbackFiles: 0,
  }));

  for (const weightedFile of weightedFiles) {
    const target = shards.reduce((lightest, candidate) =>
      candidate.estimatedDurationMs < lightest.estimatedDurationMs ? candidate : lightest
    );
    target.files.push(weightedFile.file);
    target.estimatedDurationMs += weightedFile.durationMs;
    target.measuredFiles += weightedFile.measured ? 1 : 0;
    target.fallbackFiles += weightedFile.measured ? 0 : 1;
  }
  for (const assignedShard of shards) assignedShard.files.sort(comparePaths);

  return { fallbackDurationMs, shards };
}

export function buildNodeTestArgsForFiles({ concurrency, files, reporter, shard, timeoutMs }) {
  const args = [`--test-timeout=${timeoutMs}`, '--test-force-exit'];
  if (concurrency !== undefined) args.push(`--test-concurrency=${concurrency}`);
  if (shard !== undefined) args.push(`--test-shard=${shard}`);
  if (reporter !== undefined) args.push(`--test-reporter=${reporter}`);
  args.push('--test', ...files);

  return args;
}

export function batchNodeTests(files, batchSize = LOCAL_TEST_BATCH_SIZE) {
  const size = parsePositiveInteger(batchSize, 'batch size');
  const batches = [];
  for (let index = 0; index < files.length; index += size) {
    batches.push(files.slice(index, index + size));
  }
  return batches;
}

export function shouldBatchNodeTests(options, env = process.env) {
  return !isCiEnvironment(env) && options.shard === undefined && options.files.length === 0;
}

export function buildNodeTestPlan(options, env = process.env) {
  const invocation = buildNodeTestArgs(options, env);
  const batches = shouldBatchNodeTests(options, env) ? batchNodeTests(invocation.files) : [invocation.files];

  return {
    ...invocation,
    batches,
    batchArgs: batches.map(files =>
      buildNodeTestArgsForFiles({
        concurrency: invocation.concurrency,
        files,
        reporter: env.TEST_TIMINGS_OUTPUT ? './scripts/node-test-timing-reporter.mjs' : undefined,
        shard: invocation.nodeShard,
        timeoutMs: invocation.timeoutMs,
      })
    ),
  };
}

export function writeShardManifest(file, options, plan) {
  if (!file || !plan.assignment || !options.shard) return;
  const manifest = {
    version: 1,
    shard: options.shard,
    timing_source: plan.timingSource,
    fallback_duration_ms: plan.assignment.fallbackDurationMs,
    shards: plan.assignment.shards,
  };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Run every planned batch even after a test failure, matching Node's normal
// behavior of completing the requested files before returning a non-zero exit.
// Exported separately so failure aggregation can be tested without subprocesses.
export async function runBatches(batches, runBatch, { onFailure, shouldStop = () => false } = {}) {
  let exitCode = 0;

  for (let index = 0; index < batches.length && !shouldStop(); index += 1) {
    try {
      const batchExitCode = await runBatch(batches[index], index);
      if (batchExitCode !== 0) {
        if (exitCode === 0) exitCode = batchExitCode ?? 1;
        onFailure?.(batchExitCode, index);
      }
    } catch (error) {
      if (exitCode === 0) exitCode = 1;
      onFailure?.(1, index, error);
    }
  }

  return exitCode;
}

async function runNodeTestBatches(plan) {
  let activeChild;
  let interrupted;
  const signalHandlers = new Map();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      interrupted = signal;
      activeChild?.kill(signal);
    };
    signalHandlers.set(signal, handler);
    // Keep the prior one-shot forwarding semantics: after forwarding an
    // interrupt to the active child, a repeated same signal can use Node's
    // normal termination behavior instead of being swallowed by the runner.
    process.once(signal, handler);
  }

  try {
    const exitCode = await runBatches(
      plan.batchArgs,
      async args => {
        const child = spawn(process.execPath, args, {
          cwd: REPO_ROOT,
          env: { ...process.env, NODE_ENV: 'test' },
          stdio: 'inherit',
        });
        activeChild = child;

        try {
          return await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
          });
        } finally {
          if (activeChild === child) activeChild = undefined;
        }
      },
      {
        onFailure: (exitCode, index, error) => {
          const details = error ? `: ${error.message}` : '';
          console.error(
            `[node-tests] batch ${index + 1}/${plan.batchArgs.length} failed with exit ${exitCode}${details}`
          );
        },
        shouldStop: () => interrupted !== undefined,
      }
    );
    return interrupted ? exitCode || 1 : exitCode;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
}

async function run() {
  const options = parseRunnerArgs(process.argv.slice(2));
  const plan = buildNodeTestPlan(options);

  writeShardManifest(process.env.TEST_SHARD_MANIFEST, options, plan);

  if (options.list) {
    process.stdout.write(`${plan.files.join('\n')}\n`);
    return;
  }

  const concurrencyLabel = plan.concurrency ?? 'Node default (CI)';
  const batchingLabel =
    plan.batches.length > 1 ? `; ${plan.batches.length} local batches of up to ${LOCAL_TEST_BATCH_SIZE} files` : '';
  console.log(
    `[node-tests] ${plan.files.length} files; group=${options.group}; ` +
      `concurrency=${concurrencyLabel}; timeout=${plan.timeoutMs}ms${batchingLabel}`
  );
  if (plan.assignment && options.shard) {
    const { index } = parseShard(options.shard);
    const selected = plan.assignment.shards[index - 1];
    const estimates = plan.assignment.shards.map(shard => `${Math.round(shard.estimatedDurationMs)}ms`).join(', ');
    console.log(
      `[node-tests] weighted shard ${options.shard}; estimate=${Math.round(selected.estimatedDurationMs)}ms; ` +
        `measured=${selected.measuredFiles}; fallback=${selected.fallbackFiles}; all estimates=[${estimates}]; ` +
        `source=${plan.timingSource}`
    );
  }

  process.exitCode = await runNodeTestBatches(plan);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch(error => {
    console.error(`[node-tests] ${error.message}`);
    process.exitCode = 1;
  });
}
