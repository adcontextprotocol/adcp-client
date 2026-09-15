#!/usr/bin/env node
/**
 * Fail closed when a publish artifact contains a superseded protocol preview.
 *
 * Historical SDK release notes may mention beta versions. This checker only
 * examines protocol schema/compliance roots, versioned type side-bundles, the
 * export map, and the SDK's advertised compatibility list.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIEW_VERSION = /^\d+\.\d+(?:\.\d+)?-(?:alpha|beta|rc)(?:\.[0-9A-Za-z.-]+)?$/;
const PREVIEW_TYPE_BUNDLE = /^v\d+(?:-\d+)*-(?:alpha|beta|rc)(?:-|$)/;
const MAINTAINED_COMPLIANCE_ROOTS = ['3.0.25', '3.1.18'];

function currentBundleKey(version) {
  return version.includes('-') ? version : version.split('.').slice(0, 2).join('.');
}

function currentPreviewAliases(version) {
  if (!PREVIEW_VERSION.test(version)) return new Set();
  const match = /^(\d+)\.(\d+)\.\d+-(.+)$/.exec(version);
  return new Set(match ? [version, `${match[1]}.${match[2]}-${match[3]}`] : [version]);
}

export function assertPublishProtocolArtifacts({ packageInfo, manifest, currentProtocolVersion, compatibleVersions }) {
  if (!packageInfo || !Array.isArray(packageInfo.files)) {
    throw new Error('npm pack did not return package file metadata');
  }

  const allowedSchemaRoots = new Set(['v2.5', '3.0', '3.1', currentBundleKey(currentProtocolVersion)]);
  const violations = [];
  const schemaRoots = new Set();
  const complianceRoots = new Set();

  for (const file of packageInfo.files) {
    const schemaRoot = /^dist\/lib\/schemas-data\/([^/]+)\//.exec(file.path)?.[1];
    if (schemaRoot) schemaRoots.add(schemaRoot);
    if (schemaRoot && !allowedSchemaRoots.has(schemaRoot)) {
      violations.push(`${file.path} (unsupported schema bundle ${schemaRoot})`);
    }

    const complianceRoot = /^compliance\/cache\/([^/]+)\//.exec(file.path)?.[1];
    if (complianceRoot) complianceRoots.add(complianceRoot);
    if (
      complianceRoot &&
      complianceRoot !== currentProtocolVersion &&
      !MAINTAINED_COMPLIANCE_ROOTS.includes(complianceRoot)
    ) {
      violations.push(`${file.path} (unsupported compliance bundle ${complianceRoot})`);
    }

    const typeRoot = /^dist\/lib\/types\/([^/]+)\//.exec(file.path)?.[1];
    if (typeRoot && PREVIEW_TYPE_BUNDLE.test(typeRoot)) {
      violations.push(`${file.path} (versioned preview type bundle ${typeRoot})`);
    }
  }

  for (const requiredRoot of allowedSchemaRoots) {
    if (!schemaRoots.has(requiredRoot)) {
      violations.push(`${requiredRoot} (required schema bundle is missing)`);
    }
  }

  for (const requiredRoot of [...MAINTAINED_COMPLIANCE_ROOTS, currentProtocolVersion]) {
    if (!complianceRoots.has(requiredRoot)) {
      violations.push(`${requiredRoot} (required compliance bundle is missing)`);
    }
  }

  const packageEntryPoints = [
    ...Object.keys(manifest.exports ?? {}),
    ...Object.keys(manifest.typesVersions?.['*'] ?? {}),
  ];
  for (const entryPoint of packageEntryPoints) {
    if (entryPoint.split('/').some(segment => PREVIEW_TYPE_BUNDLE.test(segment))) {
      violations.push(`${entryPoint} (versioned preview package entry point)`);
    }
  }

  const allowedPreviews = currentPreviewAliases(currentProtocolVersion);
  for (const version of compatibleVersions ?? []) {
    if (PREVIEW_VERSION.test(version) && !allowedPreviews.has(version)) {
      violations.push(`${version} (superseded advertised protocol preview)`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`publish artifact contains unsupported protocol previews:\n- ${violations.join('\n- ')}`);
  }
}

function parseNpmPackOutput(output) {
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

export function checkPublishProtocolArtifacts(repoRoot) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const [packageInfo] = parseNpmPackOutput(output);
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const currentProtocolVersion = readFileSync(path.join(repoRoot, 'ADCP_VERSION'), 'utf8').trim();
  const require = createRequire(import.meta.url);
  const versionModulePath = path.join(repoRoot, 'dist', 'lib', 'version.js');
  delete require.cache[require.resolve(versionModulePath)];
  const { COMPATIBLE_ADCP_VERSIONS } = require(versionModulePath);

  assertPublishProtocolArtifacts({
    packageInfo,
    manifest,
    currentProtocolVersion,
    compatibleVersions: COMPATIBLE_ADCP_VERSIONS,
  });
  console.log(`✅ Published protocol artifacts are limited to ${currentProtocolVersion} and stable legacy bundles.`);
  return packageInfo;
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    checkPublishProtocolArtifacts(repoRoot);
  } catch (error) {
    console.error(`❌ Protocol artifact check failed: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
