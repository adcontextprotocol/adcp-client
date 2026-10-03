#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface FixtureFile {
  source_path: string;
  package_path: string;
  git_blob_sha1: string;
  sha256: string;
  size_bytes: number;
}

interface FixtureProvenance {
  schema_version: 1;
  protocol_version: string;
  source_repository: string;
  source_tag: string;
  source_commit: string;
  bundle_sha256: string;
  files: Record<string, FixtureFile>;
}

const repoRoot = path.resolve(__dirname, '..');
const sourceDirectory = path.join(repoRoot, 'src', 'lib', 'compliance-fixtures');
const distDirectory = path.join(repoRoot, 'dist', 'lib', 'compliance-fixtures');
const provenanceFileName = 'canonical-storyboards-provenance.json';
const provenancePath = path.join(sourceDirectory, provenanceFileName);
const expectedFilePaths = {
  principal: {
    source_path: 'static/compliance/source/universal/principal.yaml',
    package_path: 'principal.yaml',
  },
  reporting_core: {
    source_path: 'static/compliance/source/universal/reporting-core.yaml',
    package_path: 'reporting-core.yaml',
  },
} as const;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha1(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function readProvenance(): FixtureProvenance {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as FixtureProvenance;
  if (provenance.schema_version !== 1) throw new Error('Fixture provenance schema_version must be 1.');
  if (provenance.source_tag !== `v${provenance.protocol_version}`) {
    throw new Error('Fixture provenance source_tag must match protocol_version.');
  }
  if (provenance.source_repository !== 'adcontextprotocol/adcp') {
    throw new Error('Fixture provenance source_repository must be adcontextprotocol/adcp.');
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.source_commit)) {
    throw new Error('Fixture provenance source_commit must be a full lowercase commit SHA.');
  }
  if (!/^[0-9a-f]{64}$/.test(provenance.bundle_sha256)) {
    throw new Error('Fixture provenance bundle_sha256 must be a lowercase SHA-256 digest.');
  }
  if (Object.keys(provenance.files).sort().join(',') !== 'principal,reporting_core') {
    throw new Error('Fixture provenance must contain exactly principal and reporting_core.');
  }
  for (const [name, expected] of Object.entries(expectedFilePaths)) {
    const file = provenance.files[name];
    if (file.source_path !== expected.source_path || file.package_path !== expected.package_path) {
      throw new Error(`Fixture provenance ${name} paths do not match the canonical distribution paths.`);
    }
    if (!/^[0-9a-f]{40}$/.test(file.git_blob_sha1) || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Fixture provenance ${name} digests must be full lowercase hashes.`);
    }
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes <= 0) {
      throw new Error(`Fixture provenance ${name} size_bytes must be a positive safe integer.`);
    }
  }
  return provenance;
}

function assertCanonicalBytes(name: string, file: FixtureFile, bytes: Buffer): void {
  const actualSha256 = sha256(bytes);
  const actualGitBlobSha1 = gitBlobSha1(bytes);
  if (
    bytes.byteLength !== file.size_bytes ||
    actualSha256 !== file.sha256 ||
    actualGitBlobSha1 !== file.git_blob_sha1
  ) {
    throw new Error(
      `[canonical-storyboard-fixtures] ${name} drifted from immutable provenance: ` +
        `expected ${file.size_bytes} bytes / sha256:${file.sha256} / blob:${file.git_blob_sha1}; ` +
        `received ${bytes.byteLength} bytes / sha256:${actualSha256} / blob:${actualGitBlobSha1}.`
    );
  }
}

function verifyVendoredFiles(provenance: FixtureProvenance): void {
  for (const [name, file] of Object.entries(provenance.files)) {
    assertCanonicalBytes(name, file, readFileSync(path.join(sourceDirectory, file.package_path)));
  }
}

async function downloadImmutableFiles(provenance: FixtureProvenance): Promise<Map<string, Buffer>> {
  const downloaded = new Map<string, Buffer>();
  for (const [name, file] of Object.entries(provenance.files)) {
    const url = new URL(
      `${provenance.source_commit}/${file.source_path}`,
      `https://raw.githubusercontent.com/${provenance.source_repository}/`
    );
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`[canonical-storyboard-fixtures] ${url} returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assertCanonicalBytes(name, file, bytes);
    downloaded.set(file.package_path, bytes);
  }
  return downloaded;
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const knownFlags = new Set(['--check', '--update', '--copy-dist']);
  for (const flag of flags) if (!knownFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
  if (flags.size !== 1) throw new Error('Pass exactly one of --check, --update, or --copy-dist.');

  const provenance = readProvenance();
  if (flags.has('--update')) {
    const downloaded = await downloadImmutableFiles(provenance);
    for (const [packagePath, bytes] of downloaded) {
      writeFileSync(path.join(sourceDirectory, packagePath), bytes);
    }
  }

  verifyVendoredFiles(provenance);

  if (flags.has('--copy-dist')) {
    mkdirSync(distDirectory, { recursive: true });
    copyFileSync(provenancePath, path.join(distDirectory, provenanceFileName));
    for (const file of Object.values(provenance.files)) {
      copyFileSync(path.join(sourceDirectory, file.package_path), path.join(distDirectory, file.package_path));
    }
  }

  console.log(
    `[canonical-storyboard-fixtures] ${flags.has('--copy-dist') ? 'verified and copied' : 'verified'} ` +
      `${Object.keys(provenance.files).length} fixtures from ${provenance.source_commit}`
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
