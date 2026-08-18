#!/usr/bin/env tsx
/**
 * Copy `schemas/cache/<ver>/` directories into the built package so the
 * runtime validator (src/lib/validation/schema-loader.ts) can read them
 * without a dependency on the source tree.
 *
 * Source: schemas/cache/<exact-version>/{bundled,core,<domain>}/
 *   - mirrors the spec repo tag we synced from (`3.0.0/`, `3.0.1/`,
 *     `3.1.0-beta.1/`, …)
 * Dest:   dist/lib/schemas-data/<bundle-key>/{bundled,core,<domain>}/
 *   - **stable releases use MAJOR.MINOR**: `3.0/` (whatever 3.0.x patch
 *     is current). Per the AdCP spec convention patch releases don't
 *     change wire shape, so consumer pins of `3.0.0`, `3.0.1`, or `3.0`
 *     all resolve to the same bundle. Stable filesystem path per minor;
 *     no fake exact-version directories holding a different patch's bytes.
 *   - **prereleases use full version**: `3.1.0-beta.1/`. Pinning a beta
 *     is intentional and bit-fidelity matters for cross-version interop.
 *
 * Skipped from copy:
 *   - `latest` symlink — duplicates a real version directory
 *   - `*.previous` backup snapshots from `sync-schemas` replaceTree
 *   - superseded prerelease bundles that are not the current ADCP_VERSION
 *   - older patch versions of stable releases — collapsed into the
 *     highest-patch sibling
 *   - `tmp/`, `compliance/`, and most transport-projection (`mcp/`)
 *     subtrees. The active MCP media-buy role profile is retained for exact
 *     `tools/list` request-schema discovery.
 *
 * Invoked by the `build:lib` npm script after tsc emits JS.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

interface ParsedVersion {
  version: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
}

/**
 * Parse the directory name as a semver. Returns `undefined` for anything
 * that doesn't look like an AdCP version (skipped at the call site).
 *
 * Handles:
 *   - `'3.0.1'` → { major:3, minor:0, patch:1, prerelease:undefined }
 *   - `'3.1.0-beta.1'` → { major:3, minor:1, patch:0, prerelease:'beta.1' }
 *   - `'v3'` / `'v2.5'` (legacy aliases) — returned as-is, no collapse
 *
 * Anything else (`'tmp'`, free-text directory) returns `undefined`.
 */
function parseSemver(version: string): ParsedVersion | undefined {
  // Legacy 'vN' / 'vN.M' aliases — never collapse, treat as opaque.
  if (/^v\d/.test(version)) {
    const m = version.match(/^v(\d+)(?:\.(\d+))?$/);
    if (!m) return undefined;
    return {
      version,
      major: parseInt(m[1]!, 10),
      minor: m[2] ? parseInt(m[2], 10) : 0,
      patch: 0,
      prerelease: 'legacy',
    };
  }
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return undefined;
  return {
    version,
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    prerelease: m[4],
  };
}

/**
 * Bundle key the dist directory is named under. Stable releases collapse
 * to `MAJOR.MINOR`; prereleases keep their full version. The schema-loader
 * resolves consumer pins to the same key.
 */
function bundleKey(v: ParsedVersion): string {
  if (v.prerelease !== undefined) return v.version;
  return `${v.major}.${v.minor}`;
}

/**
 * Group source versions by their bundle key. For each key the highest-patch
 * stable version (or the only prerelease) wins. Prereleases each get their
 * own key so they don't collapse against each other.
 */
function selectVersionsToCopy(parsed: ParsedVersion[]): { source: ParsedVersion; key: string }[] {
  const winnerByKey = new Map<string, ParsedVersion>();

  for (const v of parsed) {
    const key = bundleKey(v);
    const current = winnerByKey.get(key);
    if (!current) {
      winnerByKey.set(key, v);
      continue;
    }
    // Stable group: keep highest patch.
    if (v.prerelease === undefined && current.prerelease === undefined) {
      if (v.patch > current.patch) winnerByKey.set(key, v);
      continue;
    }
    // Different prerelease tags would have produced different keys above —
    // collision here would mean an exact duplicate, ignore.
  }

  return [...winnerByKey.entries()].map(([key, source]) => ({ source, key }));
}

function relaxAdagentsAuthorizedAgentsMinItems(schemaRoot: string): void {
  const adagentsPath = path.join(schemaRoot, 'adagents.json');
  if (!existsSync(adagentsPath)) return;

  const schema = JSON.parse(readFileSync(adagentsPath, 'utf8'));
  const inlineVariant = Array.isArray(schema.oneOf)
    ? schema.oneOf.find((variant: any) => variant?.properties?.authorized_agents)
    : undefined;
  const inlineProperties = inlineVariant?.properties;

  // Compatibility patch for the 3.1 catalog-era adagents.json schema:
  // community mirrors can publish formats/placements before any seller is
  // authorized, so `authorized_agents: []` is a valid inline file. Older
  // authorization-only schema bundles keep minItems:1. Remove this once the
  // upstream schema ships the same constraint directly.
  if (!inlineProperties?.catalog_etag || !inlineProperties?.formats) return;

  const authorizedAgents = inlineProperties.authorized_agents;
  if (!authorizedAgents || authorizedAgents.minItems == null) return;

  delete authorizedAgents.minItems;
  writeFileSync(adagentsPath, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(
    `[copy-schemas-to-dist] relaxed adagents.json authorized_agents minItems in ${adagentsPath} ` +
      `(empty catalog-only mirrors are valid)`
  );
}

function patchPrereleaseGetProductsTaskType(schemaRoot: string): void {
  const submittedPath = path.join(schemaRoot, 'media-buy', 'get-products-async-response-submitted.json');
  const taskTypePath = path.join(schemaRoot, 'enums', 'task-type.json');
  if (!existsSync(submittedPath) || !existsSync(taskTypePath)) return;

  const schema = JSON.parse(readFileSync(taskTypePath, 'utf8'));
  if (typeof schema.$id !== 'string' || (!schema.$id.includes('3.1.0-rc.8') && !schema.$id.includes('3.1.0-rc.9'))) {
    return;
  }
  if (!Array.isArray(schema.enum) || schema.enum.includes('get_products')) return;

  schema.enum = ['get_products', ...schema.enum];
  if (schema.enumDescriptions && typeof schema.enumDescriptions === 'object') {
    schema.enumDescriptions = {
      get_products: 'Media-buy domain: Discover or curate advertising products',
      ...schema.enumDescriptions,
    };
  }
  writeFileSync(taskTypePath, `${JSON.stringify(schema, null, 2)}\n`);
  patchInlineTaskTypeEnums(schemaRoot);
  console.log(
    `[copy-schemas-to-dist] added get_products to task-type enum in ${taskTypePath} ` +
      `(3.1 prerelease async get_products response declares poll/webhook support)`
  );
}

function patchInlineTaskTypeEnums(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      patchInlineTaskTypeEnums(abs);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    let changed = false;
    const schema = JSON.parse(readFileSync(abs, 'utf8'));
    const visit = (value: unknown): void => {
      if (value == null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const node = value as Record<string, unknown>;
      if (
        Array.isArray(node.enum) &&
        node.enum.includes('create_media_buy') &&
        node.enum.includes('get_signals') &&
        node.enum.includes('acquire_rights') &&
        !node.enum.includes('get_products')
      ) {
        node.enum = ['get_products', ...node.enum];
        changed = true;
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(schema);
    if (changed) writeFileSync(abs, `${JSON.stringify(schema, null, 2)}\n`);
  }
}

/**
 * Select only the self-contained MCP request projections used by modern
 * tools/list. Response projections are deliberately excluded: they add tens
 * of megabytes to the package and to an LLM's discovery context without
 * helping a caller construct tool arguments.
 */
function mcpInputProjectionPaths(schemaRoot: string): Set<string> {
  const allowed = new Set<string>();
  const mcpRoot = path.join(schemaRoot, 'mcp');
  if (!existsSync(mcpRoot)) return allowed;

  for (const protocolEntry of readdirSync(mcpRoot, { withFileTypes: true })) {
    if (!protocolEntry.isDirectory()) continue;
    const protocolRoot = path.join(mcpRoot, protocolEntry.name);
    const manifests = [
      path.join(protocolRoot, 'manifest.json'),
      path.join(protocolRoot, 'profiles', 'media-buy', 'manifest.json'),
    ];
    for (const manifestFile of manifests) {
      if (!existsSync(manifestFile)) continue;
      const manifestRoot = path.dirname(manifestFile);
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        tools?: Record<string, { inputSchema?: unknown }>;
      };
      allowed.add(path.relative(schemaRoot, manifestFile));
      for (const tool of Object.values(manifest.tools ?? {})) {
        if (typeof tool.inputSchema !== 'string') continue;
        const schemaFile = path.resolve(manifestRoot, tool.inputSchema);
        if (!schemaFile.startsWith(`${manifestRoot}${path.sep}`) || !existsSync(schemaFile)) continue;
        allowed.add(path.relative(schemaRoot, schemaFile));
      }
    }
  }
  return allowed;
}

function stripMcpOutputSchemaReferences(schemaRoot: string): void {
  const mcpRoot = path.join(schemaRoot, 'mcp');
  if (!existsSync(mcpRoot)) return;
  const visit = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const abs = path.join(root, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'manifest.json') continue;
      const manifest = JSON.parse(readFileSync(abs, 'utf8')) as {
        schema_fields?: unknown;
        tools?: Record<string, { outputSchema?: unknown }>;
      };
      for (const tool of Object.values(manifest.tools ?? {})) delete tool.outputSchema;
      if (Array.isArray(manifest.schema_fields)) {
        manifest.schema_fields = manifest.schema_fields.filter(field => field === 'inputSchema');
      }
      writeFileSync(abs, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  };
  visit(mcpRoot);
}

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const cacheRoot = path.join(repoRoot, 'schemas', 'cache');
  if (!existsSync(cacheRoot)) {
    // The schema cache is fetched by `sync-schemas`. CI jobs that don't run
    // the full toolchain (e.g., the code-quality integrity check that does
    // `npm clean && build:lib` without a prior sync-schemas) would otherwise
    // break here. Skip quietly — the loader falls back to the same source
    // path, and any job that actually needs the schemas at runtime will get
    // a clear error at first use.
    console.warn(
      `[copy-schemas-to-dist] schemas/cache/ missing; skipping. ` +
        `Run \`npm run sync-schemas\` to populate it before shipping.`
    );
    return;
  }

  // Collect parseable version directories.
  const candidates: ParsedVersion[] = [];
  const skipped: string[] = [];
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    // `latest` is a symlink to the current default version; the loader
    // resolves versions by name, not via that alias.
    if (entry.name === 'latest') continue;
    // `*.previous` are sync-schemas replaceTree backup snapshots.
    if (entry.name.endsWith('.previous')) continue;
    if (!entry.isDirectory()) {
      // Defensive: skip non-directory entries (loose files, broken symlinks).
      // `lstatSync` rather than `entry.isDirectory()` so a symlink-to-dir
      // doesn't masquerade as a real version when the link target is gone.
      const abs = path.join(cacheRoot, entry.name);
      try {
        if (!lstatSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    const parsed = parseSemver(entry.name);
    if (!parsed) {
      skipped.push(entry.name);
      continue;
    }
    candidates.push(parsed);
  }

  const currentProtocolVersion = readFileSync(path.join(repoRoot, 'ADCP_VERSION'), 'utf8').trim();
  const publishableCandidates = candidates.filter(
    candidate =>
      candidate.prerelease === undefined ||
      candidate.prerelease === 'legacy' ||
      candidate.version === currentProtocolVersion
  );
  const selected = selectVersionsToCopy(publishableCandidates);
  const collapsed = candidates.filter(c => !selected.some(s => s.source.version === c.version));

  const destBase = path.join(repoRoot, 'dist', 'lib', 'schemas-data');
  // A normal incremental build must produce the same publish payload as a
  // clean build. Remove bundle keys selected by an earlier protocol pin (for
  // example 3.2.0-beta.0 after moving to beta.1) before copying the current
  // supported set.
  rmSync(destBase, { recursive: true, force: true });
  mkdirSync(destBase, { recursive: true });

  for (const { source, key } of selected) {
    const srcRoot = path.join(cacheRoot, source.version);
    const destRoot = path.join(destBase, key);
    const allowedMcpFiles = mcpInputProjectionPaths(srcRoot);
    rmSync(destRoot, { recursive: true, force: true });
    mkdirSync(destRoot, { recursive: true });
    cpSync(srcRoot, destRoot, {
      recursive: true,
      filter: src => {
        const rel = path.relative(srcRoot, src);
        if (!rel) return true;
        const parts = rel.split(path.sep);
        const top = parts[0];
        if (top === 'tmp' || top === 'compliance') return false;
        if (top === 'mcp') {
          return [...allowedMcpFiles].some(allowed => allowed === rel || allowed.startsWith(`${rel}${path.sep}`));
        }
        return true;
      },
    });
    stripMcpOutputSchemaReferences(destRoot);
    relaxAdagentsAuthorizedAgentsMinItems(destRoot);
    patchPrereleaseGetProductsTaskType(destRoot);
    const note = key === source.version ? '' : ` (key collapsed from ${source.version})`;
    console.log(`[copy-schemas-to-dist] copied ${srcRoot} → ${destRoot}${note}`);
  }

  for (const v of collapsed) {
    const reason = v.prerelease
      ? `superseded prerelease; current pin is ${currentProtocolVersion}`
      : `older patch in ${v.major}.${v.minor}.x`;
    console.log(`[copy-schemas-to-dist] skipped ${v.version} (${reason}; not bundled)`);
  }

  for (const name of skipped) {
    console.log(`[copy-schemas-to-dist] skipped ${name} (not a parseable version)`);
  }

  if (selected.length === 0) {
    console.warn(`[copy-schemas-to-dist] no version directories under ${cacheRoot}; bundle ships without schemas.`);
  }
}

main();
