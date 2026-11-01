#!/usr/bin/env node
/**
 * Offline checks for the `@adcp/reporting-storage` tarball. Requires a prior `npm run build`.
 *
 *   node scripts/check-package.mjs          export map, packed contents and budgets
 *   node scripts/check-package.mjs --size   the size ceilings only (the root `check:package-size` checks them too)
 *
 * The package is built like the SDK (one transpiled module per source module, CommonJS and ESM with both
 * declaration flavours), so the checks mirror the SDK's: every export target is packed, nothing from `src/`,
 * `test/` or a source map ships, and the size stays inside a budget so growth is a decision.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The one example that ships: the integrated production-service walkthrough the guides link to.
const PUBLISHED_EXAMPLE = 'examples/reliable-reporting-service/README.md';

// Size ceilings and the per-PR growth allowance live with the SDK's in the repository's
// scripts/package-size-budget.json, so the root `check:package-size` compares both packages with their merge
// base in one place. A new module adds four files (two runtime formats, two declaration flavours).
const BUDGET_FILE = path.resolve(packageRoot, '..', '..', 'scripts', 'package-size-budget.json');
export const PACKAGE_NAME = '@adcp/reporting-storage';

function ceiling() {
  return JSON.parse(readFileSync(BUDGET_FILE, 'utf8')).packages[PACKAGE_NAME].ceiling;
}

export function packReportingStorage() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
  for (let start = output.indexOf('['); start !== -1; start = output.indexOf('[', start + 1)) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed) && parsed[0]?.files) return parsed[0];
    } catch {
      // Keep scanning past banners that contain a bracket.
    }
  }
  throw new Error('npm pack did not return package metadata');
}

export function checkReportingStorageBudgets(info) {
  const limit = ceiling();
  const problems = [];
  if (info.size > limit.packedBytes)
    problems.push(`packed tarball is ${info.size} bytes; ceiling is ${limit.packedBytes}`);
  if (info.unpackedSize > limit.unpackedBytes) {
    problems.push(`unpacked package is ${info.unpackedSize} bytes; ceiling is ${limit.unpackedBytes}`);
  }
  if (info.entryCount > limit.files) problems.push(`package has ${info.entryCount} files; ceiling is ${limit.files}`);
  return problems;
}

function checkContents(info) {
  const problems = [];
  const packed = new Set(info.files.map(file => file.path));
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (typeof conditions === 'string') continue;
    for (const [format, targets] of Object.entries(conditions)) {
      for (const [kind, target] of Object.entries(targets)) {
        if (!packed.has(target.replace(/^\.\//, ''))) {
          problems.push(`export ${subpath} (${format}.${kind}) points at ${target}, which is not packed`);
        }
      }
    }
  }
  for (const [subpath, targets] of Object.entries(manifest.typesVersions['*'])) {
    for (const target of targets) {
      if (!packed.has(target)) problems.push(`typesVersions ${subpath} points at ${target}, which is not packed`);
    }
  }
  for (const file of packed) {
    if (file.endsWith('.map')) problems.push(`${file} is a source map`);
    if (/^(src|test|scripts)\//.test(file) || (/^examples\//.test(file) && file !== PUBLISHED_EXAMPLE)) {
      problems.push(`${file} must not be published`);
    }
  }
  // Declaration emit can inline an inferred type as a relative path into the SDK's build output
  // (`import("../../../../dist/lib/...")`), which resolves in this workspace and nowhere else. Public types must be
  // named explicitly, so every `@adcp/sdk` reference in a declaration is a package specifier.
  for (const file of packed) {
    if (!/\.d\.m?ts$/.test(file)) continue;
    const text = readFileSync(path.join(packageRoot, file), 'utf8');
    if (/["'](?:\.\.\/)+dist\/lib\//.test(text))
      problems.push(`${file} imports the SDK's build output by relative path`);
  }
  return problems;
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  try {
    const info = packReportingStorage();
    const problems = [
      ...checkReportingStorageBudgets(info),
      ...(process.argv.includes('--size') ? [] : checkContents(info)),
    ];
    if (problems.length > 0) {
      for (const problem of problems) console.error(`  - ${problem}`);
      throw new Error(`${problems.length} package problem(s)`);
    }
    console.log(
      `✅ ${PACKAGE_NAME}: ${info.size} bytes packed, ${info.unpackedSize} unpacked, ${info.entryCount} files`
    );
  } catch (error) {
    console.error(`❌ ${PACKAGE_NAME} package check failed: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
