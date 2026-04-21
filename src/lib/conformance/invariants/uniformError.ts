// Uniform error response invariant (adcp spec § error-handling).
//
// The spec MUSTs that a seller returns byte-equivalent responses for
// "the id exists but the caller lacks access" vs "the id does not
// exist" — through every observable channel (error code/message/field/
// details, HTTP status, A2A task state / MCP isError, response headers,
// latency distribution). Distinguishing the two leaks cross-tenant
// existence information.
//
// This invariant exercises the MUST with a paired probe: two requests
// to the same tool, compared byte-for-byte.
//
// Pairing modes:
//   - baseline: two fresh UUIDs, single auth token. Catches id-echo
//     leaks, header divergence, and grossly different latency. Does
//     not catch cross-tenant leaks — both ids are impossible, so the
//     "inaccessible vs unknown" branch never fires.
//   - cross-tenant: one seeded id owned by tenant A plus one fresh
//     UUID, both probed as tenant B. Catches the full MUST.
//
// Tool coverage is keyed by TOOL_ID_CONFIG below. A tool must expose
// a single scalar "lookup id" field and have a matching seeder before
// it can be probed.

import { AgentClient } from '../../core/AgentClient';
import { randomUUID } from 'node:crypto';
import { withRawResponseCapture, type RawHttpCapture } from '../../protocols/rawResponseCapture';
import type { ConformanceFixtures, ConformanceToolName } from '../types';
import { compareProbes, type ProbeComparisonResult } from './uniformErrorComparator';

export type UniformErrorVerdict = 'pass' | 'fail' | 'skipped';

export interface UniformErrorReport {
  tool: ConformanceToolName;
  /** Which pairing actually ran. */
  mode: 'baseline' | 'cross-tenant';
  verdict: UniformErrorVerdict;
  /** Populated on verdict === 'skipped'. */
  skipReason?: string;
  /** Populated on verdict !== 'skipped'. */
  differences?: string[];
  /** Probe summaries for diagnostics. Sanitized via `summarizeCapture`. */
  probes?: {
    inaccessibleOrRandomA: ProbeSummary;
    impossibleOrRandomB: ProbeSummary;
  };
}

export interface ProbeSummary {
  /** Label describing what kind of id was probed. */
  label: 'cross-tenant' | 'impossible' | 'random-a' | 'random-b';
  status: number | null;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
  /** Whether the capture body was truncated. */
  bodyTruncated: boolean;
}

/**
 * Per-tool configuration for the invariant. Each tool that can be
 * probed declares:
 *  - the single id field to mutate
 *  - the fixture key that holds a seeded id (for cross-tenant mode)
 *  - a minimal request builder given the id
 *
 * Extending coverage to more tools is additive — populate a new entry.
 */
interface ToolIdConfig {
  idField: string;
  fixtureKey: keyof ConformanceFixtures;
  buildRequest: (id: string) => Record<string, unknown>;
}

const TOOL_ID_CONFIG: Partial<Record<ConformanceToolName, ToolIdConfig>> = {
  get_property_list: {
    idField: 'list_id',
    fixtureKey: 'list_ids',
    buildRequest: (id) => ({ list_id: id }),
  },
  get_content_standards: {
    idField: 'standards_id',
    fixtureKey: 'standards_ids',
    buildRequest: (id) => ({ standards_id: id }),
  },
  get_media_buy_delivery: {
    idField: 'media_buy_id',
    fixtureKey: 'media_buy_ids',
    buildRequest: (id) => {
      // Spec-min request: one buy id + a date range wide enough to avoid
      // per-seller reporting-window rejection. Dates are arbitrary — the
      // resolution happens before access-check per the spec, so the
      // response must be byte-equivalent regardless of window.
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
      const end = new Date(now.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
      return { media_buy_ids: [id], start_date: start, end_date: end };
    },
  },
  get_creative_delivery: {
    idField: 'creative_id',
    fixtureKey: 'creative_ids',
    buildRequest: (id) => {
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
      const end = new Date(now.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
      return { creative_ids: [id], start_date: start, end_date: end };
    },
  },
  tasks_get: {
    idField: 'task_id',
    fixtureKey: 'task_ids',
    buildRequest: (id) => ({ task_id: id }),
  },
};

/** Tools eligible for the uniform-error probe. Used by the runner wiring. */
export function toolsEligibleForUniformError(): ConformanceToolName[] {
  return Object.keys(TOOL_ID_CONFIG) as ConformanceToolName[];
}

export interface ProbeOptions {
  /** Agent client that probes with the "caller" credentials (tenant B in cross-tenant mode). */
  prober: AgentClient;
  /** Fixtures accumulated so far — drawn from for cross-tenant mode. */
  fixtures: ConformanceFixtures;
  /** Whether a distinct cross-tenant token was configured. When false, mode is 'baseline'. */
  crossTenantConfigured: boolean;
  /**
   * Cap individual probe body size in the capture. Defaults to the
   * rawResponseCapture default. Not usually worth overriding.
   */
  maxBodyBytes?: number;
}

export async function runUniformErrorInvariant(
  tool: ConformanceToolName,
  options: ProbeOptions
): Promise<UniformErrorReport> {
  const config = TOOL_ID_CONFIG[tool];
  if (!config) {
    return {
      tool,
      mode: options.crossTenantConfigured ? 'cross-tenant' : 'baseline',
      verdict: 'skipped',
      skipReason: 'tool not in TOOL_ID_CONFIG',
    };
  }

  // Resolve the pair of ids under probe.
  //
  // Cross-tenant mode needs a seeded id (tenant A owns the resource;
  // tenant B is probing it — that's the "exists but inaccessible" leg).
  // Missing seeded id → fall back to baseline rather than skipping; the
  // baseline still catches id-echo and header-divergence leaks.
  const seededPool = options.fixtures[config.fixtureKey] ?? [];
  const seededId = seededPool[0];
  const mode: UniformErrorReport['mode'] =
    options.crossTenantConfigured && seededId ? 'cross-tenant' : 'baseline';

  const idA = mode === 'cross-tenant' ? (seededId as string) : randomUUID();
  const idB = randomUUID();
  const labelA: ProbeSummary['label'] = mode === 'cross-tenant' ? 'cross-tenant' : 'random-a';
  const labelB: ProbeSummary['label'] = mode === 'cross-tenant' ? 'impossible' : 'random-b';

  const captureOpts = { maxBodyBytes: options.maxBodyBytes };

  const probeA = await capturedProbe(options.prober, tool, config.buildRequest(idA), captureOpts);
  const probeB = await capturedProbe(options.prober, tool, config.buildRequest(idB), captureOpts);

  if (!probeA.capture || !probeB.capture) {
    // One side didn't produce a capture — the underlying transport
    // surfaced an error before we could observe the response (e.g.,
    // the SDK threw an AuthenticationRequiredError). Report the root
    // cause so the operator knows why the invariant skipped.
    const reason = probeA.error ?? probeB.error ?? 'no capture observed';
    return {
      tool,
      mode,
      verdict: 'skipped',
      skipReason: `probe did not produce a raw capture (${reason})`,
    };
  }

  const comparison = compareProbes(probeA.capture, probeB.capture);

  return {
    tool,
    mode,
    verdict: comparison.equivalent ? 'pass' : 'fail',
    differences: comparison.differences,
    probes: {
      inaccessibleOrRandomA: summarizeCapture(probeA.capture, labelA),
      impossibleOrRandomB: summarizeCapture(probeB.capture, labelB),
    },
  };
}

interface ProbeOutcome {
  capture?: RawHttpCapture;
  /** Error message when executeTask threw before producing a capture. */
  error?: string;
}

/**
 * Execute a probe inside a capture context and return the tool-call
 * response. Filters captures to POST — MCP's tool call and A2A's
 * `sendMessage` are both POSTs, while A2A's `/.well-known/agent.json`
 * discovery (issued on a fresh client) is a GET that we must not
 * confuse with the tool response.
 */
async function capturedProbe(
  agent: AgentClient,
  tool: ConformanceToolName,
  request: Record<string, unknown>,
  options: { maxBodyBytes?: number }
): Promise<ProbeOutcome> {
  try {
    const { captures } = await withRawResponseCapture(
      async () => {
        await agent.executeTask(tool, request);
      },
      options
    );
    const toolCallCapture = lastPostCapture(captures);
    if (!toolCallCapture) {
      return { error: 'captured only non-POST traffic' };
    }
    return { capture: toolCallCapture };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function lastPostCapture(captures: readonly RawHttpCapture[]): RawHttpCapture | undefined {
  for (let i = captures.length - 1; i >= 0; i--) {
    const cap = captures[i];
    if (cap && cap.method === 'POST') return cap;
  }
  return undefined;
}

function summarizeCapture(cap: RawHttpCapture, label: ProbeSummary['label']): ProbeSummary {
  return {
    label,
    status: cap.status,
    headers: cap.headers,
    body: cap.body,
    latencyMs: cap.latencyMs,
    bodyTruncated: cap.bodyTruncated,
  };
}
