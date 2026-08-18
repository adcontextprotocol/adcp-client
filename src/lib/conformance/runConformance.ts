import { AgentClient } from '../core/AgentClient';
import type { AgentConfig } from '../types';
import { parseAdcpMajorVersion } from '../version';
import type {
  ConformanceFailure,
  ConformanceFixtures,
  ConformanceReport,
  ConformanceToolName,
  ConformanceToolStats,
  RunConformanceOptions,
} from './types';
import {
  COMPACT_LIFECYCLE_TOOLS,
  COMPACT_STATELESS_TIER_TOOLS,
  COMPACT_UPDATE_TIER_TOOLS,
  DEFAULT_TOOLS,
  UPDATE_TIER_TOOLS,
} from './types';
import { detectSchemaVersion, hasSchemas } from './schemaLoader';
import type { ConformanceSchemaOptions } from './schemaLoader';
import { runToolFuzz } from './runners';
import { seedFixtures, type SeedWarning } from './seeder';
import {
  runUniformErrorInvariant,
  toolsEligibleForUniformError,
  type UniformErrorReport,
} from './invariants/uniformError';

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_MAX_FAILURE_PAYLOAD_BYTES = 8192;
const MIN_FAILURE_PAYLOAD_BYTES = 256;

/**
 * Fuzz an AdCP agent against its published JSON schemas.
 *
 * Generates schema-valid requests for each tool, calls the agent, and
 * classifies each response under the two-path oracle: valid success
 * payloads pass; valid error envelopes with uppercase-snake reason codes
 * also pass. Invalid responses, stack-trace leaks, and reason-code
 * violations surface as failures with a shrunk reproduction seed.
 *
 * With `autoSeed: true`, the fuzzer first calls {@link seedFixtures} to
 * create a property list, a content-standards config, and a media buy,
 * then includes Tier-3 update tools in the run using the seeded IDs.
 */
export async function runConformance(
  agentUrl: string,
  options: RunConformanceOptions = {}
): Promise<ConformanceReport> {
  const startedAt = new Date();
  const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const turnBudget = options.turnBudget ?? 50;
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const maxFailurePayloadBytes = Math.max(
    MIN_FAILURE_PAYLOAD_BYTES,
    options.maxFailurePayloadBytes ?? DEFAULT_MAX_FAILURE_PAYLOAD_BYTES
  );
  const schemaOptions = buildSchemaOptions(options);
  const wireVersion = resolveWireVersion(options);
  // Compact lifecycle defaults are schema-gated. Explicit 3.0/3.1 runs keep
  // their historical tool and seeder sets, while a complete 3.2 bundle turns
  // on the compact surface without making callers enumerate it.
  const compactLifecycleAvailable = COMPACT_LIFECYCLE_TOOLS.every(tool => hasSchemas(tool, schemaOptions));

  // Auto-seed BEFORE building the fuzzing client so the seeder's warnings
  // reach the report. Explicit caller fixtures win against any seeder
  // conflict — that's the contract `autoSeed` promises.
  let seededFixtures: ConformanceFixtures = {};
  let seedWarnings: SeedWarning[] = [];
  if (options.autoSeed) {
    const seedResult = await seedFixtures(agentUrl, {
      protocol: options.protocol,
      authToken: options.authToken,
      agentConfig: options.agentConfig,
      brand: options.seedBrand,
      includeCompactMediaBuy: compactLifecycleAvailable,
      adcpVersion: wireVersion,
    });
    seededFixtures = seedResult.fixtures;
    seedWarnings = seedResult.warnings;
  }
  const mergedFixtures = mergeFixtures(seededFixtures, options.fixtures);

  // Gate each mutation against the fixture shape it actually consumes.
  // A property-list ID must not enable proposal acceptance, and a bare
  // media_buy_id is insufficient for control_media_buy's revision check.
  const baseDefaultTools = [
    ...DEFAULT_TOOLS,
    ...UPDATE_TIER_TOOLS.filter(tool => toolHasConformanceFixtures(tool, mergedFixtures)),
  ];
  const compactMutationsEnabled = options.autoSeed === true || hasCompactFixtures(mergedFixtures);
  const compactDefaultTools = compactLifecycleAvailable
    ? [
        ...COMPACT_STATELESS_TIER_TOOLS,
        ...(compactMutationsEnabled
          ? COMPACT_UPDATE_TIER_TOOLS.filter(tool => toolHasConformanceFixtures(tool, mergedFixtures, true))
          : []),
      ]
    : [];
  const defaultTools = [...baseDefaultTools, ...compactDefaultTools];
  const tools = options.tools ?? defaultTools;

  const agent = buildAgentClient(agentUrl, options);

  const perTool: Record<string, ConformanceToolStats> = {};
  const failures: ConformanceFailure[] = [];
  let totalRuns = 0;
  let droppedFailures = 0;

  for (const [i, tool] of tools.entries()) {
    if (!hasSchemas(tool, schemaOptions)) {
      perTool[tool] = {
        runs: 0,
        accepted: 0,
        rejected: 0,
        failed: 0,
        skipped: true,
        skipReason: 'missing_schemas',
      };
      continue;
    }
    // Offset each tool's seed so they don't all explore the same corner
    // of generator space — still deterministic vs. the caller-provided seed.
    const toolSeed = seed + i * 1_000_003;
    const { stats, failures: toolFailures } = await runToolFuzz(tool, agent, {
      seed: toolSeed,
      numRuns: turnBudget,
      authToken: options.authToken,
      maxFailurePayloadBytes,
      fixtures: mergedFixtures,
      schemas: schemaOptions,
      adcpVersion: wireVersion,
    });
    perTool[tool] = stats;
    totalRuns += stats.runs;
    for (const f of toolFailures) {
      if (failures.length >= maxFailures) {
        droppedFailures++;
        continue;
      }
      failures.push(f);
    }
  }

  // Uniform-error-response invariant (issue #731 / adcp spec
  // § error-handling). Runs AFTER the main fuzz loop so normal stats are
  // already collected; this is a discrete paired-probe pass per
  // T2-eligible tool and adds a bounded number of extra requests (two
  // per eligible tool). Runs regardless of fuzz outcomes — a broken
  // response envelope elsewhere shouldn't mask a cross-tenant leak.
  const uniformError: UniformErrorReport[] = [];
  const proberAgent = options.authTokenCrossTenant
    ? buildAgentClient(agentUrl, { ...options, authToken: options.authTokenCrossTenant })
    : agent;
  for (const tool of toolsEligibleForUniformError()) {
    if (options.tools && !options.tools.includes(tool)) continue;
    if (!hasSchemas(tool, schemaOptions)) continue;
    const report = await runUniformErrorInvariant(tool, {
      prober: proberAgent,
      fixtures: mergedFixtures,
      crossTenantConfigured: !!options.authTokenCrossTenant,
      maxBodyBytes: maxFailurePayloadBytes,
    });
    uniformError.push(report);
  }

  const completedAt = new Date();
  return {
    agentUrl,
    seed,
    schemaVersion: detectSchemaVersion(schemaOptions),
    ...(options.schemaRoot ? { schemaRoot: options.schemaRoot } : {}),
    protocol: options.protocol ?? options.agentConfig?.protocol ?? 'mcp',
    turnBudget,
    fixturesUsed: mergedFixtures,
    autoSeeded: !!options.autoSeed,
    seedWarnings,
    totalRuns,
    totalFailures: failures.length + droppedFailures,
    droppedFailures,
    perTool,
    failures,
    uniformError,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };
}

/**
 * Merge seeded fixtures with explicit caller-supplied ones. Explicit
 * pools fully replace the seeded pool for that key — they don't
 * concatenate — because callers with their own test tenants typically
 * want only their IDs, not the seeder's. Empty explicit pools fall
 * through to the seeded value rather than wiping it; callers building
 * fixtures from a dynamic source occasionally pass `[]` by accident.
 */
function mergeFixtures(seeded: ConformanceFixtures, explicit: ConformanceFixtures | undefined): ConformanceFixtures {
  if (!explicit || Object.keys(explicit).length === 0) return seeded;
  const merged: ConformanceFixtures = { ...seeded };
  for (const [key, pool] of Object.entries(explicit)) {
    if (pool && pool.length > 0) {
      (merged as unknown as Record<string, readonly unknown[]>)[key] = pool;
    }
  }
  return merged;
}

function hasCompactFixtures(fixtures: ConformanceFixtures): boolean {
  return [fixtures.products, fixtures.proposals, fixtures.media_buys].some(pool => pool && pool.length > 0);
}

/** @internal Exported for focused readiness-gate regression tests. */
export function toolHasConformanceFixtures(
  tool: ConformanceToolName,
  fixtures: ConformanceFixtures,
  compactMutationsEnabled = false
): boolean {
  switch (tool) {
    case 'update_media_buy':
      return hasValues(fixtures.media_buy_ids) || hasValues(fixtures.media_buys);
    case 'update_property_list':
      return hasValues(fixtures.list_ids);
    case 'update_content_standards':
      return hasValues(fixtures.standards_ids);
    case 'request_proposals':
      return compactMutationsEnabled;
    case 'refine_proposals':
      return hasValues(fixtures.proposals);
    case 'decline_proposals':
      return fixtures.proposals?.some(proposal => proposal.proposal_status !== 'accepted') === true;
    case 'buy_products':
      return hasValues(fixtures.products);
    case 'accept_proposal':
      return fixtures.proposals?.some(proposal => proposal.proposal_status === 'committed') === true;
    case 'control_media_buy':
      return hasValues(fixtures.media_buys);
    default:
      return true;
  }
}

function hasValues(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

function buildAgentClient(agentUrl: string, options: RunConformanceOptions): AgentClient {
  // Spread agentConfig FIRST so explicit keys below win. An earlier
  // version spread agentConfig last, which silently overrode
  // `auth_token` when a caller passed `agentConfig: { auth_token: ... }`
  // alongside `options.authToken`. For the cross-tenant prober that
  // meant the prober client could be built with tenant A's token
  // while the invariant reported mode: 'cross-tenant'.
  const config: AgentConfig = {
    ...options.agentConfig,
    id: options.agentConfig?.id ?? 'conformance-fuzzer',
    name: options.agentConfig?.name ?? 'AdCP Conformance Fuzzer',
    agent_uri: agentUrl,
    protocol: options.protocol ?? options.agentConfig?.protocol ?? 'mcp',
    auth_token: options.authToken ?? options.agentConfig?.auth_token,
  };
  const wireVersion = resolveWireVersion(options);
  return new AgentClient(config, wireVersion ? { adcpVersion: wireVersion } : undefined);
}

function resolveWireVersion(options: RunConformanceOptions): string | undefined {
  if (options.adcpVersion) return options.adcpVersion;
  return options.version && Number.isFinite(parseAdcpMajorVersion(options.version)) ? options.version : undefined;
}

function buildSchemaOptions(options: RunConformanceOptions): ConformanceSchemaOptions | undefined {
  if (!options.version && !options.schemaRoot) return undefined;
  return {
    ...(options.version ? { version: options.version } : {}),
    ...(options.schemaRoot ? { schemaRoot: options.schemaRoot } : {}),
  };
}

// Re-export the tool-name type so consumers don't have to dual-import.
export type { ConformanceToolName };
