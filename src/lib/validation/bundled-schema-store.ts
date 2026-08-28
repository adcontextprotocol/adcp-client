import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const ARCHIVE_FILE = 'bundled.schemas.br';
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const COMPACT_DEFINITIONS_KEY = 'x-adcp-compact-definitions';
type JsonSchema = Record<string, unknown>;

const archiveCache = new Map<string, ReadonlyMap<string, JsonSchema>>();

function walkRawSchemas(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkRawSchemas(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
  }
  return files;
}

function archivePath(bundledRoot: string): string {
  return path.join(path.dirname(bundledRoot), ARCHIVE_FILE);
}

/** Restore a compact archive entry to the protocol-authored inline shape. */
function expandCompactSchema(root: JsonSchema): JsonSchema {
  const compactNames = root[COMPACT_DEFINITIONS_KEY];
  const definitions = root.$defs;
  if (
    !Array.isArray(compactNames) ||
    !compactNames.every(name => typeof name === 'string') ||
    !definitions ||
    typeof definitions !== 'object' ||
    Array.isArray(definitions)
  ) {
    return root;
  }

  const compactNameSet = new Set(compactNames as string[]);
  const definitionMap = definitions as Record<string, unknown>;
  const expand = (value: unknown, resolving = new Set<string>()): unknown => {
    if (Array.isArray(value)) return value.map(child => expand(child, resolving));
    if (!value || typeof value !== 'object') return value;

    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string' && Object.keys(object).length === 1) {
      const match = object.$ref.match(/^#\/\$defs\/([^/]+)$/);
      const name = match?.[1];
      if (name && compactNameSet.has(name)) {
        if (resolving.has(name)) throw new Error(`Bundled schema compact definition is cyclic: ${name}`);
        const target = definitionMap[name];
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
          throw new Error(`Bundled schema compact definition is missing: ${name}`);
        }
        const nextResolving = new Set(resolving);
        nextResolving.add(name);
        return expand(target, nextResolving);
      }
    }

    const expanded: JsonSchema = {};
    for (const [key, child] of Object.entries(object)) {
      if (key === COMPACT_DEFINITIONS_KEY) continue;
      if (key === '$defs' && object === root) {
        const authoredDefinitions = Object.fromEntries(
          Object.entries(definitionMap)
            .filter(([name]) => !compactNameSet.has(name))
            .map(([name, definition]) => [name, expand(definition, resolving)])
        );
        if (Object.keys(authoredDefinitions).length > 0) expanded.$defs = authoredDefinitions;
        continue;
      }
      expanded[key] = expand(child, resolving);
    }
    return expanded;
  };

  return expand(root) as JsonSchema;
}

function loadArchive(bundledRoot: string): ReadonlyMap<string, JsonSchema> | undefined {
  const file = archivePath(bundledRoot);
  const cached = archiveCache.get(file);
  if (cached) return cached;
  if (!existsSync(file)) return undefined;
  if (statSync(file).size > MAX_ARCHIVE_BYTES) throw new Error(`Bundled schema archive exceeds 16 MiB: ${file}`);

  const decoded = brotliDecompressSync(readFileSync(file), { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  const parsed = JSON.parse(decoded.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Bundled schema archive is not an object: ${file}`);
  }

  const schemas = new Map<string, JsonSchema>();
  for (const [relativePath, schema] of Object.entries(parsed)) {
    const normalized = relativePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      parts.some(part => part === '' || part === '.' || part === '..') ||
      !normalized.endsWith('.json') ||
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema)
    ) {
      throw new Error(`Bundled schema archive contains an invalid entry: ${relativePath}`);
    }
    schemas.set(normalized, schema as JsonSchema);
  }
  archiveCache.set(file, schemas);
  return schemas;
}

export function hasBundledSchemaStore(bundledRoot: string): boolean {
  return walkRawSchemas(bundledRoot).length > 0 || existsSync(archivePath(bundledRoot));
}

export function listBundledSchemaFiles(bundledRoot: string): string[] {
  const raw = walkRawSchemas(bundledRoot);
  if (raw.length > 0) return raw;
  const archive = loadArchive(bundledRoot);
  return archive ? [...archive.keys()].map(relativePath => path.join(bundledRoot, relativePath)) : [];
}

export function loadBundledSchemaFile(file: string): JsonSchema | undefined {
  if (existsSync(file)) return expandCompactSchema(JSON.parse(readFileSync(file, 'utf8')) as JsonSchema);
  const marker = `${path.sep}bundled${path.sep}`;
  const markerIndex = file.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const bundledRoot = file.slice(0, markerIndex + `${path.sep}bundled`.length);
  const relativePath = file
    .slice(markerIndex + marker.length)
    .split(path.sep)
    .join('/');
  const schema = loadArchive(bundledRoot)?.get(relativePath);
  return schema ? expandCompactSchema(schema) : undefined;
}
