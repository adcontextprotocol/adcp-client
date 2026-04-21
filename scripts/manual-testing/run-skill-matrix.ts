#!/usr/bin/env tsx
/**
 * Run agent-skill-storyboard harness across every skill × storyboard pair
 * declared in `skill-matrix.json`. Summary table at the end — pass/fail per
 * pair plus wall time. Exits non-zero if any pair fails.
 *
 * Usage:
 *   tsx scripts/manual-testing/run-skill-matrix.ts [options]
 *
 * Options:
 *   --filter <substring>   Run only pairs whose skill path or storyboard id
 *                          matches the substring. Repeatable via comma.
 *   --parallel <N>         Run up to N pairs concurrently. Default 1
 *                          (builds are CPU-bound; >2 on a laptop is unwise).
 *   --matrix <path>        Override matrix JSON location.
 *   --keep-workspaces      Pass --keep to each harness run for post-mortem.
 *   --timeout-ms <N>       Per-pair timeout. Default 600000 (10 min).
 *   --stop-on-first-fail   Abort the whole matrix on first failure.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
}

const REPO_ROOT = resolve(__dirname, '..', '..');
const HARNESS = join(REPO_ROOT, 'scripts/manual-testing/agent-skill-storyboard.ts');

function parseArgs(argv: string[]): Args {
  const out: Args = {
    filter: [],
    parallel: 1,
    matrix: join(REPO_ROOT, 'scripts/manual-testing/skill-matrix.json'),
    keep: false,
    timeoutMs: 600_000,
    stopOnFail: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') out.filter.push(...argv[++i].split(','));
    else if (a === '--parallel') out.parallel = Math.max(1, Number(argv[++i]));
    else if (a === '--matrix') out.matrix = resolve(argv[++i]);
    else if (a === '--keep-workspaces') out.keep = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--stop-on-first-fail') out.stopOnFail = true;
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    }
  }
  return out;
}

function printUsage(): void {
  console.error(
    `Usage: run-skill-matrix [--filter <substr>] [--parallel <N>] [--matrix <path>] [--keep-workspaces] [--timeout-ms <N>] [--stop-on-first-fail]`
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

interface RunResult {
  pair: Pair;
  passed: boolean;
  durationMs: number;
  exitCode: number;
  stderr: string;
}

function runOne(pair: Pair, port: number, args: Args): Promise<RunResult> {
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
  const raw = await readFile(args.matrix, 'utf8');
  const matrix = JSON.parse(raw) as Matrix;
  const pairs = selectPairs(matrix.pairs, args.filter);

  if (pairs.length === 0) {
    console.error('No matrix pairs matched filter.');
    process.exit(2);
  }

  console.error(`[matrix] ${pairs.length} pair(s) × parallel=${args.parallel} × timeout=${args.timeoutMs}ms`);

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
      const result = await runOne(item.pair, port, args);
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
  console.error(`${passed} passed, ${failed} failed (of ${results.length})`);
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
