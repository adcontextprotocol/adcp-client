#!/usr/bin/env tsx

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

// Write file only if content differs (excluding generated timestamp)
function writeFileIfChanged(filePath: string, newContent: string): boolean {
  const contentWithoutTimestamp = (content: string) => {
    return content.replace(/generatedAt: '.*?'/, "generatedAt: '[TIMESTAMP]'");
  };

  let hasChanged = true;
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf8');
    const existingWithoutTimestamp = contentWithoutTimestamp(existingContent);
    const newWithoutTimestamp = contentWithoutTimestamp(newContent);

    if (existingWithoutTimestamp === newWithoutTimestamp) {
      hasChanged = false;
    }
  }

  if (hasChanged) {
    writeFileSync(filePath, newContent);
  }

  return hasChanged;
}

// Get target AdCP version from ADCP_VERSION file (source of truth)
function getTargetAdCPVersion(): string {
  try {
    const versionFilePath = path.join(__dirname, '../ADCP_VERSION');
    if (!existsSync(versionFilePath)) {
      throw new Error('ADCP_VERSION file not found. This file defines which AdCP version to use.');
    }
    const version = readFileSync(versionFilePath, 'utf8').trim();
    if (!version) {
      throw new Error('ADCP_VERSION file is empty');
    }
    return version;
  } catch (error) {
    console.error(`❌ Failed to read ADCP_VERSION file:`, error.message);
    process.exit(1);
  }
}

// Get current package.json version
function getCurrentPackageVersion(): { version: string; adcpVersion?: string } {
  try {
    const packagePath = path.join(__dirname, '../package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    return {
      version: packageJson.version,
      adcpVersion: packageJson.adcp_version,
    };
  } catch (error) {
    console.error(`❌ Failed to read package.json:`, error.message);
    process.exit(1);
  }
}

// Accept only the characters that appear in legitimate semver / AdCP
// version strings. Guards against a hostile ADCP_VERSION or package.json
// smuggling template-injection characters (quotes, backticks, newlines)
// into the generated TS file at build time.
const SAFE_VERSION = /^[0-9A-Za-z.\-+]+$/;

function assertSafeVersion(value: string, source: string): void {
  if (!SAFE_VERSION.test(value)) {
    console.error(`❌ ${source} contains unsafe characters: ${JSON.stringify(value)}`);
    process.exit(1);
  }
}

// Pre-3.0 / pre-stable version names. Kept as a separate constant so the
// 3.0.x patch enumeration below stays mechanical. Adding a future
// major/minor (3.1.x, 4.0.0-beta.1, etc.) requires updating this list AND
// the major/minor gate in `buildCompatibleVersions` — failing closed there
// is intentional, so a spec move forces a human to think about which
// historical versions stay in the compat surface.
//
// `3.1.0-beta.*` is opt-in: the SDK's primary pin stays at the current
// 3.0.x GA, but consumers can pin `adcpVersion: '3.1.0-beta.2'` (or
// '3.1-beta') to exercise the V2 mental model + catalog-sync cluster
// against beta sellers. Side-bundle synced via `npm run sync-schemas:3.1-beta`.
const COMPATIBLE_PREFIX = [
  'v2.5',
  'v2.6',
  'v3',
  '3.0.0-beta.1',
  '3.0.0-beta.3',
  '3.1.0-beta.1',
  '3.1.0-beta.2',
] as const;

/**
 * Build the `COMPATIBLE_ADCP_VERSIONS` list dynamically from the current
 * `ADCP_VERSION`. The bumper PR doesn't have to remember to append a new
 * version literal — the script enumerates `3.0.0..3.0.<patch>` automatically.
 *
 * Fails loudly when the version isn't in the `3.0.x` range so a 3.1.x or
 * 4.x bump can't silently inherit a stale enumeration: the human bumper has
 * to extend this script to define the new range. That's the right behavior —
 * a major/minor move likely also moves the compat surface in a non-mechanical
 * way (e.g. dropping older 3.0.x once 3.1 is stable).
 *
 * Background: adcontextprotocol/adcp-client schema URL pinning drift. The
 * 3.0.9 / 3.0.10 / 3.0.11 chore PRs all forgot to manually extend the
 * `COMPATIBLE_ADCP_VERSIONS` array literal that previously lived inline in
 * the template, so the compat surface capped at `3.0.8` across multiple
 * patch bumps. Auto-deriving eliminates that drift class.
 */
// Sanity bound on the patch enumeration. The AdCP spec patch cadence is
// roughly weekly; even at 10× speed we won't see 3.0.500 in the lifetime
// of the 3.0.x series. A defensive cap turns a hostile or fat-fingered
// `ADCP_VERSION = '3.0.999999999'` into a clean build failure instead of
// a silent ~10⁹-string OOM during enumeration.
const MAX_PATCH_ENUMERATION = 500;

/**
 * Last 3.0.x GA the SDK retains wire compat with when the primary pin
 * moves into 3.1.0-beta.x. Wire compat is free per spec (`error.code`
 * open enum, `recovery` fallback), so keeping the 3.0.x enumeration here
 * means an 8.0-beta SDK can still talk to a 3.0.12-pinned seller without
 * the version-negotiation layer flagging the peer as unsupported.
 *
 * Update this when 3.0 reaches EOL — at that point drop the 3.0.x
 * enumeration entirely.
 */
const LAST_3_0_GA_PATCH = 12;

function buildCompatibleVersions(adcpVersion: string): string[] {
  const semverMatch = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(adcpVersion);
  if (!semverMatch) {
    console.error(
      `❌ ADCP_VERSION ${JSON.stringify(adcpVersion)} does not match major.minor.patch[-prerelease] shape.`
    );
    process.exit(1);
  }
  const major = Number(semverMatch[1]);
  const minor = Number(semverMatch[2]);
  const patch = Number(semverMatch[3]);
  const prerelease = semverMatch[4];

  // 3.1.0-beta.x primary pin (current 8.0-beta line). Keep wire compat with
  // 3.0.x GA sellers — the wire is open-enum and a 3.1-pinned SDK that meets
  // a 3.0.12 seller MUST still parse the envelope. Enumerate 3.0.0..3.0.LAST_3_0_GA_PATCH
  // plus the prerelease lineage already declared in COMPATIBLE_PREFIX.
  if (major === 3 && minor === 1 && patch === 0 && prerelease?.startsWith('beta.')) {
    const range3_0_x: string[] = [];
    for (let p = 0; p <= LAST_3_0_GA_PATCH; p++) range3_0_x.push(`3.0.${p}`);
    // COMPATIBLE_PREFIX already contains every 3.1.0-beta.N the SDK has
    // shipped opt-in support for; the pinned version is one of those.
    return [...COMPATIBLE_PREFIX, ...range3_0_x];
  }

  if (prerelease) {
    console.error(
      `❌ ADCP_VERSION ${JSON.stringify(adcpVersion)} carries an unrecognized prerelease. ` +
        `Extend buildCompatibleVersions in scripts/sync-version.ts to define compat semantics.`
    );
    process.exit(1);
  }

  if (major !== 3 || minor !== 0) {
    console.error(
      `❌ ADCP_VERSION ${JSON.stringify(adcpVersion)} is outside the 3.0.x range this ` +
        `script enumerates. Extend buildCompatibleVersions in scripts/sync-version.ts ` +
        `to cover the new major/minor range, then re-run npm run sync-version.`
    );
    process.exit(1);
  }
  if (patch > MAX_PATCH_ENUMERATION) {
    console.error(
      `❌ ADCP_VERSION ${JSON.stringify(adcpVersion)} exceeds MAX_PATCH_ENUMERATION ` +
        `(${MAX_PATCH_ENUMERATION}). If the spec has genuinely produced this many patches, ` +
        `raise the constant in scripts/sync-version.ts deliberately.`
    );
    process.exit(1);
  }
  const range3_0_x: string[] = [];
  for (let p = 0; p <= patch; p++) range3_0_x.push(`3.0.${p}`);
  return [...COMPATIBLE_PREFIX, ...range3_0_x];
}

// Generate version.ts file with library and AdCP versions
function generateVersionFile(libraryVersion: string, adcpVersion: string): void {
  assertSafeVersion(libraryVersion, 'package.json version');
  assertSafeVersion(adcpVersion, 'ADCP_VERSION');
  const compatibleVersions = buildCompatibleVersions(adcpVersion);
  const compatibleVersionsLiteral = compatibleVersions.map(v => `  '${v}',`).join('\n');
  const versionFilePath = path.join(__dirname, '../src/lib/version.ts');
  const versionContent = `// Generated version information
// This file is auto-generated by sync-version.ts

/**
 * AdCP SDK library version
 */
export const LIBRARY_VERSION = '${libraryVersion}';

/**
 * AdCP specification version this library is built for
 */
export const ADCP_VERSION = '${adcpVersion}';

/**
 * AdCP major version sent with every request (adcp_major_version field).
 * Sellers validate this against their supported versions and return
 * VERSION_UNSUPPORTED if the version is not in range.
 */
export const ADCP_MAJOR_VERSION = 3;

/**
 * AdCP versions this library maintains backward compatibility with.
 *
 * Auto-derived from \`ADCP_VERSION\` by scripts/sync-version.ts — every
 * \`3.0.0\` through the current pin is enumerated. Do not edit this list
 * by hand; bumping the AdCP pin via \`npm run sync-version\` extends it.
 */
export const COMPATIBLE_ADCP_VERSIONS = [
${compatibleVersionsLiteral}
] as const;

/**
 * String literal union of every AdCP version the SDK formally supports.
 *
 * Used by the per-instance \`adcpVersion\` constructor option to give callers
 * autocomplete in editors. The intersection with \`(string & {})\` in the
 * config type preserves the escape hatch — any string is still accepted at
 * the type level — while the literal union surfaces canonical values first.
 */
export type AdcpVersion = (typeof COMPATIBLE_ADCP_VERSIONS)[number];

/**
 * Full version information
 */
export const VERSION_INFO = {
  library: '${libraryVersion}',
  adcp: '${adcpVersion}',
  compatibleVersions: COMPATIBLE_ADCP_VERSIONS,
  generatedAt: '${new Date().toISOString()}',
} as const;

/**
 * Get the AdCP specification version this library is built for
 */
export function getAdcpVersion(): string {
  return ADCP_VERSION;
}

/**
 * Get the library version
 */
export function getLibraryVersion(): string {
  return LIBRARY_VERSION;
}

/**
 * Check if this library version is compatible with a given AdCP version
 */
export function isCompatibleWith(adcpVersion: string): boolean {
  return (COMPATIBLE_ADCP_VERSIONS as readonly string[]).includes(adcpVersion);
}

/**
 * Get all AdCP versions this library is compatible with
 */
export function getCompatibleVersions(): readonly string[] {
  return COMPATIBLE_ADCP_VERSIONS;
}

/**
 * Extract the major version number from an AdCP version string.
 *
 * Accepts:
 *   - Semver: '3.0.0', '3.0.1', '3.1.0-beta.1' → 3
 *   - Legacy aliases: 'v3' → 3, 'v2.5' / 'v2.6' → 2
 *
 * Returns NaN for unrecognized strings — callers should validate before passing.
 */
export function parseAdcpMajorVersion(version: string): number {
  const trimmed = version.trim();
  const semverLike = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  const major = parseInt(semverLike.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : NaN;
}
`;

  const versionChanged = writeFileIfChanged(versionFilePath, versionContent);
  if (versionChanged) {
    console.log(`✅ Updated version file: ${versionFilePath}`);
  } else {
    console.log(`✅ Version file is up to date: ${versionFilePath}`);
  }
}

// Update package.json with AdCP version
function updatePackageJsonVersion(adcpVersion: string, autoUpdate: boolean = false): void {
  const packagePath = path.join(__dirname, '../package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

  const currentLibraryVersion = packageJson.version;
  const currentAdcpVersion = packageJson.adcp_version;

  // Check if AdCP version has changed
  if (currentAdcpVersion === adcpVersion) {
    console.log(`✅ Package already aligned with AdCP v${adcpVersion}`);
    generateVersionFile(currentLibraryVersion, adcpVersion);
    return;
  }

  // Update adcp_version field
  packageJson.adcp_version = adcpVersion;

  if (autoUpdate) {
    // Auto-increment library version when AdCP version changes
    const [major, minor, patch] = currentLibraryVersion.split('.').map(Number);

    // Determine version bump strategy based on AdCP version change
    const [currentMajor, currentMinor] = (currentAdcpVersion || '0.0.0').split('.').map(Number);
    const [newMajor, newMinor] = adcpVersion.split('.').map(Number);

    let newLibraryVersion: string;

    if (newMajor > currentMajor) {
      // Major AdCP version change -> bump major library version
      newLibraryVersion = `${major + 1}.0.0`;
    } else if (newMinor > currentMinor) {
      // Minor AdCP version change -> bump minor library version
      newLibraryVersion = `${major}.${minor + 1}.0`;
    } else {
      // Patch AdCP version change -> bump patch library version
      newLibraryVersion = `${major}.${minor}.${patch + 1}`;
    }

    packageJson.version = newLibraryVersion;
    console.log(`📈 Auto-updating library version: ${currentLibraryVersion} -> ${newLibraryVersion}`);
  }

  // Write updated package.json
  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`✅ Updated package.json:`);
  console.log(`   📦 Library version: ${packageJson.version}`);
  console.log(`   🏷️  AdCP version: ${adcpVersion}`);

  // Generate version file
  generateVersionFile(packageJson.version, adcpVersion);
}

// Main sync function
async function syncVersion(): Promise<void> {
  console.log('🔄 Syncing version with AdCP specification...');

  // Get current state
  const adcpVersion = getTargetAdCPVersion();
  const { version: currentLibraryVersion, adcpVersion: currentAdcpVersion } = getCurrentPackageVersion();

  console.log(`📋 Current state:`);
  console.log(`   📦 Library version: ${currentLibraryVersion}`);
  console.log(`   🏷️  Current AdCP version: ${currentAdcpVersion || 'not set'}`);
  console.log(`   🎯 Target AdCP version: ${adcpVersion} (from ADCP_VERSION file)`);

  // Check command line arguments
  const args = process.argv.slice(2);
  const autoUpdate = args.includes('--auto-update') || args.includes('-u');
  const forceUpdate = args.includes('--force') || args.includes('-f');

  if (currentAdcpVersion === adcpVersion && !forceUpdate) {
    console.log(`✅ Already in sync with AdCP v${adcpVersion}`);
    generateVersionFile(currentLibraryVersion, adcpVersion);
    return;
  }

  if (currentAdcpVersion && currentAdcpVersion !== adcpVersion) {
    console.log(`🔄 AdCP version change detected: ${currentAdcpVersion} -> ${adcpVersion}`);

    if (!autoUpdate && !forceUpdate) {
      console.log(`⚠️  Use --auto-update to automatically bump library version`);
      console.log(`⚠️  Use --force to update AdCP version without changing library version`);
      process.exit(1);
    }
  }

  // Update versions
  updatePackageJsonVersion(adcpVersion, autoUpdate);

  console.log(`✅ Version sync completed`);
}

// CLI execution
if (require.main === module) {
  syncVersion().catch(error => {
    console.error('❌ Version sync failed:', error);
    process.exit(1);
  });
}

export { syncVersion, getTargetAdCPVersion };
