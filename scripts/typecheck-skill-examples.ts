#!/usr/bin/env tsx
/**
 * Typecheck every fenced TypeScript block in `skills/**\/*.md` against the
 * published `@adcp/client` types. Catches drift between skill code samples
 * and the actual SDK surface — the failure mode that landed PR #945
 * (the creative skill taught a `server.registerTool` API that doesn't
 * exist on `AdcpServer`).
 *
 * How it works:
 *
 * 1. Walks `skills/**\/*.md`.
 * 2. Extracts every ` ```typescript ` / ` ```ts ` fenced block.
 * 3. Writes each block to its own file under `.cache/skill-examples/`,
 *    one file per block, so top-level imports + top-level statements
 *    work and one block's syntax error doesn't poison the next.
 * 4. Generates a `tsconfig.json` resolving `@adcp/client` to the local
 *    `dist/` so we test the *published* surface — same thing a downstream
 *    consumer sees.
 * 5. Runs `tsc --noEmit` over the cache and reports.
 *
 * Skip markers (apply to one block):
 *
 *   <!-- skill-example-skip: <reason> -->
 *
 * placed on the line immediately preceding the opening fence. Use sparingly
 * — every skipped block is a place where the harness can't catch drift.
 *
 * Usage:
 *
 *   tsx scripts/typecheck-skill-examples.ts                    # default — compare to baseline
 *   tsx scripts/typecheck-skill-examples.ts --update-baseline  # capture current errors
 *   tsx scripts/typecheck-skill-examples.ts --keep             # leave .cache/ around
 *   tsx scripts/typecheck-skill-examples.ts --verbose          # show extraction + skipped
 *
 * Exit code: 0 = no NEW typecheck errors vs baseline. 1 = at least one new error.
 *            2 = harness error (no skills found, dist missing, etc.).
 *
 * Baseline file: `scripts/skill-examples.baseline.json` records the set of
 * error fingerprints (sourceFile:errorCode:message) currently known and
 * accepted as documentation-pattern noise (placeholder identifiers, untyped
 * `ctx.store.list` returns, etc.). New errors fail the run; baselined errors
 * are reported as "known" but don't fail. Errors that disappeared since
 * baseline are reported so the baseline can be tightened.
 *
 * Prerequisites: `npm run build:lib` must have run so `dist/` is populated;
 * the script reminds you if it isn't.
 */

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const CACHE_DIR = join(REPO_ROOT, '.cache/skill-examples');
const DIST_DIR = join(REPO_ROOT, 'dist');

interface CliArgs {
  keep: boolean;
  verbose: boolean;
  updateBaseline: boolean;
}

const BASELINE_PATH = join(REPO_ROOT, 'scripts/skill-examples.baseline.json');

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { keep: false, verbose: false, updateBaseline: false };
  for (const a of argv) {
    if (a === '--keep') out.keep = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--update-baseline') out.updateBaseline = true;
    else if (a === '-h' || a === '--help') {
      console.error(`Usage: typecheck-skill-examples [--keep] [--verbose] [--update-baseline]`);
      process.exit(0);
    }
  }
  return out;
}

interface BaselineEntry {
  source: string;
  errorCode: string;
  /** Truncated to 80 chars so cosmetic message changes don't churn the baseline. */
  messagePrefix: string;
}

function entryKey(e: BaselineEntry): string {
  return `${e.source}|${e.errorCode}|${e.messagePrefix}`;
}

async function loadBaseline(): Promise<BaselineEntry[]> {
  try {
    const raw = await readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(raw) as BaselineEntry[];
  } catch {
    return [];
  }
}

async function writeBaseline(entries: BaselineEntry[]): Promise<void> {
  // Sort for stable diffs.
  const sorted = [...entries].sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  await writeFile(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

interface ExtractedBlock {
  /** Path relative to repo root (e.g., `skills/build-creative-agent/SKILL.md`). */
  sourceFile: string;
  /** 1-based block index within the source file. */
  index: number;
  /** 1-based line number of the opening ``` fence in the source file. */
  startLine: number;
  /** Raw block content (no fences). */
  content: string;
  /** Skip reason, if a `<!-- skill-example-skip: ... -->` marker preceded the fence. */
  skipReason?: string;
}

/**
 * Determine whether a block is a "full module" (compiles standalone) or a
 * "fragment" (object literal, partial handler block, etc. — won't parse as
 * top-level TypeScript and isn't meant to).
 *
 * Rule: a block is a full module when it has BOTH (a) at least one
 * `import ... from '...'` line AND (b) a top-level call to `serve(`,
 * `createAdcpServer(`, `createIdempotencyStore(`, or similar entry-point
 * that anchors it as a complete agent file.
 *
 * Why both checks: a fragment like `import { displayRender } from '@adcp/client'; \n
 * buildCreative: async (params) => { ... }` has imports but is still a
 * partial handler — the property syntax fails to parse at the top level.
 * Requiring an entry-point call rules those out without false-skipping
 * real agents.
 *
 * The drift class we're catching with this harness (`server.registerTool`
 * and similar API drift) only shows up in full modules — by definition,
 * the drift requires SDK symbols to be referenced *in a context that
 * compiles*. Fragments are documentation about *shape*, not *behavior*,
 * and trying to compile them standalone produces parser-error noise
 * that drowns out real signal.
 */
const FULL_MODULE_ANCHORS = [
  /\bserve\s*\(/,
  /\bcreateAdcpServer\s*\(/,
  /\bcreateIdempotencyStore\s*\(/,
  /\bcreateComplyController\s*\(/,
];

function isFullModule(content: string): boolean {
  const hasImport = /^[ \t]*import[ \t]+.+from[ \t]+['"]/m.test(content);
  if (!hasImport) return false;
  return FULL_MODULE_ANCHORS.some(re => re.test(content));
}

const FENCE_RE = /^```(typescript|ts)\s*$/;
const SKIP_MARKER_RE = /^<!--\s*skill-example-skip:\s*(.*?)\s*-->\s*$/;

function extractBlocks(sourceFile: string, content: string): ExtractedBlock[] {
  const lines = content.split('\n');
  const blocks: ExtractedBlock[] = [];
  let i = 0;
  let nextIndex = 1;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      const startLine = i + 1; // 1-based
      // Look back for a skip marker on the immediately preceding non-blank line.
      let skipReason: string | undefined;
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        const prev = lines[j].trim();
        if (prev === '') continue;
        const m = prev.match(SKIP_MARKER_RE);
        if (m) skipReason = m[1];
        break;
      }
      // Find closing fence.
      const inner: string[] = [];
      let k = i + 1;
      while (k < lines.length && lines[k].trim() !== '```') {
        inner.push(lines[k]);
        k++;
      }
      blocks.push({
        sourceFile,
        index: nextIndex++,
        startLine,
        content: inner.join('\n'),
        skipReason,
      });
      i = k + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

async function walkSkillFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkSkillFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function blockToFilename(block: ExtractedBlock): string {
  // Map `skills/build-creative-agent/SKILL.md` + index 3 → `build-creative-agent_SKILL_03.ts`.
  const flat = block.sourceFile
    .replace(/^skills\//, '')
    .replace(/\.md$/, '')
    .replace(/[\\/]/g, '_');
  const padded = String(block.index).padStart(2, '0');
  return `${flat}_${padded}.ts`;
}

async function ensureDistBuilt(): Promise<void> {
  const s = await stat(DIST_DIR).catch(() => null);
  if (!s?.isDirectory()) {
    console.error(
      `[typecheck-skill-examples] error: dist/ not found at ${DIST_DIR}. Run "npm run build:lib" first so @adcp/client resolves to the published surface.`
    );
    process.exit(2);
  }
}

async function writeTsconfig(): Promise<void> {
  // Per-block files import `@adcp/client` and `@adcp/client/server`. Map both
  // to the built dist so we test the *exported* shape, not the in-tree source.
  // baseUrl + paths handles the resolution; module/moduleResolution match what
  // a downstream Node16 consumer would use.
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      allowJs: false,
      baseUrl: '.',
      paths: {
        '@adcp/client': [join(REPO_ROOT, 'dist/lib/index.d.ts')],
        '@adcp/client/server': [join(REPO_ROOT, 'dist/lib/server/index.d.ts')],
        '@adcp/client/*': [join(REPO_ROOT, 'dist/lib/*')],
      },
    },
    include: ['*.ts'],
  };
  await writeFile(join(CACHE_DIR, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n', 'utf8');
}

interface ManifestEntry {
  file: string;
  source: string;
  startLine: number;
  index: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureDistBuilt();

  const skillFiles = await walkSkillFiles(SKILLS_DIR);
  if (skillFiles.length === 0) {
    console.error(`[typecheck-skill-examples] no skill files under ${SKILLS_DIR}`);
    process.exit(2);
  }

  // Fresh cache every run — block extraction is cheap, leftover files would
  // shadow real drift if a block was deleted from a skill since last run.
  await rm(CACHE_DIR, { recursive: true, force: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const manifest: ManifestEntry[] = [];
  let totalBlocks = 0;
  let skippedFragmentBlocks = 0;
  let skippedMarkedBlocks = 0;

  for (const skillFile of skillFiles) {
    const content = await readFile(skillFile, 'utf8');
    const rel = relative(REPO_ROOT, skillFile);
    const blocks = extractBlocks(rel, content);
    for (const b of blocks) {
      totalBlocks++;
      if (b.skipReason) {
        skippedMarkedBlocks++;
        if (args.verbose) {
          console.error(`◇ ${rel}:${b.startLine} block #${b.index} — marker-skip: ${b.skipReason}`);
        }
        continue;
      }
      if (!isFullModule(b.content)) {
        skippedFragmentBlocks++;
        if (args.verbose) {
          console.error(`◇ ${rel}:${b.startLine} block #${b.index} — fragment (no import statement)`);
        }
        continue;
      }
      const filename = blockToFilename(b);
      const filePath = join(CACHE_DIR, filename);
      // Prepend a one-line marker comment so tsc errors include traceable
      // source coordinates. Each block sits at the top level of its own file —
      // top-level imports and statements work as written.
      const wrapped = `// source: ${b.sourceFile}:${b.startLine} (block #${b.index})\n${b.content}\n`;
      await writeFile(filePath, wrapped, 'utf8');
      manifest.push({ file: filename, source: b.sourceFile, startLine: b.startLine, index: b.index });
    }
  }

  if (manifest.length === 0) {
    console.error(
      `[typecheck-skill-examples] no compilable blocks found (skipped: ${skippedMarkedBlocks} marker, ${skippedFragmentBlocks} fragment)`
    );
    process.exit(0);
  }

  await writeTsconfig();

  console.error(
    `[typecheck-skill-examples] ${manifest.length} compilable, ${skippedFragmentBlocks} fragment, ${skippedMarkedBlocks} marker-skip — of ${totalBlocks} total in ${skillFiles.length} file(s)`
  );

  const tscPath = resolve(REPO_ROOT, 'node_modules/.bin/tsc');
  const res = spawnSync(tscPath, ['--project', join(CACHE_DIR, 'tsconfig.json'), '--pretty', 'false'], {
    encoding: 'utf8',
  });

  const stdout = (res.stdout ?? '').trim();
  const stderr = (res.stderr ?? '').trim();
  if (stderr && args.verbose) console.error(stderr);

  // Parse tsc output into structured entries we can compare to baseline.
  // Each error line looks like:
  //   .cache/skill-examples/build-creative-agent_SKILL_03.ts(12,5): error TS2304: ...
  const cacheRe = /^([^(]+\.ts)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  interface Diagnostic {
    source: string;
    sourceLine: number;
    column: string;
    blockIndex: number;
    errorCode: string;
    message: string;
  }
  const diagnostics: Diagnostic[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(cacheRe);
    if (!m) continue;
    const cacheFile = m[1];
    const cacheLine = Number(m[2]);
    const entry = manifest.find(e => cacheFile.endsWith(e.file));
    if (!entry) continue;
    diagnostics.push({
      source: entry.source,
      // Cache-file line 1 is `// source:` marker; original-file line = startLine + (cacheLine - 1).
      sourceLine: entry.startLine + (cacheLine - 1),
      column: m[3],
      blockIndex: entry.index,
      errorCode: m[4],
      message: m[5],
    });
  }

  // Lint pass: forbid `as any` in skill examples. The pattern hides API
  // drift the typed surface would otherwise catch — every legitimate cast
  // has a typed alternative (typed factories like `htmlAsset()`, named
  // discriminated unions like `AssetInstance`, helper response builders
  // like `buildCreativeResponse()`). Skill authors who want the escape
  // hatch can use `// @ts-expect-error` against a specific known issue
  // instead, which is greppable and self-documenting.
  const asAnyRe = /\bas\s+any\b/g;
  for (const entry of manifest) {
    const cachePath = join(CACHE_DIR, entry.file);
    const content = await readFile(cachePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null;
      asAnyRe.lastIndex = 0;
      while ((m = asAnyRe.exec(lines[i])) !== null) {
        diagnostics.push({
          source: entry.source,
          // Line 1 is the `// source:` marker; offset matches the tsc path.
          sourceLine: entry.startLine + i,
          column: String(m.index + 1),
          blockIndex: entry.index,
          errorCode: 'LINT-as-any',
          message: '`as any` hides API drift; use a typed factory or // @ts-expect-error instead',
        });
      }
    }
  }

  const currentEntries: BaselineEntry[] = diagnostics.map(d => ({
    source: d.source,
    errorCode: d.errorCode,
    messagePrefix: d.message.slice(0, 80),
  }));

  if (args.updateBaseline) {
    await writeBaseline(currentEntries);
    console.error(
      `\n[typecheck-skill-examples] wrote ${currentEntries.length} entries to ${relative(REPO_ROOT, BASELINE_PATH)}`
    );
    if (!args.keep) await rm(CACHE_DIR, { recursive: true, force: true });
    process.exit(0);
  }

  // Multiset comparison: a `LINT-as-any` rule (or any TS error) can fire
  // multiple times in the same file with the same message. Treat the
  // baseline as "I expect at most N occurrences of [key]" so a third
  // identical error fails CI even when the first two are baselined.
  // Set-based dedup would silently swallow it.
  const baseline = await loadBaseline();
  const baselineCounts = new Map<string, number>();
  for (const e of baseline) {
    const k = entryKey(e);
    baselineCounts.set(k, (baselineCounts.get(k) ?? 0) + 1);
  }
  const remainingBudget = new Map(baselineCounts);
  const newErrors: typeof diagnostics = [];
  for (let i = 0; i < diagnostics.length; i++) {
    const k = entryKey(currentEntries[i]);
    const budget = remainingBudget.get(k) ?? 0;
    if (budget > 0) {
      remainingBudget.set(k, budget - 1);
    } else {
      newErrors.push(diagnostics[i]);
    }
  }
  const fixedKeys: string[] = [];
  for (const [k, count] of remainingBudget) {
    if (count > 0) fixedKeys.push(`${k} (${count} fewer than baselined)`);
  }
  const knownErrorCount = diagnostics.length - newErrors.length;

  if (newErrors.length === 0 && diagnostics.length === 0) {
    console.error(`✓ all ${manifest.length} skill examples typecheck — clean of all baselined and new errors`);
    if (!args.keep) await rm(CACHE_DIR, { recursive: true, force: true });
    process.exit(0);
  }

  if (newErrors.length === 0) {
    console.error(`✓ no new errors (${knownErrorCount} known baselined, ${manifest.length} blocks compiled)`);
    if (fixedKeys.length > 0) {
      console.error(
        `  ◇ ${fixedKeys.length} baselined error(s) no longer reproduce — run with --update-baseline to tighten`
      );
    }
    if (!args.keep) await rm(CACHE_DIR, { recursive: true, force: true });
    process.exit(0);
  }

  console.error(`\n✗ ${newErrors.length} new typecheck error(s) (not in baseline):\n`);
  for (const d of newErrors) {
    console.error(
      `  ${d.source}:${d.sourceLine}:${d.column} (block #${d.blockIndex}) error ${d.errorCode}: ${d.message}`
    );
  }
  console.error(
    `\n${knownErrorCount} baselined error(s) not shown.` +
      `\n\nTo accept these as known issues: tsx scripts/typecheck-skill-examples.ts --update-baseline` +
      `\nTo reproduce locally: tsx scripts/typecheck-skill-examples.ts --keep --verbose`
  );
  if (!args.keep) await rm(CACHE_DIR, { recursive: true, force: true });
  process.exit(1);
}

main().catch(err => {
  console.error(`[typecheck-skill-examples] fatal: ${err?.stack ?? err}`);
  process.exit(2);
});
