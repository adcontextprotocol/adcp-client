import type { HttpProbeResult, RunnerDetailedSkipReason, StoryboardRunOptions } from '../types';
import { gradeOneVector } from './grader';
import { parseRequestSigningStepId } from './synthesize';
import { loadRequestSigningVectors } from './vector-loader';

/**
 * Resolve the vector transport for a graded agent. Defaults to `'mcp'`: the
 * storyboard runner reaches agents through `tools/call` (MCP, or the
 * AdCP-over-A2A binding) — never through per-task HTTP paths — so replaying
 * the vectors' recorded REST targets (`/adcp/create_media_buy`, raw task
 * body) verbatim guarantees a routing 404 on every MCP-transport agent
 * before its verifier can run (adcontextprotocol/adcp#6548). Operators
 * grading a REST-binding agent opt back in with
 * `request_signing.transport: 'raw'`.
 */
export function resolveVectorTransport(rsOpts: { transport?: 'raw' | 'mcp' }): 'raw' | 'mcp' {
  return rsOpts.transport ?? 'mcp';
}

/**
 * Dispatch a synthesized request-signing step. The step ID encodes the vector
 * (`positive-<id>` / `negative-<id>`); this helper decodes it, runs the
 * grader's per-vector logic, and maps the `VectorGradeResult` to an
 * `HttpProbeResult`-shaped return so the existing validation pipeline
 * (`http_status`, `http_status_in`) works unchanged.
 */
export async function probeRequestSigningVector(
  stepId: string,
  agentUrl: string,
  options: StoryboardRunOptions
): Promise<HttpProbeResult> {
  const parsed = parseRequestSigningStepId(stepId);
  if (!parsed) {
    return {
      url: agentUrl,
      status: 0,
      headers: {},
      body: null,
      error: `request_signing_probe: step id "${stepId}" does not match positive-/negative- prefix`,
    };
  }
  const rsOpts = options.request_signing ?? {};
  // Vector-id lookup so we skip by the vector's `requires_contract`, not by
  // hardcoded vector id. Keeps the dispatch resilient to upstream renames.
  if (parsed.kind === 'negative' && rsOpts.skipRateAbuse) {
    try {
      const loaded = loadRequestSigningVectors();
      const vector = loaded.negative.find(v => v.id === parsed.vector_id);
      if (vector?.requires_contract === 'rate_abuse') {
        return skipProbe(agentUrl, 'rate_abuse_opt_out');
      }
    } catch {
      // fall through — surfaces as a grader error below
    }
  }
  if (rsOpts.skipVectors?.includes(parsed.vector_id)) {
    return skipProbe(agentUrl, 'operator_skip');
  }
  try {
    const result = await gradeOneVector(parsed.vector_id, parsed.kind, agentUrl, {
      allowPrivateIp: options.allow_http === true,
      rateAbuseCap: rsOpts.rateAbuseCap,
      allowLiveSideEffects: rsOpts.allowLiveSideEffects,
      onlyVectors: rsOpts.onlyVectors,
      skipVectors: rsOpts.skipVectors,
      skipRateAbuse: rsOpts.skipRateAbuse,
      transport: resolveVectorTransport(rsOpts),
      mcpSessionId: rsOpts.mcpSessionId,
    });
    if (result.skipped) {
      return skipProbe(agentUrl, (result.skip_reason as RunnerDetailedSkipReason | undefined) ?? 'grader_skipped');
    }
    const headers: Record<string, string> = {};
    if (result.actual_error_code) {
      headers['www-authenticate'] = `Signature error="${result.actual_error_code}"`;
    }
    return {
      url: agentUrl,
      status: result.http_status,
      headers,
      body: result.diagnostic ?? null,
      error: result.passed ? undefined : (result.diagnostic ?? 'vector grade failed'),
    };
  } catch (err) {
    return {
      url: agentUrl,
      status: 0,
      headers: {},
      body: null,
      error: `request_signing_probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function skipProbe(url: string, reason: RunnerDetailedSkipReason): HttpProbeResult {
  return { url, status: 0, headers: {}, body: null, skipped: true, skip_reason: reason };
}
