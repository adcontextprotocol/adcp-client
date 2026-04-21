import { AgentClient } from '../core/AgentClient';
import type { AgentConfig } from '../types';
import type { ConformanceFailure, ConformanceReport, ConformanceToolStats, RunConformanceOptions } from './types';
import { STATELESS_TIER_TOOLS } from './types';
import { detectSchemaVersion, hasSchemas } from './schemaLoader';
import { runToolFuzz } from './runners';

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_MAX_FAILURE_PAYLOAD_BYTES = 8192;
const MIN_FAILURE_PAYLOAD_BYTES = 256;

/**
 * Fuzz an AdCP agent against its published JSON schemas.
 *
 * Generates schema-valid requests for each tool in the stateless tier,
 * calls the agent, and checks each response against the two-path oracle:
 * responses that validate the response schema pass; responses that return
 * a valid AdCP error envelope with a spec-enum reason code also pass.
 */
export async function runConformance(
  agentUrl: string,
  options: RunConformanceOptions = {}
): Promise<ConformanceReport> {
  const startedAt = new Date();
  const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const tools = options.tools ?? STATELESS_TIER_TOOLS;
  const turnBudget = options.turnBudget ?? 50;
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const maxFailurePayloadBytes = Math.max(
    MIN_FAILURE_PAYLOAD_BYTES,
    options.maxFailurePayloadBytes ?? DEFAULT_MAX_FAILURE_PAYLOAD_BYTES
  );

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
