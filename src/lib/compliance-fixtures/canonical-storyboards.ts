import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { markStoryboardComplianceRoot } from '../testing/storyboard/provenance';
import type { Storyboard } from '../testing/storyboard/types';

export interface CanonicalStoryboardFileProvenance {
  readonly source_path: string;
  readonly package_path: string;
  readonly git_blob_sha1: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface CanonicalStoryboardFixtureProvenance {
  readonly schema_version: 1;
  readonly protocol_version: string;
  readonly source_repository: string;
  readonly source_tag: string;
  readonly source_commit: string;
  readonly bundle_sha256: string;
  readonly files: Readonly<{
    principal: CanonicalStoryboardFileProvenance;
    reporting_core: CanonicalStoryboardFileProvenance;
  }>;
}

export interface CanonicalStoryboardFixture {
  /** Exact UTF-8 source bytes decoded as text, without normalization. */
  readonly yaml: string;
  /** Runner-ready parse of {@link yaml}. */
  readonly storyboard: Storyboard;
  /** Immutable source identity and byte digest for this fixture. */
  readonly provenance: CanonicalStoryboardFileProvenance;
}

const fixtureDirectory = __dirname;
const provenancePath = path.join(fixtureDirectory, 'canonical-storyboards-provenance.json');
const canonicalPackagePaths = {
  principal: 'principal.yaml',
  reporting_core: 'reporting-core.yaml',
} as const;
let fixtureProvenance: CanonicalStoryboardFixtureProvenance | undefined;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Load the deeply immutable provenance shared by the canonical storyboard fixtures. */
export function loadCanonicalStoryboardFixtureProvenance(): CanonicalStoryboardFixtureProvenance {
  fixtureProvenance ??= deepFreeze(
    JSON.parse(readFileSync(provenancePath, 'utf8')) as CanonicalStoryboardFixtureProvenance
  );
  return fixtureProvenance;
}

function parseRunnerReadyStoryboard(yaml: string, protocolVersion: string): Storyboard {
  // Keep the existing compliance-fixtures entrypoint lightweight. These
  // runner dependencies and the packaged compliance cache are needed only
  // when a consumer explicitly loads one of the storyboards.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseStoryboard } = require('../testing/storyboard/loader') as typeof import('../testing/storyboard/loader');
  const { getComplianceCacheDir } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../testing/storyboard/compliance') as typeof import('../testing/storyboard/compliance');
  const storyboard = parseStoryboard(yaml);
  const complianceDirectory = getComplianceCacheDir({ version: protocolVersion });
  return markStoryboardComplianceRoot(
    {
      ...storyboard,
      adcp_version: protocolVersion,
      compliance_dir: complianceDirectory,
    },
    complianceDirectory
  );
}

function loadCanonicalStoryboard(
  fixtureName: keyof CanonicalStoryboardFixtureProvenance['files']
): CanonicalStoryboardFixture {
  const fixtureSetProvenance = loadCanonicalStoryboardFixtureProvenance();
  const provenance = fixtureSetProvenance.files[fixtureName];
  const packagePath = canonicalPackagePaths[fixtureName];
  if (provenance.package_path !== packagePath) {
    throw new Error(`Canonical compliance storyboard ${fixtureName} has an invalid packaged path.`);
  }
  const bytes = readFileSync(path.join(fixtureDirectory, packagePath));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const blobDigest = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

  if (
    bytes.byteLength !== provenance.size_bytes ||
    digest !== provenance.sha256 ||
    blobDigest !== provenance.git_blob_sha1
  ) {
    throw new Error(
      `Canonical compliance storyboard ${fixtureName} failed its packaged-byte provenance check: ` +
        `expected ${provenance.size_bytes} bytes / sha256:${provenance.sha256} / blob:${provenance.git_blob_sha1}, ` +
        `received ${bytes.byteLength} bytes / sha256:${digest} / blob:${blobDigest}. ` +
        `Reinstall @adcp/sdk or regenerate the fixtures.`
    );
  }

  const yaml = bytes.toString('utf8');
  return Object.freeze({
    yaml,
    storyboard: parseRunnerReadyStoryboard(yaml, fixtureSetProvenance.protocol_version),
    provenance,
  });
}

/** Load the exact AdCP 3.2.0-rc.3 `universal/principal` storyboard. */
export function loadCanonicalPrincipalStoryboard(): CanonicalStoryboardFixture {
  return loadCanonicalStoryboard('principal');
}

/** Load the exact AdCP 3.2.0-rc.3 `universal/reporting-core` storyboard. */
export function loadCanonicalReportingCoreStoryboard(): CanonicalStoryboardFixture {
  return loadCanonicalStoryboard('reporting_core');
}
