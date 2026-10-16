#!/usr/bin/env node
/**
 * Offline checks for the `@adcp/reporting-storage` tarball. Requires a prior `npm run build`.
 *
 *   node scripts/check-package.mjs          export map, packed contents and budgets
 *   node scripts/check-package.mjs --size   the budgets only (the root `check:package-size` runs this)
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

// Measured at 0.0.0: about 408,000 packed bytes, 1,883,000 unpacked, 115 files (28 modules x 4 flavours, the
// manifest, the README and the example). A new module adds four files. Raise a budget deliberately, in the
// change that grows the package.
const MAX_PACKED_BYTES = 450_000;
const MAX_UNPACKED_BYTES = 2_200_000;
const MAX_FILE_COUNT = 125;

function pack() {
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

function checkBudgets(info) {
  const problems = [];
  if (info.size > MAX_PACKED_BYTES) problems.push(`packed tarball is ${info.size} bytes; budget is ${MAX_PACKED_BYTES}`);
  if (info.unpackedSize > MAX_UNPACKED_BYTES) {
    problems.push(`unpacked package is ${info.unpackedSize} bytes; budget is ${MAX_UNPACKED_BYTES}`);
  }
  if (info.entryCount > MAX_FILE_COUNT) problems.push(`package has ${info.entryCount} files; budget is ${MAX_FILE_COUNT}`);
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
  return problems;
}

try {
  const info = pack();
  const problems = [...checkBudgets(info), ...(process.argv.includes('--size') ? [] : checkContents(info))];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    throw new Error(`${problems.length} package problem(s)`);
  }
  console.log(
    `✅ @adcp/reporting-storage: ${info.size} bytes packed, ${info.unpackedSize} unpacked, ${info.entryCount} files`
  );
} catch (error) {
  console.error(`❌ @adcp/reporting-storage package check failed: ${error.message ?? error}`);
  process.exitCode = 1;
}
