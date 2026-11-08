/**
 * Project a `get_adcp_capabilities` response from the server's release down
 * to the release served to the caller (DR-0024: a response conforms to the
 * served release).
 *
 * Each step between the two releases runs the same schema diff as every other
 * task response (`downgradeResponse`): properties, enum values and union
 * variants the newer release declares but the older one does not are removed.
 * Keys neither release declares, such as `library_version` or a seller's own
 * extension, are left alone.
 *
 * `experimental_features` is a list of free-form ids, so the schema diff
 * cannot see a newer release's ids. Each step also removes the ids the newer
 * release's capabilities schema names and the older one never mentions.
 * Every removal is reported as `version_downgrade_fields_dropped` drift.
 */
import { adcpMinorLine, downgradeResponse, translationSteps, type VersionDrift } from '../adapters/version';
import {
  getSchemaLoaderGeneration,
  getToolSchemaDocument,
  resolveBundleKey,
  resolveSchemaRoot,
} from '../validation/schema-loader';

const TOOL = 'get_adcp_capabilities';

let cachedGeneration = -1;
const corpusCache = new Map<string, string | undefined>();

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) collectStrings(item, out);
}

/** Every string value in the release's capabilities response schema: `const`s, enums and descriptions. */
function capabilitiesSchemaText(version: string): string | undefined {
  const generation = getSchemaLoaderGeneration();
  if (cachedGeneration !== generation) {
    corpusCache.clear();
    cachedGeneration = generation;
  }
  let key: string;
  try {
    key = `${resolveBundleKey(version)}\0${resolveSchemaRoot(version)}`;
  } catch {
    return undefined;
  }
  if (corpusCache.has(key)) return corpusCache.get(key);
  let text: string | undefined;
  try {
    const schema = getToolSchemaDocument(TOOL, 'sync', version)?.schema;
    if (schema) {
      const strings: string[] = [];
      collectStrings(schema, strings);
      text = strings.join('\n');
    }
  } catch {
    text = undefined;
  }
  corpusCache.set(key, text);
  return text;
}

function mentions(text: string, featureId: string): boolean {
  const escaped = featureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9_.])${escaped}(?![a-z0-9_]|\\.[a-z])`).test(text);
}

/**
 * Feature ids `upper` names that `lower` does not define.
 *
 * AdCP publishes no structured registry of experimental feature ids:
 * `core/experimental-feature-id.json` is a pattern, and most ids (e.g.
 * `trusted_match.core`) appear in no schema at all. A release's capabilities
 * schema names the ids it gates (`experimental_features: { contains: { const } }`)
 * and documents others in prose, so an id the newer schema names and the
 * older one never mentions belongs to the newer release. Ids neither schema
 * mentions are kept. Replace this with the registry once the spec ships one
 * (adcontextprotocol/adcp#8812).
 */
function newerFeatureIds(features: readonly unknown[], upper: string, lower: string): Set<string> {
  const upperText = capabilitiesSchemaText(upper);
  const lowerText = capabilitiesSchemaText(lower);
  const newer = new Set<string>();
  if (upperText === undefined || lowerText === undefined) return newer;
  for (const feature of features) {
    if (typeof feature !== 'string' || newer.has(feature)) continue;
    if (mentions(upperText, feature) && !mentions(lowerText, feature)) newer.add(feature);
  }
  return newer;
}

/**
 * Convert a capabilities response from the server's release `fromVersion`
 * down to the served release `toVersion`. Returns the original reference and
 * no drift when nothing changes. The input is never mutated.
 */
export function projectCapabilitiesForRelease<T>(
  data: T,
  options: { fromVersion: string; toVersion: string }
): { data: T; drifts: VersionDrift[] } {
  const drifts: VersionDrift[] = [];
  let current: unknown = data;
  for (const step of translationSteps(options.fromVersion, options.toVersion)) {
    const downgraded = downgradeResponse(TOOL, current, { fromVersion: step.upper, toVersion: step.lower });
    current = downgraded.data;
    drifts.push(...downgraded.drifts);

    if (current === null || typeof current !== 'object' || Array.isArray(current)) continue;
    const body = current as Record<string, unknown>;
    const features = body.experimental_features;
    if (!Array.isArray(features)) continue;
    const newer = newerFeatureIds(features, step.upper, step.lower);
    if (newer.size === 0) continue;
    const paths: string[] = [];
    const kept = features.filter((feature, index) => {
      if (typeof feature !== 'string' || !newer.has(feature)) return true;
      paths.push(`experimental_features[${index}]`);
      return false;
    });
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== 'experimental_features') next[key] = value;
      else if (kept.length > 0) next[key] = kept;
    }
    current = next;
    drifts.push({
      type: 'version_downgrade_fields_dropped',
      message:
        `${TOOL}: removed ${newer.size} experimental feature id(s) AdCP ` +
        `${adcpMinorLine(step.lower) ?? step.lower} does not define: ${[...newer].join(', ')}.`,
      strippedFields: paths,
      fromVersion: step.upper,
      toVersion: step.lower,
    });
  }
  return { data: current as T, drifts };
}
