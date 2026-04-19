import type { HttpProbeResult, StoryboardRunOptions } from '../types';
import { gradeOneVector } from './grader';
import { parseRequestSigningStepId } from './synthesize';

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
    return skipResult(agentUrl, `request_signing_probe: step id "${stepId}" does not match positive-/negative- prefix`);
  }
  const rsOpts = options.request_signing ?? {};
  if (parsed.kind === 'negative' && parsed.vector_id === '020-rate-abuse' && rsOpts.skipRateAbuse) {
    return skipResult(agentUrl, `request_signing_probe: ${parsed.vector_id} skipped via request_signing.skipRateAbuse`);
  }
  if (rsOpts.skipVectors?.includes(parsed.vector_id)) {
    return skipResult(agentUrl, `request_signing_probe: ${parsed.vector_id} skipped via request_signing.skipVectors`);
  }
  try {
    const result = await gradeOneVector(parsed.vector_id, parsed.kind, agentUrl, {
      allowPrivateIp: options.allow_http === true,
      rateAbuseCap: rsOpts.rateAbuseCap,
    });
    const headers: Record<string, string> = {};
    if (result.actual_error_code) {
      headers['www-authenticate'] = `Signature error="${result.actual_error_code}"`;
    }
    return {
      url: agentUrl,
      status: result.http_status,
      headers,
      body: result.diagnostic ?? null,
      error: result.passed || result.skipped ? undefined : (result.diagnostic ?? 'vector grade failed'),
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

function skipResult(url: string, message: string): HttpProbeResult {
  return { url, status: 0, headers: {}, body: null, error: message };
}
