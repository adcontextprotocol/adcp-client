#!/usr/bin/env node
/**
 * Fast, offline publish-size audit.
 *
 * Requires a prior `npm run build:lib`. Unlike the full clean-room package
 * smoke, this runs on every library build so any packaged source or generated
 * artifact can trip the budgets.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The signed 3.2.0-beta.6 bundle adds two substantial canonical format
// schemas and expands the reporting/tool projections. Keep the budgets tight
// to the resulting artifact (about 48 MiB packed, 337 MiB unpacked, 7,811
// files) while allowing normal compressor variance across supported Node/npm
// versions.
const MAX_PACKED_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_PACKAGE_BYTES = 340 * 1024 * 1024;
const MAX_PACKED_FILE_COUNT = 7_900;
const MAX_CJS_SCHEMA_DECLARATION_BYTES = 45 * 1024 * 1024;
const MAX_ESM_SCHEMA_FACADE_BYTES = 1024;
const EXPECTED_ESM_SCHEMA_FACADE = "export * from './schemas.generated.js';\n";

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
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
  // npm 10 can print prepare-hook output (including ANSI color sequences)
  // before --json output even with --ignore-scripts. Try each array opener in
  // order and accept only a complete top-level JSON array.
  for (let start = output.indexOf('['); start !== -1; start = output.indexOf('[', start + 1)) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Keep scanning past banners such as ESC[32m or non-JSON hook output.
    }
  }
  throw new Error('npm pack did not return a valid JSON array');
}

export function checkPackageSize(repoRoot) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    // npm includes one metadata entry per packed file in its JSON response.
    // Keep this above the package's own file-count budget so the audit can
    // report a useful size failure instead of terminating with ENOBUFS.
    maxBuffer: 64 * 1024 * 1024,
  });
  const [packageInfo] = parseNpmPackOutput(output);
  if (!packageInfo || !Array.isArray(packageInfo.files)) {
    throw new Error('npm pack did not return package file metadata');
  }
  for (const field of ['size', 'unpackedSize', 'entryCount']) {
    if (!Number.isFinite(packageInfo[field])) {
      throw new Error(`npm pack returned an invalid ${field}`);
    }
  }

  if (packageInfo.size > MAX_PACKED_TARBALL_BYTES) {
    throw new Error(`packed tarball is ${mib(packageInfo.size)} MiB; budget is ${mib(MAX_PACKED_TARBALL_BYTES)} MiB`);
  }
  if (packageInfo.unpackedSize > MAX_UNPACKED_PACKAGE_BYTES) {
    throw new Error(
      `unpacked package is ${mib(packageInfo.unpackedSize)} MiB; budget is ${mib(MAX_UNPACKED_PACKAGE_BYTES)} MiB`
    );
  }
  assertAtMost('packed file count', packageInfo.entryCount, MAX_PACKED_FILE_COUNT, 'files');

  const cjsSchema = packageInfo.files.find(file => file.path === 'dist/lib/types/schemas.generated.d.ts');
  const esmSchema = packageInfo.files.find(file => file.path === 'dist/lib/types/schemas.generated.d.mts');
  if (!cjsSchema) throw new Error('packed package is missing schemas.generated.d.ts');
  if (!esmSchema) throw new Error('packed package is missing schemas.generated.d.mts');
  if (!Number.isFinite(cjsSchema.size)) {
    throw new Error('npm pack returned an invalid size for schemas.generated.d.ts');
  }
  if (cjsSchema.size > MAX_CJS_SCHEMA_DECLARATION_BYTES) {
    throw new Error(
      `schemas.generated.d.ts is ${mib(cjsSchema.size)} MiB; ` +
        `budget is ${mib(MAX_CJS_SCHEMA_DECLARATION_BYTES)} MiB`
    );
  }
  assertAtMost('schemas.generated.d.mts', esmSchema.size, MAX_ESM_SCHEMA_FACADE_BYTES);

  const facadePath = path.join(repoRoot, 'dist', 'lib', 'types', 'schemas.generated.d.mts');
  if (readFileSync(facadePath, 'utf8') !== EXPECTED_ESM_SCHEMA_FACADE) {
    throw new Error('schemas.generated.d.mts is not the expected exact ESM facade');
  }

  console.log(
    `✅ Package size: ${mib(packageInfo.size)} MiB packed, ${mib(packageInfo.unpackedSize)} MiB unpacked, ` +
      `${packageInfo.entryCount} files; schema declarations ${mib(cjsSchema.size)} MiB CJS + ${esmSchema.size} B ESM`
  );
  return packageInfo;
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    checkPackageSize(repoRoot);
  } catch (error) {
    console.error(`❌ Package size check failed: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
