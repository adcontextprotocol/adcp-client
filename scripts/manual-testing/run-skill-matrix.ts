#!/usr/bin/env tsx
/**
 * Run agent-skill-storyboard harness across every skill × storyboard pair
 * declared in `skill-matrix.json`. Summary table at the end — pass/fail per
 * pair plus wall time. Exits non-zero if any pair fails.
 *
 * Perf:
 * - `--parallel N` fans pairs across N workers (each gets a port base).
 *   Default is min(4, os.cpus/2) — matrix is CPU-bound on Claude spin-up +
 *   TypeScript build + grader; >4 on a laptop deadlocks easily.
 * - Shared `node_modules` prepared once in `.cache/harness-template/` and
 *   symlinked into each scratch workspace, amortizing the 15–30s per-pair
 *   `npm install` across the whole matrix.
 * - Fast-fails up front if the `claude` CLI is missing.
 *
 * Usage:
 *   tsx scripts/manual-testing/run-skill-matrix.ts [options]
 *
 * Options:
 *   --filter <substring>   Run only pairs whose skill path or storyboard id
 *                          matches the substring. Repeatable via comma.
 *   --parallel <N>         Worker pool size. Default auto (see above).
 *   --matrix <path>        Override matrix JSON location.
 *   --keep-workspaces      Pass --keep to each harness run for post-mortem.
 *   --timeout-ms <N>       Per-pair timeout. Default 600000 (10 min).
 *   --stop-on-first-fail   Abort the whole matrix on first failure.
 *   --no-shared-install    Force each pair to run its own `npm install`
 *                          (useful when debugging cache-related weirdness).
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

interface Pair {
  skill: string;
  storyboard: string;
}

interface Matrix {
  pairs: Pair[];
}

interface Args {
  filter: string[];
  parallel: number;
  matrix: string;
  keep: boolean;
  timeoutMs: number;
  stopOnFail: boolean;
  sharedInstall: boolean;
}

const REPO_ROOT = resolve(__dirname, '..', '..');
const HARNESS = join(REPO_ROOT, 'scripts/manual-testing/agent-skill-storyboard.ts');
const TEMPLATE_DIR = join(REPO_ROOT, '.cache/harness-template');
const TEMPLATE_NODE_MODULES = join(TEMPLATE_DIR, 'node_modules');

function defaultParallel(): number {
  // Claude spin-up + tsc/tsx transpile + grader share one CPU each. 4 is a
  // safe cap on modern laptops; half of cpus handles smaller boxes sanely.
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    filter: [],
    parallel: defaultParallel(),
    matrix: join(REPO_ROOT, 'scripts/manual-testing/skill-matrix.json'),
    keep: false,
    timeoutMs: 600_000,
    stopOnFail: false,
    sharedInstall: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') out.filter.push(...argv[++i].split(','));
    else if (a === '--parallel') out.parallel = Math.max(1, Number(argv[++i]));
    else if (a === '--matrix') out.matrix = resolve(argv[++i]);
    else if (a === '--keep-workspaces') out.keep = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--stop-on-first-fail') out.stopOnFail = true;
    else if (a === '--no-shared-install') out.sharedInstall = false;
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    }
  }
  return out;
}

function printUsage(): void {
  console.error(
    `Usage: run-skill-matrix [--filter <substr>] [--parallel <N>] [--matrix <path>] [--keep-workspaces] [--timeout-ms <N>] [--stop-on-first-fail] [--no-shared-install]`
  );
}

function selectPairs(all: Pair[], filters: string[]): Pair[] {
  if (filters.length === 0) return all;
  return all.filter(p => filters.some(f => p.skill.includes(f) || p.storyboard.includes(f)));
}

// Ports are assigned from a per-worker base to avoid collisions when pairs run
// in parallel. A fixed offset of 100 per worker slot leaves plenty of headroom.
function portFor(workerId: number): number {
  return 4200 + workerId * 100;
}

/**
 * Fast-fail if the `claude` CLI isn't available. The harness would fail ~5s
 * in anyway but by then Claude spawn has blocked the spinner and the error
 * is less actionable. Doing it up-front saves every pair from hitting the
 * same wall.
 */
function requireClaude(): void {
  const res = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  if (res.error || res.status !== 0) {
    console.error(
      '[matrix] fatal: `claude` CLI not found on PATH. ' +
        'Install Claude Code (https://github.com/anthropics/claude-code) and retry.'
    );
    process.exit(2);
  }
}

/**
 * Prepare a cached node_modules once per matrix run. Each scratch workspace
 * symlinks this into place instead of doing its own `npm install`, cutting
 * per-pair wall time by 15–30s. The template's `package.json` must match
 * exactly what `agent-skill-storyboard.ts` writes into scratch dirs —
 * deps are hardcoded there so drift between the two is the only failure
 * mode. When it does drift, pass `--no-shared-install` as the escape hatch.
 */
async function prepareSharedNodeModules(): Promise<string> {
  // Check if the template is already built. A node_modules directory at the
  // expected path is sufficient — the `file:<repo>` dep re-resolves against
  // the current repo every time, so stale builds are cheap to rebuild but
  // don't produce wrong answers.
  const existing = await stat(TEMPLATE_NODE_MODULES).catch(() => null);
  if (existing?.isDirectory()) {
    console.error(`[matrix] reusing cached node_modules at ${TEMPLATE_NODE_MODULES}`);
    return TEMPLATE_NODE_MODULES;
  }

  console.error(`[matrix] preparing shared node_modules (one-time, ~30s)`);
  await mkdir(TEMPLATE_DIR, { recursive: true });
  const pkg = {
    name: 'adcp-agent-skill-harness-template',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@adcp/client': `file:${REPO_ROOT}`,
      tsx: '^4.7.0',
    },
  };
  await writeFile(join(TEMPLATE_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: TEMPLATE_DIR,
    stdio: 'inherit',
  });
  if (npm.status !== 0) {
    throw new Error(
      `[matrix] template install failed (exit ${npm.status}). Re-run with --no-shared-install to bypass.`
    );
  }
  return TEMPLATE_NODE_MODULES;
}

interface RunResult {
  pair: Pair;
  passed: boolean;
  durationMs: number;
  exitCode: number;
  stderr: string;
}

function runOne(pair: Pair, port: number, args: Args, sharedNodeModules?: string): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const harnessArgs = [
      HARNESS,
      '--skill',
      pair.skill,
      '--storyboard',
      pair.storyboard,
      '--port',
      String(port),
      '--timeout-ms',
      String(args.timeoutMs),
    ];
    if (args.keep) harnessArgs.push('--keep');
    if (sharedNodeModules) harnessArgs.push('--shared-node-modules', sharedNodeModules);

    const started = Date.now();
    const stderrChunks: Buffer[] = [];
    const child = spawn('tsx', harnessArgs, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    child.stderr.on('data', chunk => stderrChunks.push(chunk));
    child.on('exit', code => {
      resolvePromise({
        pair,
        passed: code === 0,
        durationMs: Date.now() - started,
        exitCode: code ?? -1,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  requireClaude();

  const raw = await readFile(args.matrix, 'utf8');
  const matrix = JSON.parse(raw) as Matrix;
  const pairs = selectPairs(matrix.pairs, args.filter);

  if (pairs.length === 0) {
    console.error('No matrix pairs matched filter.');
    process.exit(2);
  }

  const sharedNodeModules = args.sharedInstall ? await prepareSharedNodeModules() : undefined;

  const matrixStart = Date.now();
  console.error(
    `[matrix] ${pairs.length} pair(s) × parallel=${args.parallel} × timeout=${args.timeoutMs}ms${sharedNodeModules ? ' × shared-nm=on' : ''}`
  );

  const queue = pairs.map((p, i) => ({ pair: p, index: i }));
  const results: RunResult[] = [];
  let nextIdx = 0;
  let stopped = false;

  // Simple worker pool. Each worker pulls from the queue, runs one pair at
  // a time, and terminates when the queue is empty. Port offset per worker
  // id keeps concurrent pairs from fighting over the same listen port.
  async function worker(workerId: number): Promise<void> {
    while (!stopped) {
      const i = nextIdx++;
      if (i >= queue.length) return;
      const item = queue[i];
      const port = portFor(workerId);
      const label = `[${i + 1}/${queue.length}] ${item.pair.skill.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '')} × ${item.pair.storyboard}`;
      console.error(`\n▶ ${label} (port ${port})`);
      const result = await runOne(item.pair, port, args, sharedNodeModules);
      results.push(result);
      const durSec = (result.durationMs / 1000).toFixed(1);
      if (result.passed) {
        console.error(`✓ ${label} (${durSec}s)`);
      } else {
        console.error(`✗ ${label} (${durSec}s, exit=${result.exitCode})`);
        if (args.stopOnFail) stopped = true;
      }
    }
  }

  const workers = Array.from({ length: Math.min(args.parallel, pairs.length) }, (_, i) => worker(i));
  await Promise.all(workers);

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const matrixWall = Date.now() - matrixStart;
  const totalCpu = results.reduce((a, r) => a + r.durationMs, 0);

  console.error('\n' + '═'.repeat(72));
  console.error('MATRIX SUMMARY');
  console.error('═'.repeat(72));
  for (const r of results) {
    const sym = r.passed ? '✓' : '✗';
    const durSec = (r.durationMs / 1000).toFixed(1).padStart(5);
    const skill = r.pair.skill
      .replace(/^skills\//, '')
      .replace(/\/SKILL\.md$/, '')
      .padEnd(32);
    console.error(`${sym} ${durSec}s  ${skill} ${r.pair.storyboard}`);
  }
  console.error('─'.repeat(72));
  console.error(
    `${passed} passed, ${failed} failed (of ${results.length}) — wall ${(matrixWall / 1000).toFixed(1)}s, cpu ${(totalCpu / 1000).toFixed(1)}s (speedup ${(totalCpu / Math.max(1, matrixWall)).toFixed(1)}×)`
  );
  if (stopped && nextIdx < queue.length) {
    const remaining = queue.length - results.length;
    console.error(`(${remaining} pair(s) skipped due to --stop-on-first-fail)`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('[matrix] fatal:', err);
  process.exit(2);
});
