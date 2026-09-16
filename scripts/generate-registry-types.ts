#!/usr/bin/env tsx

/**
 * Generate TypeScript types from the AdCP Registry OpenAPI spec.
 *
 * Usage:
 *   npm run generate-registry-types          # Use cached spec
 *   npm run generate-registry-types -- --sync # Download fresh spec first
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

import { parse as parseYaml } from 'yaml';

const REGISTRY_SPEC_URL = 'https://agenticadvertising.org/openapi/registry.yaml';
const SCHEMA_DIR = path.join(__dirname, '../schemas/registry');
const CACHED_SPEC = path.join(SCHEMA_DIR, 'registry.yaml');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/registry/types.generated.ts');
const SPEC_TIMEOUT_MS = 10_000;
const SPEC_MAX_BYTES = 1024 * 1024;

/**
 * Operations whose `requestBody` the upstream spec declares without `required: true`.
 *
 * OpenAPI defaults `requestBody.required` to `false`, so `openapi-typescript` emits
 * `requestBody?:` and the generated operation admits a bodyless call even when the body
 * schema itself lists required properties. For a mutation that is a plain spec bug.
 *
 * These corrections are applied to an in-memory copy of the spec, never to the cached
 * file: `schemas/registry/registry.yaml` stays byte-identical to what AAO publishes, and
 * the generated output is a pure function of (cached spec + this table), so re-running
 * sync or generation is stable and no hand edit is ever needed.
 *
 * Remove an entry once AAO publishes the fix -- `applyUpstreamSpecCorrections` reports
 * every entry that has become a no-op, so a stale entry cannot go unnoticed.
 */
const REQUEST_BODY_REQUIRED_CORRECTIONS: ReadonlyArray<{ operationId: string; reason: string }> = [
  {
    operationId: 'selectAgentGradingProfile',
    reason:
      'PUT /api/registry/agents/{encodedUrl}/grading-profile requires seven body fields ' +
      '(organization_id, role, adcp_version, selected_profile, assessment_id, expected_revision, ' +
      'idempotency_key) and performs a revision compare-and-swap, but omits requestBody.required.',
  },
];

type MutableRequestBody = { required?: boolean };
type MutableOperation = { operationId?: unknown; requestBody?: MutableRequestBody };

function asOperation(value: unknown): MutableOperation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as MutableOperation;
  return typeof candidate.operationId === 'string' ? candidate : undefined;
}

/**
 * Mark the request body of each corrected operation required. Returns one header line
 * per applied correction so the generated file records why it differs from the spec.
 */
function applyUpstreamSpecCorrections(spec: unknown): string[] {
  const pending = new Map(REQUEST_BODY_REQUIRED_CORRECTIONS.map(entry => [entry.operationId, entry]));
  const applied: string[] = [];
  const paths =
    typeof spec === 'object' && spec !== null ? ((spec as { paths?: unknown }).paths as unknown) : undefined;

  for (const pathItem of Object.values((paths as Record<string, unknown>) ?? {})) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;
    for (const candidate of Object.values(pathItem as Record<string, unknown>)) {
      const operation = asOperation(candidate);
      const entry = operation ? pending.get(operation.operationId as string) : undefined;
      if (!operation || !entry) continue;
      pending.delete(entry.operationId);

      if (typeof operation.requestBody !== 'object' || operation.requestBody === null) {
        console.warn(`! ${entry.operationId}: upstream declares no requestBody; drop this correction.`);
        continue;
      }
      if (operation.requestBody.required === true) {
        console.log(`= ${entry.operationId}: upstream now marks requestBody required; drop this correction.`);
        continue;
      }
      operation.requestBody.required = true;
      applied.push(`${entry.operationId}: requestBody.required = true. ${entry.reason}`);
      console.log(`+ ${entry.operationId}: requestBody marked required.`);
    }
  }

  for (const operationId of pending.keys()) {
    console.warn(`! ${operationId}: not present in the cached spec; drop this correction.`);
  }
  return applied;
}

function writeFileIfChanged(filePath: string, newContent: string): boolean {
  const contentWithoutTimestamp = (content: string) =>
    content.replace(/\/\/ Generated at: .*?\n/, '// Generated at: [TIMESTAMP]\n');

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (contentWithoutTimestamp(existing) === contentWithoutTimestamp(newContent)) {
      return false;
    }
  }

  writeFileSync(filePath, newContent);
  return true;
}

async function syncSpec(): Promise<void> {
  console.log(`Downloading registry spec from ${REGISTRY_SPEC_URL}...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPEC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(REGISTRY_SPEC_URL, {
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/yaml,text/yaml,text/plain' },
    });
    if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
    const yaml = await readResponseTextWithLimit(res, SPEC_MAX_BYTES);
    mkdirSync(SCHEMA_DIR, { recursive: true });
    writeFileSync(CACHED_SPEC, yaml);
    console.log(`Cached at ${CACHED_SPEC} (${yaml.length} bytes)`);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Failed to fetch spec: timed out after ${SPEC_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseTextWithLimit(res: Response, maxBytes: number): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`Failed to fetch spec: response exceeded ${maxBytes} bytes`);
    }
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Failed to fetch spec: response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Failed to fetch spec: response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buf = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function generate(): Promise<void> {
  const shouldSync = process.argv.includes('--sync');

  if (shouldSync || !existsSync(CACHED_SPEC)) {
    await syncSpec();
  }

  // Dynamic import since openapi-typescript is ESM-only
  const { default: openapiTS, astToString } = await import('openapi-typescript');

  console.log('Generating types from cached spec...');
  const spec: unknown = parseYaml(readFileSync(CACHED_SPEC, 'utf8'));
  const corrections = applyUpstreamSpecCorrections(spec);
  const ast = await openapiTS(spec as Parameters<typeof openapiTS>[0]);
  const rawOutput = astToString(ast);

  // Build the output file with ergonomic re-exports
  const correctionNotes =
    corrections.length === 0
      ? ''
      : `//
// Upstream spec corrections applied in memory by scripts/generate-registry-types.ts.
// The cached spec is untouched; remove the entry there once AAO publishes the fix.
${corrections.map(note => `//   - ${note}`).join('\n')}
`;

  const header = `// Generated AdCP Registry types from OpenAPI spec
// Generated at: ${new Date().toISOString()}
// Source: ${REGISTRY_SPEC_URL}
//
// Do not edit this file manually. Run: npm run generate-registry-types
${correctionNotes}`;

  const content = `${header}
${rawOutput}

// ====== Ergonomic type aliases ======
// Re-export component schemas as standalone types for direct import

export type ResolvedBrand = components['schemas']['ResolvedBrand'];
export type LocalizedName = components['schemas']['LocalizedName'];
export type BrandRegistryItem = components['schemas']['BrandRegistryItem'];
export type ResolvedProperty = components['schemas']['ResolvedProperty'];
export type PropertyIdentifier = components['schemas']['PropertyIdentifier'];
export type PropertyRegistryItem = components['schemas']['PropertyRegistryItem'];
export type ValidationResult = components['schemas']['ValidationResult'];
export type RegistryError = components['schemas']['Error'];
export type PublisherPropertySelector = components['schemas']['PublisherPropertySelector'];
export type FederatedAgentWithDetails = components['schemas']['FederatedAgentWithDetails'];
export type AgentHealth = components['schemas']['AgentHealth'];
export type AgentStats = components['schemas']['AgentStats'];
export type AgentCapabilities = components['schemas']['AgentCapabilities'];
export type PropertySummary = components['schemas']['PropertySummary'];
export type FederatedPublisher = components['schemas']['FederatedPublisher'];
export type DomainLookupResult = components['schemas']['DomainLookupResult'];
export type BrandActivity = components['schemas']['BrandActivity'];
export type PropertyActivity = components['schemas']['PropertyActivity'];
export type PolicySummary = components['schemas']['PolicySummary'];
export type Policy = components['schemas']['Policy'];
export type PolicyHistory = components['schemas']['PolicyHistory'];
export type RegistryFeedEvent = components['schemas']['RegistryFeedEvent'];
export type AgentEventPayload = components['schemas']['AgentEventPayload'];
export type PropertyEventPayload = components['schemas']['PropertyEventPayload'];
export type CollectionEventPayload = components['schemas']['CollectionEventPayload'];
export type AuthorizationEventPayload = components['schemas']['AuthorizationEventPayload'];
export type PublisherEventPayload = components['schemas']['PublisherEventPayload'];
export type BrandEventPayload = components['schemas']['BrandEventPayload'];
export type CatalogBrowseResponse = components['schemas']['CatalogBrowseResponse'];
export type CatalogBrowseEntry = components['schemas']['CatalogBrowseEntry'];
export type CatalogSyncResponse = components['schemas']['CatalogSyncResponse'];
export type CatalogSyncEntry = components['schemas']['CatalogSyncEntry'];
export type AgentCompliance = components['schemas']['AgentCompliance'];
export type AgentComplianceDetail = components['schemas']['AgentComplianceDetail'];
export type StoryboardStatus = components['schemas']['StoryboardStatus'];
export type OperatorLookupResult = components['schemas']['OperatorLookupResult'];
export type PublisherLookupResult = components['schemas']['PublisherLookupResult'];
export type CommunityMirrorListResponse = components['schemas']['CommunityMirrorListResponse'];
export type CommunityMirrorSummary = components['schemas']['CommunityMirrorSummary'];
export type CommunityMirrorGetResponse = components['schemas']['CommunityMirrorGetResponse'];
export type CommunityMirrorAdagentsJson = components['schemas']['CommunityMirrorAdagentsJson'];
export type CommunityMirrorPublishResponse = components['schemas']['CommunityMirrorPublishResponse'];
export type CommunityMirrorPublishError = components['schemas']['CommunityMirrorPublishError'];
export type CommunityMirrorPublishRequest = components['schemas']['CommunityMirrorPublishRequest'];
export type CommunityMirrorDeleteResponse = components['schemas']['CommunityMirrorDeleteResponse'];

// ====== Inline operation types ======
// The following types are defined inline in operation responses (not in components.schemas)
// in ADCP 3.0.0-rc.3. We extract them here for ergonomic standalone usage.

/** A single event from the registry feed (inline in getRegistryFeed 200 response). */
export type CatalogEvent = operations['getRegistryFeed']['responses']['200']['content']['application/json']['events'][number];

/** Feed freshness metadata for lag monitoring (adcp#5733). Reported on every real feed page. */
export type FeedFreshness = NonNullable<
  operations['getRegistryFeed']['responses']['200']['content']['application/json']['freshness']
>;

/**
 * Full response from GET /api/registry/feed.
 *
 * \`cursor_expired\` is set by the client when the server returns 410; that
 * synthetic marker carries no \`freshness\`, so \`freshness\` is widened to
 * optional here even though the spec requires it on real pages. The SDK never
 * fabricates freshness — it is present iff the server sent it.
 */
export type FeedResponse = Omit<
  operations['getRegistryFeed']['responses']['200']['content']['application/json'],
  'freshness'
> & {
  /** Set to true by the client when the server returns 410 (cursor expired). */
  cursor_expired?: boolean;
  /** Feed lag metadata. Present on every real feed page; absent on the cursor_expired marker. */
  freshness?: FeedFreshness;
};

/** Raw search result from the searchAgentProfiles operation. */
export type AgentProfileSearchResult =
  operations['searchAgentProfiles']['responses']['200']['content']['application/json']['results'][number];

/** Full response from GET /api/registry/agents/search (raw operation type). */
export type AgentProfileSearchResponse =
  operations['searchAgentProfiles']['responses']['200']['content']['application/json'];

/** Response from POST /api/registry/crawl-request (202). */
export type CrawlRequestResponse = operations['requestCrawl']['responses']['202']['content']['application/json'];

// ====== Client-facing composite types ======
// These provide a stable API for the sync module and client consumers,
// mapping the flat searchAgentProfiles response to the richer shape expected by callers.

/** Inventory profile for an agent (channels, markets, categories, etc.). */
export type AgentInventoryProfile = {
  channels: string[];
  property_types: string[];
  markets: string[];
  categories: string[];
  category_taxonomy: string | null;
  tags: string[];
  delivery_types: string[];
  format_ids?: string[];
  property_count: number;
  publisher_count: number;
  has_tmp: boolean;
};

/** An agent search result in the client-facing shape used by RegistrySync. */
export type AgentSearchResult = {
  url: string;
  name: string;
  type: string;
  inventory_profile: AgentInventoryProfile;
  compliance_summary?: AgentCompliance;
  match: { score: number; matched_filters: string[] };
};

/** Response shape for the searchAgents client method. */
export type AgentSearchResponse = {
  results: AgentSearchResult[];
  cursor: string | null;
  has_more: boolean;
};

/** An authorization entry used by the sync module. Mirrors authorization.* event payloads. */
export type AuthorizationEntry = components['schemas']['AuthorizationEventPayload'] & {
  /** Legacy alias still returned by some registry deployments. */
  effective_to?: string;
};
`;

  const changed = writeFileIfChanged(OUTPUT_FILE, content);
  if (changed) {
    console.log(`Generated ${OUTPUT_FILE} (${content.length} bytes)`);
  } else {
    console.log('No changes detected, file unchanged.');
  }
}

generate().catch(err => {
  console.error('Error generating registry types:', err.message);
  process.exit(1);
});
