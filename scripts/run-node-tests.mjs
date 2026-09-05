#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
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
  'test/lib/cli-webhook-receiver-flag.test.js',
  'test/lib/conformance-cli.test.js',
  'test/lib/conformance-seeder.test.js',
  'test/lib/media-buy-lifecycle-release-gate.test.js',
  'test/lib/storyboard-notices.test.js',
  'test/lib/storyboard-requires-gate.test.js',
]);

function normalizeTestPath(testPath) {
  return testPath.split(path.sep).join('/');
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

function validateShard(shard) {
  if (shard === undefined) return;
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
    throw new Error(`--shard must use the form N/M; received ${JSON.stringify(shard)}`);
  }
  const [index, total] = shard.split('/').map(Number);
  if (index > total) throw new Error(`--shard index ${index} exceeds shard count ${total}`);
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
  validateShard(options.shard);
  const files = resolveRequestedFiles(options);
  if (files.length === 0) throw new Error('No test files matched the requested scope and group');

  const containsSlowTest = files.some(file => SLOW_NODE_TESTS.has(normalizeTestPath(file)));
  const timeoutMs = options.group === 'slow' || containsSlowTest ? 180_000 : 60_000;
  const concurrency = resolveTestConcurrency({
    cliValue: options.concurrency,
    env,
    group: options.group,
  });
  const args = buildNodeTestArgsForFiles({ concurrency, files, shard: options.shard, timeoutMs });

  return { args, concurrency, files, timeoutMs };
}

export function buildNodeTestArgsForFiles({ concurrency, files, shard, timeoutMs }) {
  const args = [`--test-timeout=${timeoutMs}`, '--test-force-exit'];
  if (concurrency !== undefined) args.push(`--test-concurrency=${concurrency}`);
  if (shard !== undefined) args.push(`--test-shard=${shard}`);
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
  const batches = shouldBatchNodeTests(options, env)
    ? batchNodeTests(invocation.files)
    : [invocation.files];

  return {
    ...invocation,
    batches,
    batchArgs: batches.map(files => buildNodeTestArgsForFiles({
      concurrency: invocation.concurrency,
      files,
      shard: options.shard,
      timeoutMs: invocation.timeoutMs,
    })),
  };
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
    process.on(signal, handler);
  }

  try {
    const exitCode = await runBatches(plan.batchArgs, async args => {
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
    }, {
      onFailure: (exitCode, index, error) => {
        const details = error ? `: ${error.message}` : '';
        console.error(`[node-tests] batch ${index + 1}/${plan.batchArgs.length} failed with exit ${exitCode}${details}`);
      },
      shouldStop: () => interrupted !== undefined,
    });
    return interrupted ? exitCode || 1 : exitCode;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
}

async function run() {
  const options = parseRunnerArgs(process.argv.slice(2));
  const plan = buildNodeTestPlan(options);

  if (options.list) {
    process.stdout.write(`${plan.files.join('\n')}\n`);
    return;
  }

  const concurrencyLabel = plan.concurrency ?? 'Node default (CI)';
  const batchingLabel = plan.batches.length > 1
    ? `; ${plan.batches.length} local batches of up to ${LOCAL_TEST_BATCH_SIZE} files`
    : '';
  console.log(
    `[node-tests] ${plan.files.length} files; group=${options.group}; ` +
      `concurrency=${concurrencyLabel}; timeout=${plan.timeoutMs}ms${batchingLabel}`
  );

  process.exitCode = await runNodeTestBatches(plan);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch(error => {
    console.error(`[node-tests] ${error.message}`);
    process.exitCode = 1;
  });
}
