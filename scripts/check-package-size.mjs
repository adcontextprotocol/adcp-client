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
import { assertPublishProtocolArtifacts } from './check-publish-protocol-artifacts.mjs';

// Compact local-ref schema bundles and omission of source maps bring the
// package below pnpm's default fetch-timeout boundary on moderate links. Keep
// enough compressor variance for supported Node/npm versions without allowing
// the old 48 MB artifact shape to return. The packed limit is decimal because
// npm reports published package size in MB and issue #2579 set a 20 MB target.
const MAX_PACKED_TARBALL_BYTES = 20_000_000;
const MAX_UNPACKED_PACKAGE_BYTES = 120 * 1024 * 1024;
// AdCP 3.2.0-beta.10 adds the account-change schema family. The seller reporting
// ledger adds ten public module artifacts. AdCP 3.2.0-rc.2 replaced the preview
// schemas with its generated task surface and current compliance artifacts;
// superseded rc.1 fixtures are excluded from the published package. Its
// sync_reporting_status tool slice adds four publishable runtime/declaration artifacts.
// Its adapter-safe identity helpers add four module artifacts, and the portable
// cross-SDK consumer-status vector adds one published JSON artifact.
// Account-feed adoption adds five runtime/declaration module sets (20 files)
// and one migration guide. Byte budgets remain unchanged.
// The standalone proposal verifier adds twelve helper module artifacts and
// one buyer guide; byte budgets remain unchanged.
// AdCP 3.2.0-rc.3 publishes sixteen new source schemas — the scoped and
// media-buy frequency-cap families plus `core/media-buy-available-action-id.json`
// and the shared frequency-cap duration/control/mutable-field enums — and two
// new compliance storyboards. With their bundled and compact-projection copies
// that is +26 published files. The request-only Targeting Input helpers add one
// module (CJS + ESM + both declaration flavours), for +4 more.
// The 14.x adoption pass adds an existing-platform guide, a release worksheet,
// and a compile-gated thin integration example; byte budgets remain unchanged.
// The targeting-input migration follow-up adds one compile-gated provider
// adapter example; byte budgets remain unchanged.
// Canonical principal/reporting-core distribution adds two YAML files, one
// provenance manifest, and one dual-format module/declaration set (+7 files).
// The rc.3 buyer-side consumer-status loop adds one module,
// `reporting/content-mismatch` (CJS + ESM + both declaration flavours), for +4.
// Its reconciliation changes are edits to existing modules, and the unpacked
// total is unchanged against the 120 MiB ceiling.
// Unified action assessment adds nine module sets (36 artifacts) and one guide.
// Superseded preview compliance and historical compatibility test schemas are
// not published. Retiring the v3.1 beta type bundle removes eight artifacts;
// its current legacy-view wholesale type replacement adds four, for 6,107
// published files. Byte budgets stay fixed.
// Reliable Reporting Core adds three module sets (CJS + ESM + both declaration
// flavours) and one packaged setup guide, bringing the clean package to 6,120
// published files. Byte budgets stay fixed.
// Transactional reporting notification activity adds one module set (CJS + ESM
// + both declaration flavours), for 6,124 published files. Managed Delivery and
// Reconciled Billing add two public dual-format runtime/declaration module sets
// — `reporting/ledger/managed` and `reporting/ledger/managed-postgres`, each CJS
// + ESM + both declaration flavours — for +8 files and 6,132 total.
// The durable buyer-writes adoption example adds two TypeScript files and one
// packaged guide, bringing the clean package to 6,135 published files. The
// remaining changes edit existing modules; byte budgets stay fixed.
// Supply-path verification adds 32 runtime/declaration artifacts and its guide
// and packaged example (34 files total); byte and schema budgets stay unchanged.
// Native A2A compliance routing adds one internal dual-format module with both
// declaration flavours (+4 files); byte and schema budgets stay unchanged.
// AdCP 3.2.0-rc.4 adds frequency-cap storyboards, error-recovery/reporting-summary/
// supply-path vectors, verification-token claims, and their packaged skill copies.
// After compact-schema packaging and existing filters, the publish set grows by 10 files.
// Official-client A2A request-signing dispatch adds one internal dual-format
// module with both declaration flavours (+4 files).
// Targeting-overlay conformance adds one public dual-format runtime/declaration
// module set (+4 files); byte and schema budgets stay unchanged.
const MAX_PACKED_FILE_COUNT = 6_135 + 34 + 4 + 10 + 4 + 4;
const MAX_BUNDLED_SCHEMA_BYTES = 1280 * 1024;
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

  const sourceMaps = packageInfo.files.filter(file => file.path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    throw new Error(`packed package contains ${sourceMaps.length} source map files`);
  }
  const rawBundledSchemas = packageInfo.files.filter(
    file => file.path.includes('/schemas-data/') && file.path.includes('/bundled/') && file.path.endsWith('.json')
  );
  if (rawBundledSchemas.length > 0) {
    throw new Error(`packed package contains ${rawBundledSchemas.length} expanded bundled schema files`);
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
  const packedPaths = new Set(packageInfo.files.map(file => file.path));
  for (const bundleKey of expectedBundleKeys) {
    const expectedArchivePath = `dist/lib/schemas-data/${bundleKey}/bundled.schemas.br`;
    if (!packedPaths.has(expectedArchivePath)) {
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
      `${packageInfo.entryCount} files; bundled schemas ${mib(bundledSchemaBytes)} MiB; ` +
      `schema declarations ${mib(cjsSchema.size)} MiB CJS + ${esmSchema.size} B ESM`
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
