#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SLOW_NODE_TESTS = new Set([
  'test/canonical-creatives-a2a-e2e.test.js',
  'test/generate-zod-object-intersections.test.js',
  'test/server-decisioning-from-platform.test.js',
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
  const isCi = env.CI !== undefined && !['', '0', 'false'].includes(String(env.CI).toLowerCase());
  if (isCi) return undefined;
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
  const args = [`--test-timeout=${timeoutMs}`, '--test-force-exit'];
  if (concurrency !== undefined) args.push(`--test-concurrency=${concurrency}`);
  if (options.shard !== undefined) args.push(`--test-shard=${options.shard}`);
  args.push('--test', ...files);

  return { args, concurrency, files, timeoutMs };
}

async function run() {
  const options = parseRunnerArgs(process.argv.slice(2));
  const invocation = buildNodeTestArgs(options);

  if (options.list) {
    process.stdout.write(`${invocation.files.join('\n')}\n`);
    return;
  }

  const concurrencyLabel = invocation.concurrency ?? 'Node default (CI)';
  console.log(
    `[node-tests] ${invocation.files.length} files; group=${options.group}; ` +
      `concurrency=${concurrencyLabel}; timeout=${invocation.timeoutMs}ms`
  );

  const child = spawn(process.execPath, invocation.args, {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => child.kill(signal));
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = exitCode;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch(error => {
    console.error(`[node-tests] ${error.message}`);
    process.exitCode = 1;
  });
}
