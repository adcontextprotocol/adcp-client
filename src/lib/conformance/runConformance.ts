import { AgentClient } from '../core/AgentClient';
import type { AgentConfig } from '../types';
import type {
  ConformanceFailure,
  ConformanceFixtures,
  ConformanceReport,
  ConformanceToolName,
  ConformanceToolStats,
  RunConformanceOptions,
} from './types';
import { DEFAULT_TOOLS, DEFAULT_TOOLS_WITH_UPDATES } from './types';
import { detectSchemaVersion, hasSchemas } from './schemaLoader';
import { runToolFuzz } from './runners';
import { seedFixtures, type SeedWarning } from './seeder';

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
    });
    seededFixtures = seedResult.fixtures;
    seedWarnings = seedResult.warnings;
  }
  const mergedFixtures = mergeFixtures(seededFixtures, options.fixtures);

  // Include update tools when we have at least one seeded/supplied ID
  // they can target. Fuzzing update_* with only random IDs just exercises
  // REFERENCE_NOT_FOUND, which Phase-2 get_* tools already cover.
  const haveRealIds = hasUsableFixtures(mergedFixtures);
  const defaultTools = haveRealIds ? DEFAULT_TOOLS_WITH_UPDATES : DEFAULT_TOOLS;
  const tools = options.tools ?? defaultTools;

  const agent = buildAgentClient(agentUrl, options);

  const perTool: Record<string, ConformanceToolStats> = {};
  const failures: ConformanceFailure[] = [];
  let totalRuns = 0;
  let droppedFailures = 0;

  for (const [i, tool] of tools.entries()) {
    if (!hasSchemas(tool)) {
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

  const completedAt = new Date();
  return {
    agentUrl,
    seed,
    schemaVersion: detectSchemaVersion(),
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
      (merged as Record<string, readonly string[]>)[key] = pool;
    }
  }
  return merged;
}

function hasUsableFixtures(fixtures: ConformanceFixtures): boolean {
  return Object.values(fixtures).some(pool => Array.isArray(pool) && pool.length > 0);
}

function buildAgentClient(agentUrl: string, options: RunConformanceOptions): AgentClient {
  const config: AgentConfig = {
    id: options.agentConfig?.id ?? 'conformance-fuzzer',
    name: options.agentConfig?.name ?? 'AdCP Conformance Fuzzer',
    agent_uri: agentUrl,
    protocol: options.protocol ?? options.agentConfig?.protocol ?? 'mcp',
    auth_token: options.authToken ?? options.agentConfig?.auth_token,
    ...options.agentConfig,
  };
  return new AgentClient(config);
}

// Re-export the tool-name type so consumers don't have to dual-import.
export type { ConformanceToolName };
