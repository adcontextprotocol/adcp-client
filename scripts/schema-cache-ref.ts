import path from 'path';

const OFFICIAL_SCHEMA_ORIGIN = 'https://adcontextprotocol.org';
const VERSION_SEGMENT = /^(?:v\d+|latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Convert an AdCP schema reference to a path relative to a local schema cache.
 *
 * Protocol 3.2 publishes canonical absolute schema URIs. Build tooling must
 * resolve those URIs from the already verified local bundle without treating
 * arbitrary web origins as cache paths.
 */
export function schemaRefToCacheRelativePath(schemaRef: string): string | null {
  if (!schemaRef || typeof schemaRef !== 'string' || schemaRef.startsWith('#')) return null;

  let candidate = schemaRef;
  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    if (url.origin !== OFFICIAL_SCHEMA_ORIGIN || url.search || url.username || url.password) return null;
    candidate = url.pathname;
  }

  // Fragments are resolved by the JSON Schema compiler after the containing
  // document has been loaded from the cache.
  candidate = candidate.split('#', 1)[0]!;
  if (candidate.startsWith('/schemas/')) {
    const segments = candidate.slice('/schemas/'.length).split('/');
    if (segments.length > 1 && VERSION_SEGMENT.test(segments[0]!)) segments.shift();
    candidate = segments.join('/');
  }

  candidate = candidate.replace(/^\.\//, '');
  const normalized = path.posix.normalize(candidate);
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)) return null;
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function resolveSchemaRefInCache(cacheDir: string, schemaRef: string): string | null {
  const relativePath = schemaRefToCacheRelativePath(schemaRef);
  if (!relativePath) return null;

  const cacheRoot = path.resolve(cacheDir);
  const resolved = path.resolve(cacheRoot, relativePath);
  if (resolved !== cacheRoot && !resolved.startsWith(`${cacheRoot}${path.sep}`)) return null;
  return resolved;
}
