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
 *
 * On an A2A run the vectors are framed as A2A: dispatching them as MCP sends
 * an `initialize` with MCP framing and MCP version headers to an A2A endpoint,
 * which answers 405, so every vector errors in the precondition before one is
 * graded. An explicit `transport` still wins — that is the escape hatch for an
 * agent whose MCP or REST binding answers on the same URL as its A2A card.
 */
export function resolveVectorTransport(
  rsOpts: { transport?: 'raw' | 'mcp' | 'a2a' },
  protocol?: 'mcp' | 'a2a'
): 'raw' | 'mcp' | 'a2a' {
  if (rsOpts.transport) return rsOpts.transport;
  return protocol === 'a2a' ? 'a2a' : 'mcp';
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
      const loaded = loadRequestSigningVectors({
        version: options.adcpVersion,
        complianceDir: options.complianceDir,
      });
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
      ...(options.adcpVersion && { version: options.adcpVersion }),
      ...(options.complianceDir && { complianceDir: options.complianceDir }),
      allowPrivateIp: options.allow_http === true,
      rateAbuseCap: rsOpts.rateAbuseCap,
      allowLiveSideEffects: rsOpts.allowLiveSideEffects,
      onlyVectors: rsOpts.onlyVectors,
      skipVectors: rsOpts.skipVectors,
      skipRateAbuse: rsOpts.skipRateAbuse,
      transport: resolveVectorTransport(rsOpts, options.protocol),
      // The auto-initialize handshake authenticates like any MCP client;
      // agents commonly require auth on `initialize` (the signed vectors
      // themselves stay bearer-less — the signature is their auth).
      ...(options.auth?.type === 'bearer' && options.auth.token
        ? { initializeHeaders: { authorization: `Bearer ${options.auth.token}` } }
        : {}),
      mcpSessionId: rsOpts.mcpSessionId,
      mcpProtocolVersion: rsOpts.mcpProtocolVersion,
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
