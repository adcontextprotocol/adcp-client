/**
 * AdCP conformance fuzzer.
 *
 * Property-based testing against an agent's published JSON schemas.
 * Import from `@adcp/client/conformance` — kept off the runtime-client
 * path so `fast-check` and the schema bundle only load when fuzzing.
 *
 * ```ts
 * import { runConformance } from '@adcp/client/conformance';
 *
 * const report = await runConformance('https://agent.example.com', {
 *   seed: 42,
 *   tools: ['get_products', 'get_signals'],
 * });
 * if (report.totalFailures > 0) {
 *   console.error(JSON.stringify(report.failures, null, 2));
 *   process.exit(1);
 * }
 * ```
 */

export { runConformance } from './runConformance';
export { seedFixtures } from './seeder';
export type { SeedOptions, SeedResult, SeederName, SeedWarning } from './seeder';
export {
  STATELESS_TIER_TOOLS,
  REFERENTIAL_STATELESS_TOOLS,
  UPDATE_TIER_TOOLS,
  DEFAULT_TOOLS,
  DEFAULT_TOOLS_WITH_UPDATES,
} from './types';
export type {
  ConformanceFailure,
  ConformanceFixtures,
  ConformanceReport,
  ConformanceToolName,
  ConformanceToolStats,
  OracleVerdict,
  RunConformanceOptions,
  SkipReason,
} from './types';
