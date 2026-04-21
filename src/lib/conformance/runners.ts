import fc from 'fast-check';
import type { AgentClient } from '../core/AgentClient';
import type {
  ConformanceFailure,
  ConformanceFixtures,
  ConformanceToolName,
  ConformanceToolStats,
  SkipReason,
} from './types';
import { schemaToArbitrary } from './schemaArbitrary';
import { loadRequestSchema } from './schemaLoader';
import { evaluate, prepareResponseValidator } from './oracle';

export interface RunnerOptions {
  seed: number;
  numRuns: number;
  authToken?: string;
  /** Cap per-failure serialized payload size (bytes). */
  maxFailurePayloadBytes: number;
  /** ID pools for Tier-2 fixture injection. See ConformanceFixtures. */
  fixtures?: ConformanceFixtures;
}

export interface RunnerResult {
  stats: ConformanceToolStats;
  failures: ConformanceFailure[];
}

/**
 * Fuzz a single tool against a connected agent. Uses fast-check's
 * `fc.check` for property generation + shrinking; a response that trips
 * the oracle is minimized to the smallest request that still reproduces
 * the failure before it's collected in the report.
 *
 * Returns the tool skipped when the agent declares it unsupported or when
 * the response schema can't be compiled — those aren't oracle failures,
 * they're environmental conditions.
 */
export async function runToolFuzz(
  tool: ConformanceToolName,
  agent: AgentClient,
  options: RunnerOptions
): Promise<RunnerResult> {
  // Compile the response schema up front. Ajv sometimes fails on bundled
  // schemas that still carry unresolved `$defs` refs (known upstream gap) —
  // skip the tool cleanly rather than flag every run as invalid.
  try {
    prepareResponseValidator(tool);
  } catch (err) {
    return {
      stats: skipStats('unresolvable_schema', (err as Error)?.message),
      failures: [],
    };
  }

  const schema = loadRequestSchema(tool);
  const arb = schemaToArbitrary(schema, { fixtures: options.fixtures }) as fc.Arbitrary<Record<string, unknown>>;

  // Counts only increment on fresh samples. `fc.check` re-runs the property
  // during shrinking; we don't want those replays in the accepted/rejected
  // tally. Track the minimum sample count we've seen and skip stat updates
  // on replayed samples by hashing the sample.
  const seenSamples = new Set<string>();
  const stats: ConformanceToolStats = { runs: 0, accepted: 0, rejected: 0, failed: 0, skipped: false };
  let transportUnsupported: string | null = null;

  const property = fc.asyncProperty(arb, async request => {
    const sampleKey = safeHash(request);
    const isFreshSample = !seenSamples.has(sampleKey);
    if (isFreshSample) {
      seenSamples.add(sampleKey);
      stats.runs++;
    }

    let result;
    try {
      result = await agent.executeTask(tool, request);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // SDK throws FeatureUnsupportedError when the agent's declared
      // capabilities don't list the tool. That's the agent saying "not
      // my job" — not a conformance failure.
      if ((err as Error)?.name === 'FeatureUnsupportedError' || /does not support/i.test(message)) {
        transportUnsupported = message;
        return; // pass — we'll convert the whole tool to skipped below
      }
      throw new InvariantViolation({ thrown: String(err), name: (err as Error)?.name, message }, [
        'unhandled transport error: ' + message,
      ]);
    }

    const verdict = evaluate({ tool, request, result, authToken: options.authToken });
    if (isFreshSample) {
      if (verdict.verdict === 'accepted') stats.accepted++;
      else if (verdict.verdict === 'rejected') stats.rejected++;
    }

    if (verdict.verdict === 'invalid') {
      throw new InvariantViolation(result, verdict.invariantFailures);
    }
  });

  const details = await fc.check(property, {
    seed: options.seed,
    numRuns: options.numRuns,
    verbose: 0,
  });

  if (transportUnsupported) {
    return { stats: skipStats('feature_unsupported', transportUnsupported), failures: [] };
  }

  if (!details.failed) {
    return { stats, failures: [] };
  }

  stats.failed = 1;
  const shrunkInput = (details.counterexample as [Record<string, unknown>] | null)?.[0];
  const err = details.errorInstance;
  const invariantFailures =
    err instanceof InvariantViolation
      ? err.invariantFailures
      : ['fuzz assertion failed: ' + ((err as Error | undefined)?.message ?? 'unknown')];
  const response = err instanceof InvariantViolation ? err.response : undefined;

  return {
    stats,
    failures: [
      {
        tool,
        path: details.counterexamplePath ?? undefined,
        seed: options.seed,
        shrunk: (details.numShrinks ?? 0) > 0,
        input: truncateForReport(shrunkInput, options.maxFailurePayloadBytes),
        response: truncateForReport(response, options.maxFailurePayloadBytes),
        verdict: 'invalid',
        invariantFailures,
      },
    ],
  };
}

function skipStats(reason: SkipReason, detail?: string): ConformanceToolStats {
  return {
    runs: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    skipped: true,
    skipReason: reason,
    ...(detail ? { _detail: detail } : {}),
  } as ConformanceToolStats;
}

function safeHash(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function truncateForReport(value: unknown, maxBytes: number): unknown {
  if (value === undefined || value === null) return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return { _truncated: true, _reason: 'unserializable' };
  }
  if (serialized.length <= maxBytes) return value;
  return {
    _truncated: true,
    _originalBytes: serialized.length,
    preview: serialized.slice(0, Math.max(256, maxBytes - 64)),
  };
}

class InvariantViolation extends Error {
  constructor(
    public readonly response: unknown,
    public readonly invariantFailures: string[]
  ) {
    super(invariantFailures.join('; '));
    this.name = 'InvariantViolation';
  }
}
