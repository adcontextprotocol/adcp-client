#!/usr/bin/env node
/**
 * Fast, offline publish-size audit for `@adcp/sdk` and `@adcp/reporting-storage`.
 * Requires a prior `npm run build:lib`.
 *
 * Budget policy. The numbers live in `scripts/package-size-budget.json`:
 *
 * 1. Ceilings with headroom. Each package has a packed-byte, unpacked-byte and
 *    file-count ceiling set at a measured size plus deliberate headroom (about
 *    4% for the SDK). The old ceilings were pinned to the measurement, so two
 *    PRs that each added a file or a few KB passed alone and broke `main`
 *    together (#3510 + #3541, #3564 + #3559). A warning fires once less than
 *    two PRs' worth of headroom is left, so the ceiling gets raised, or the
 *    package trimmed, on purpose before parallel PRs can collide on it.
 * 2. Per-PR growth. In CI a pull request is compared with the measurement that
 *    `main` recorded for its exact merge base (`--baseline`). Growing a package
 *    by more than its `perPullRequest` allowance fails unless the same PR raises
 *    that ceiling, which puts the decision in the reviewed diff. Without a
 *    baseline (local runs, or a base commit whose `main` run has not finished)
 *    only the ceilings apply.
 * 3. Structural checks that never move: no source maps, no schema-sync
 *    snapshots, no expanded bundled schemas, no legacy compliance `domains/`
 *    alias, the required schema and compliance roots, and one-line ESM facades
 *    for the large generated declarations.
 *
 * Usage:
 *   node scripts/check-package-size.mjs [--baseline <file>] [--report <file>]
 * `PACKAGE_SIZE_BASELINE`, `PACKAGE_SIZE_REPORT` and `PACKAGE_SIZE_BASE_SHA`
 * (the commit the baseline must describe) are the CI equivalents.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishProtocolArtifacts } from './check-publish-protocol-artifacts.mjs';

export const SDK_PACKAGE = '@adcp/sdk';
const BUDGET_FILE = 'scripts/package-size-budget.json';
const MEASUREMENT_SCHEMA = 1;
/** Metrics a ceiling covers, and the subset a single PR is held to. */
const CEILING_METRICS = ['packedBytes', 'unpackedBytes', 'files'];
const GROWTH_METRICS = ['packedBytes', 'files'];

// Compact local-ref archives replaced the expanded bundled schemas (tens of
// MiB). The ceiling leaves room for a protocol-version swap while still
// failing loudly if expanded bundles return.
const MAX_BUNDLED_SCHEMA_BYTES = 2_200_000;
const MAX_CJS_SCHEMA_DECLARATION_BYTES = 45 * 1024 * 1024;
// Generated declarations whose `.d.mts` is a one-line facade over the CJS
// declaration (see scripts/generate-dmts-declarations.ts). Copying them instead
// would add about 1.2 MB to the packed tarball.
const ESM_FACADE_DECLARATIONS = [
  'dist/lib/types/schemas.generated',
  'dist/lib/types/core.generated',
  'dist/lib/types/tools.generated',
  'dist/lib/registry/types.generated',
];
const MAX_ESM_FACADE_BYTES = 1024;

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function formatCount(value) {
  return value.toLocaleString('en-US');
}

function assertAtMost(label, actual, limit, unit = 'bytes') {
  if (!Number.isFinite(actual)) {
    throw new Error(`${label} is missing or is not a finite number`);
  }
  if (actual > limit) {
    throw new Error(`${label} is ${actual} ${unit}; budget is ${limit} ${unit}`);
  }
}

export function parseNpmPackOutput(output) {
  for (let start = output.indexOf('['); start !== -1; start = output.indexOf('[', start + 1)) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Skip prepare-hook banners and keep looking for npm's JSON array.
    }
  }
  throw new Error('npm pack did not return a valid JSON array');
}

export function readBudget(repoRoot) {
  const budget = JSON.parse(readFileSync(path.join(repoRoot, BUDGET_FILE), 'utf8'));
  for (const [name, entry] of Object.entries(budget.packages ?? {})) {
    for (const metric of CEILING_METRICS) {
      if (!Number.isFinite(entry.ceiling?.[metric]))
        throw new Error(`${BUDGET_FILE}: ${name} has no ceiling.${metric}`);
    }
    for (const metric of GROWTH_METRICS) {
      if (!Number.isFinite(entry.perPullRequest?.[metric])) {
        throw new Error(`${BUDGET_FILE}: ${name} has no perPullRequest.${metric}`);
      }
    }
  }
  if (!budget.packages?.[SDK_PACKAGE]) throw new Error(`${BUDGET_FILE} has no ${SDK_PACKAGE} entry`);
  return budget;
}

/** The size metrics of one `npm pack --json` entry. */
export function measurePack(packageInfo) {
  for (const field of ['size', 'unpackedSize', 'entryCount']) {
    if (!Number.isFinite(packageInfo?.[field])) {
      throw new Error(`npm pack returned an invalid ${field}`);
    }
  }
  return { packedBytes: packageInfo.size, unpackedBytes: packageInfo.unpackedSize, files: packageInfo.entryCount };
}

const METRIC_LABELS = { packedBytes: 'packed bytes', unpackedBytes: 'unpacked bytes', files: 'files' };

/** Ceiling failures, plus warnings when fewer than two PRs' worth of headroom is left. */
export function checkCeilings(name, measured, entry) {
  const failures = [];
  const warnings = [];
  for (const metric of CEILING_METRICS) {
    const limit = entry.ceiling[metric];
    if (measured[metric] > limit) {
      failures.push(
        `${name} ${METRIC_LABELS[metric]}: ${formatCount(measured[metric])} is over the ceiling of ` +
          `${formatCount(limit)}. Trim the package, or raise the ceiling in ${BUDGET_FILE} and explain why in the PR.`
      );
      continue;
    }
    const allowance = entry.perPullRequest[metric];
    if (allowance !== undefined && limit - measured[metric] < 2 * allowance) {
      warnings.push(
        `${name} ${METRIC_LABELS[metric]}: ${formatCount(limit - measured[metric])} of headroom left under the ` +
          `${formatCount(limit)} ceiling, less than two PRs' allowance. Trim or raise the ceiling soon so ` +
          'parallel PRs do not collide.'
      );
    }
  }
  return { failures, warnings };
}

/**
 * Compare a measurement with the one recorded for the merge base. Growth past
 * the per-PR allowance fails unless this change raised the matching ceiling.
 */
export function compareWithBaseline(current, baseline, budget) {
  const failures = [];
  const notes = [];
  const rows = [];
  for (const [name, entry] of Object.entries(budget.packages)) {
    const now = current.packages[name];
    const before = baseline.packages?.[name];
    if (!now) continue;
    if (!before) {
      notes.push(`${name}: the merge base has no measurement, so per-PR growth is not checked.`);
      continue;
    }
    for (const metric of CEILING_METRICS) {
      if (!Number.isFinite(before[metric])) continue;
      const delta = now[metric] - before[metric];
      const allowance = GROWTH_METRICS.includes(metric) ? entry.perPullRequest[metric] : undefined;
      rows.push({ name, metric, before: before[metric], now: now[metric], delta, allowance });
      if (allowance === undefined || delta <= allowance) continue;
      const previousCeiling = before.ceiling?.[metric];
      if (Number.isFinite(previousCeiling) && entry.ceiling[metric] > previousCeiling) {
        notes.push(
          `${name} grows by ${formatCount(delta)} ${METRIC_LABELS[metric]} (allowance ${formatCount(allowance)}); ` +
            `accepted because this change raises the ceiling from ${formatCount(previousCeiling)} to ` +
            `${formatCount(entry.ceiling[metric])}.`
        );
        continue;
      }
      failures.push(
        `${name} grows by ${formatCount(delta)} ${METRIC_LABELS[metric]} against the merge base; one PR may add ` +
          `${formatCount(allowance)}. Trim what does not need to ship, or, if the growth is intended, raise ` +
          `packages["${name}"].ceiling.${metric} in ${BUDGET_FILE} in this PR so the growth is reviewed.`
      );
    }
  }
  return { failures, notes, rows };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${formatCount(value)}`;
}

export function formatGrowthSummary(rows, baseCommit) {
  const lines = [
    `### Package size against the merge base${baseCommit ? ` (${baseCommit.slice(0, 12)})` : ''}`,
    '',
    '| Package | Metric | Merge base | This change | Delta | Per-PR allowance |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${METRIC_LABELS[row.metric]} | ${formatCount(row.before)} | ${formatCount(row.now)} | ` +
        `${signed(row.delta)} | ${row.allowance === undefined ? 'n/a' : formatCount(row.allowance)} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

function packDryRun(cwd) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const [packageInfo] = parseNpmPackOutput(output);
  if (!packageInfo || !Array.isArray(packageInfo.files)) {
    throw new Error('npm pack did not return package file metadata');
  }
  return packageInfo;
}

/** Structural invariants of the SDK tarball. These do not have headroom. */
function checkSdkContents(repoRoot, packageInfo) {
  const sourceMaps = packageInfo.files.filter(file => file.path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    throw new Error(`packed package contains ${sourceMaps.length} source map files`);
  }
  const skillSnapshots = packageInfo.files.filter(
    file => file.path.startsWith('skills/') && file.path.split('/').some(part => part.endsWith('.previous'))
  );
  if (skillSnapshots.length > 0) {
    throw new Error(`packed package contains ${skillSnapshots.length} schema-sync skill snapshot files`);
  }
  const rawBundledSchemas = packageInfo.files.filter(
    file => file.path.includes('/schemas-data/') && file.path.includes('/bundled/') && file.path.endsWith('.json')
  );
  if (rawBundledSchemas.length > 0) {
    throw new Error(`packed package contains ${rawBundledSchemas.length} expanded bundled schema files`);
  }
  // Upstream compliance bundles still carry `domains/`, the legacy name of
  // `protocols/`, as a byte-identical copy. The storyboard loader reads only
  // `protocols/`, so package.json excludes the copy.
  const complianceAliases = packageInfo.files.filter(file => /^compliance\/cache\/[^/]+\/domains\//.test(file.path));
  if (complianceAliases.length > 0) {
    throw new Error(
      `packed package contains ${complianceAliases.length} files under the legacy compliance domains/ alias ` +
        '(it duplicates protocols/)'
    );
  }
  const complianceRoots = new Set(
    packageInfo.files.map(file => /^compliance\/cache\/([^/]+)\//.exec(file.path)?.[1]).filter(Boolean)
  );
  for (const root of complianceRoots) {
    if (!packageInfo.files.some(file => file.path.startsWith(`compliance/cache/${root}/protocols/`))) {
      throw new Error(`packed compliance bundle ${root} has no protocols/ storyboards`);
    }
  }
  const bundledSchemaBytes = packageInfo.files
    .filter(file => file.path.endsWith('/bundled.schemas.br'))
    .reduce((sum, file) => sum + file.size, 0);
  assertAtMost('bundled schema data', bundledSchemaBytes, MAX_BUNDLED_SCHEMA_BYTES);
  const currentProtocolVersion = readFileSync(path.join(repoRoot, 'ADCP_VERSION'), 'utf8').trim();
  const currentBundleKey = currentProtocolVersion.includes('-')
    ? currentProtocolVersion
    : currentProtocolVersion.split('.').slice(0, 2).join('.');
  const expectedBundleKeys = new Set(['3.0', '3.1', currentBundleKey]);
  const packed = new Map(packageInfo.files.map(file => [file.path, file]));
  for (const bundleKey of expectedBundleKeys) {
    const expectedArchivePath = `dist/lib/schemas-data/${bundleKey}/bundled.schemas.br`;
    if (!packed.has(expectedArchivePath)) {
      throw new Error(`packed package is missing a required bundled schema archive: ${expectedArchivePath}`);
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const versionSource = readFileSync(path.join(repoRoot, 'src', 'lib', 'version.ts'), 'utf8');
  const compatibleBlock = /export const COMPATIBLE_ADCP_VERSIONS = \[([\s\S]*?)\] as const;/.exec(versionSource)?.[1];
  if (compatibleBlock === undefined) {
    throw new Error('could not read COMPATIBLE_ADCP_VERSIONS from src/lib/version.ts');
  }
  const compatibleVersions = [...compatibleBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assertPublishProtocolArtifacts({ packageInfo, manifest, currentProtocolVersion, compatibleVersions });

  const cjsSchema = packed.get('dist/lib/types/schemas.generated.d.ts');
  if (!cjsSchema) throw new Error('packed package is missing schemas.generated.d.ts');
  if (!Number.isFinite(cjsSchema.size)) {
    throw new Error('npm pack returned an invalid size for schemas.generated.d.ts');
  }
  if (cjsSchema.size > MAX_CJS_SCHEMA_DECLARATION_BYTES) {
    throw new Error(
      `schemas.generated.d.ts is ${mib(cjsSchema.size)} MiB; ` +
        `budget is ${mib(MAX_CJS_SCHEMA_DECLARATION_BYTES)} MiB`
    );
  }
  for (const stem of ESM_FACADE_DECLARATIONS) {
    const name = path.basename(stem);
    const esm = packed.get(`${stem}.d.mts`);
    if (!packed.has(`${stem}.d.ts`)) throw new Error(`packed package is missing ${name}.d.ts`);
    if (!esm) throw new Error(`packed package is missing ${name}.d.mts`);
    assertAtMost(`${name}.d.mts`, esm.size, MAX_ESM_FACADE_BYTES);
    if (readFileSync(path.join(repoRoot, `${stem}.d.mts`), 'utf8') !== `export * from './${name}.js';\n`) {
      throw new Error(`${name}.d.mts is not the expected one-line ESM facade`);
    }
  }
  return { bundledSchemaBytes, cjsSchemaBytes: cjsSchema.size };
}

/**
 * Pack the SDK, enforce its ceilings and structural checks, and return the
 * `npm pack` metadata. `verify-package.mjs` calls this before its clean-room
 * install.
 */
export function checkPackageSize(repoRoot) {
  const budget = readBudget(repoRoot);
  const packageInfo = packDryRun(repoRoot);
  const measured = measurePack(packageInfo);
  const { failures, warnings } = checkCeilings(SDK_PACKAGE, measured, budget.packages[SDK_PACKAGE]);
  if (failures.length > 0) throw new Error(failures.join('\n'));
  for (const warning of warnings) annotate('warning', warning);
  const { bundledSchemaBytes, cjsSchemaBytes } = checkSdkContents(repoRoot, packageInfo);
  console.log(
    `✅ Package size: ${formatCount(measured.packedBytes)} bytes packed (${mib(measured.packedBytes)} MiB), ` +
      `${mib(measured.unpackedBytes)} MiB unpacked, ${formatCount(measured.files)} files; ` +
      `bundled schemas ${mib(bundledSchemaBytes)} MiB; schema declarations ${mib(cjsSchemaBytes)} MiB CJS`
  );
  return packageInfo;
}

function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}::${message}`);
  else console.log(`${level === 'warning' ? '⚠️ ' : 'ℹ️ '} ${message}`);
}

function argValue(flag, envName) {
  const index = process.argv.indexOf(flag);
  if (index !== -1) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a file path`);
    return value;
  }
  return process.env[envName] || undefined;
}

function currentCommit(repoRoot) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function loadBaseline(file, expectedCommit) {
  if (!file || !existsSync(file)) {
    return { skip: file ? `no merge-base measurement at ${file}` : undefined };
  }
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  if (baseline.schema !== MEASUREMENT_SCHEMA) {
    return { skip: `merge-base measurement uses schema ${baseline.schema}, expected ${MEASUREMENT_SCHEMA}` };
  }
  if (expectedCommit && baseline.commit !== expectedCommit) {
    return { skip: `merge-base measurement describes ${baseline.commit}, not ${expectedCommit}` };
  }
  return { baseline };
}

async function main(repoRoot) {
  const budget = readBudget(repoRoot);
  const failures = [];
  const measurement = { schema: MEASUREMENT_SCHEMA, commit: currentCommit(repoRoot), packages: {} };

  const sdkInfo = checkPackageSize(repoRoot);
  measurement.packages[SDK_PACKAGE] = { ...measurePack(sdkInfo), ceiling: budget.packages[SDK_PACKAGE].ceiling };

  const storage = await import('../packages/reporting-storage/scripts/check-package.mjs');
  const storageEntry = budget.packages[storage.PACKAGE_NAME];
  if (storageEntry) {
    const storageMeasured = measurePack(storage.packReportingStorage());
    const result = checkCeilings(storage.PACKAGE_NAME, storageMeasured, storageEntry);
    failures.push(...result.failures);
    for (const warning of result.warnings) annotate('warning', warning);
    measurement.packages[storage.PACKAGE_NAME] = { ...storageMeasured, ceiling: storageEntry.ceiling };
    if (result.failures.length === 0) {
      console.log(
        `✅ ${storage.PACKAGE_NAME}: ${formatCount(storageMeasured.packedBytes)} bytes packed, ` +
          `${formatCount(storageMeasured.unpackedBytes)} unpacked, ${storageMeasured.files} files`
      );
    }
  }

  const reportFile = argValue('--report', 'PACKAGE_SIZE_REPORT');
  if (reportFile) {
    mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify(measurement, null, 2)}\n`);
  }

  const baseCommit = process.env.PACKAGE_SIZE_BASE_SHA || undefined;
  const { baseline, skip } = loadBaseline(argValue('--baseline', 'PACKAGE_SIZE_BASELINE'), baseCommit);
  if (skip) {
    annotate('notice', `Per-PR package growth not checked: ${skip}. The ceilings still apply.`);
  } else if (baseline) {
    const growth = compareWithBaseline(measurement, baseline, budget);
    failures.push(...growth.failures);
    for (const note of growth.notes) annotate('notice', note);
    const summary = formatGrowthSummary(growth.rows, baseline.commit);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  if (failures.length > 0) throw new Error(failures.join('\n'));
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  main(repoRoot).catch(error => {
    console.error(`❌ Package size check failed: ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
