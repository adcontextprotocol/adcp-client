import { basename, dirname } from 'path';
import type { HttpProbeResult, RunnerDetailedSkipReason, StoryboardRunOptions } from '../types';
import type { NegativeVector, PositiveVector, VerifierCapabilityFixture } from './types';
import { gradeOneVector, semanticVectorExclusion } from './grader';
import { parseRequestSigningStepId } from './synthesize';
import { loadRequestSigningVectors } from './vector-loader';
import { ADCP_VERSION } from '../../../version';

/**
 * Detail surfaced on each vector step an A2A run cannot frame. Written for
 * the operator reading a conformance report: it has to say what coverage is
 * missing and what would restore it.
 *
 * Reported as detailed reason `signing_transport_unavailable`, canonical
 * `not_applicable` with the sub-reason token as `skip.detail` — the output
 * contract's registered shape. What keeps the gap from reading as a pass is
 * `signingCoverage` in the runner, not the reason: no vector reached the
 * agent, so the storyboard cannot pass and the track grades `partial`
 * instead of letting a sibling storyboard's passes roll it up green.
 */
export const SIGNING_VECTORS_UNAVAILABLE_DETAIL =
  'Coverage unavailable: this runner dispatches request-signing vectors two ways — a verbatim replay of ' +
  "the vector's recorded REST request (`raw`), or the same body re-framed as an MCP `tools/call` envelope " +
  '(`mcp`) — and it does not yet dispatch them through the official A2A client, so nothing about this ' +
  "agent's verifier was graded on this run (adcontextprotocol/adcp-client#2954). Remedy: grade the " +
  "verifier through the agent's MCP or REST binding, or set `request_signing.transport` (CLI " +
  '`--signing-transport`) when that binding answers at this same URL.';

/**
 * Resolve the vector transport for a graded agent.
 *
 * Defaults to `'mcp'`: the storyboard runner reaches MCP agents through
 * `tools/call` — never through per-task HTTP paths — so replaying the
 * vectors' recorded REST targets (`/adcp/create_media_buy`, raw task body)
 * verbatim guarantees a routing 404 on every MCP-transport agent before its
 * verifier can run (adcontextprotocol/adcp#6548). Operators grading a
 * REST-binding agent opt back in with `request_signing.transport: 'raw'`.
 *
 * Returns `undefined` on an A2A run that didn't pick a transport explicitly:
 * neither dispatch shape this runner implements is an A2A request, so the
 * caller skips those vectors as `signing_transport_unavailable` instead of
 * POSTing an MCP envelope at an A2A
 * endpoint and grading the resulting 405 as a signature failure
 * (adcp-client#2954). An explicit `transport` still wins — that's the escape
 * hatch for an agent whose MCP or REST binding answers on the same URL as its
 * A2A card.
 *
 * Still `undefined` for an A2A run, and deliberately so: whether A2A vectors
 * can be dispatched depends on whether the agent's CARD resolves to a JSONRPC
 * interface, which is a network question this synchronous resolver cannot
 * answer. The decision moved one level up, into `probeRequestSigningVector`,
 * which attempts the official-client precondition and only then frames. An
 * agent whose card does not resolve keeps the `signing_transport_unavailable`
 * reporting this function was written for — that path is a genuine fallback
 * now rather than the only outcome.
 */
export function resolveVectorTransport(
  rsOpts: { transport?: 'raw' | 'mcp' | 'a2a' },
  protocol?: 'mcp' | 'a2a'
): 'raw' | 'mcp' | 'a2a' | undefined {
  if (rsOpts.transport) return rsOpts.transport;
  if (protocol === 'a2a') return undefined;
  return 'mcp';
}

/**
 * Dispatch a synthesized request-signing step. The step ID encodes the vector
 * (`positive-<id>` / `negative-<id>`); this helper decodes it, runs the
 * grader's per-vector logic, and maps the `VectorGradeResult` to an
 * `HttpProbeResult`-shaped return so the HTTP validation pipeline
 * (`http_status`, `http_status_in`) works unchanged for probed vectors.
 *
 * Vectors the grader decides in-library rather than over HTTP (the
 * `jwks_override` negatives) carry `http_status: 0` by contract — there is no
 * wire exchange to report. Their verdict travels on `error`: unset when the
 * library verifier produced the expected rejection, set to the grader's
 * diagnostic otherwise. `synthesizeNegativeStep` pairs those vectors with a
 * `probe_passed` validation that reads exactly that field; asserting an HTTP
 * status against them would compare a grade to a status code that no
 * implementation can move (adcp-client#2955).
 */

/**
 * Whether the official A2A client can dispatch against *agentUrl*.
 *
 * Memoized per agent URL: the answer is a property of the agent's published
 * card, and a 40-vector run must not re-fetch it 40 times. A failure is cached
 * too — an agent that published no JSONRPC interface will not grow one
 * mid-run, and retrying would turn one coverage gap into forty timeouts.
 */
const a2aAvailability = new Map<string, Promise<boolean>>();

function a2aDispatchAvailable(agentUrl: string): Promise<boolean> {
  const cached = a2aAvailability.get(agentUrl);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const { resolveA2aDispatchTarget } = await import('./a2a-dispatch');
      await resolveA2aDispatchTarget(agentUrl);
      return true;
    } catch {
      return false;
    }
  })();
  a2aAvailability.set(agentUrl, probe);
  return probe;
}

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
  let transport = resolveVectorTransport(rsOpts, options.protocol);
  // Operator selection first, in the grader's own precedence (`onlyVectors`
  // over `skipVectors`, per `preflightSkip`). A vector the operator never
  // selected is out of scope — reporting it as a coverage gap would
  // manufacture one, inflating the run's unavailable count and dragging the
  // track to `partial` over vectors nobody asked to grade (adcp-client#2954).
  if (rsOpts.onlyVectors && !rsOpts.onlyVectors.includes(parsed.vector_id)) {
    return skipProbe(agentUrl, 'not_in_only_vectors');
  }
  if (rsOpts.skipVectors?.includes(parsed.vector_id)) {
    return skipProbe(agentUrl, 'operator_skip');
  }
  // Resolve the vector so every decision below reads the vector's own fields
  // rather than a hardcoded id — that keeps the dispatch honest across
  // upstream renames. The loader memoizes per compliance dir, so this is the
  // same parse the grader reuses.
  //
  // A failed load is a runner fault, not a coverage decision. Swallowing it
  // (the previous behavior) left the transport gate below to report a broken
  // vector cache as `signing_transport_unavailable` — wrong, and skip-shaped,
  // so it could never fail a run. Surface it as a probe error instead.
  let loaded: ReturnType<typeof loadRequestSigningVectors>;
  try {
    loaded = loadRequestSigningVectors({
      version: options.adcpVersion,
      complianceDir: options.complianceDir,
    });
  } catch (err) {
    return probeError(
      agentUrl,
      `request_signing_probe: could not load request-signing vectors: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const vector: PositiveVector | NegativeVector | undefined =
    parsed.kind === 'negative'
      ? loaded.negative.find(v => v.id === parsed.vector_id)
      : loaded.positive.find(v => v.id === parsed.vector_id);
  if (!vector) {
    // Synthesis and dispatch read the same vector set, so a miss means the two
    // disagree (version/complianceDir drift, upstream rename). Same class as a
    // load failure: report it, don't launder it into a skip.
    return probeError(
      agentUrl,
      `request_signing_probe: ${parsed.kind} vector "${parsed.vector_id}" is not in the vector set this run loaded`
    );
  }
  // Semantic exclusions next, before anything protocol-specific. A vector the
  // grader refuses on the vector's own terms — outside the agent's declared
  // verifier profile, or ungradable over HTTP on any binding — is refused
  // identically whatever protocol this run speaks, so it must report the same
  // skip on an A2A run as on an MCP one. Gating on protocol first would
  // relabel a permanent exclusion as this run's missing coverage and drag the
  // track to `partial` over vectors that were never in scope
  // (adcp-client#2954). A vector that *is* in scope still reports the gap at
  // the transport gate below.
  const semantic = semanticVectorExclusion(vector, declaredProtocolMethodCoverage(options, loaded.sourceDir));
  if (semantic) {
    // Carry the grader's diagnostic. It names the vector's unmet demand (the
    // method, the profile dimension), which is what lets an operator audit an
    // agent that under-declares to dodge a vector; the generic fallback text
    // says "profile selected for this run", misattributing an
    // agent-declaration exclusion to an operator choice. Library constants
    // and fixture-derived names only — no agent-supplied text.
    return skipProbe(agentUrl, semantic.skip_reason, semantic.diagnostic);
  }
  if (
    parsed.kind === 'negative' &&
    rsOpts.skipRateAbuse &&
    (vector as NegativeVector).requires_contract === 'rate_abuse'
  ) {
    return skipProbe(agentUrl, 'rate_abuse_opt_out');
  }
  // This run has no dispatch shape for the vectors (A2A, no explicit
  // override). Skip before any network work and report the gap as missing
  // coverage, not as agent inapplicability — but only for the vectors that
  // actually need a wire exchange.
  // The A2A decision, made where the network can be reached. `resolveVectorTransport`
  // cannot answer it: whether these vectors are dispatchable over A2A depends on the
  // agent's CARD resolving to a JSONRPC interface, and that is a fetch.
  //
  // When it resolves, the official `@a2a-js/sdk` client dispatches the vectors and the
  // coverage gap closes. When it does not, nothing is framed on a guess and the vector
  // keeps the `signing_transport_unavailable` reporting #2958 built — which is why that
  // path and its guardrails stay exactly as they are.
  if (!transport && options.protocol === 'a2a' && !gradableWithoutVectorTransport(parsed.kind, vector)) {
    if (await a2aDispatchAvailable(agentUrl)) transport = 'a2a';
  }
  if (!transport && !gradableWithoutVectorTransport(parsed.kind, vector)) {
    return skipProbe(agentUrl, 'signing_transport_unavailable', SIGNING_VECTORS_UNAVAILABLE_DETAIL);
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
      // A vector reaching here without a resolved transport is in-library
      // only (`gradableWithoutVectorTransport`); the grader never probes it,
      // so the value is inert.
      transport: transport ?? 'mcp',
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
      // Carry the grader's transport-fault provenance through. Without it a
      // DNS or connect failure reaches the coverage classifier looking like
      // an in-library grade — `status: 0` with text — and the report tells
      // the operator only the SDK self-check ran, which is false and points
      // them away from the connection they need to fix.
      ...(result.transport_error === true && { probe_error: true }),
    };
  } catch (err) {
    // Transport and precondition failures (MCP initialize, DNS, SSRF guard)
    // land here; they are runner-owned, not a verdict about the agent.
    return probeError(agentUrl, `request_signing_probe threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Whether a vector still grades when the run has no vector transport.
 *
 * Only the `jwks_override` negatives qualify, and the condition mirrors the
 * grader's own `requiresNetworkProbe`: the grader decides them against the
 * library verifier with no HTTP exchange at all, so the run's protocol is
 * irrelevant to them. Everything else — including the protocol-method
 * negatives such as `028-unsigned-protocol-method-required`, whose bodies are
 * already complete JSON-RPC envelopes — needs a request to actually reach the
 * agent, and this runner has no A2A dispatch to send one with. Writing a
 * vector's bytes at an A2A endpoint would mean choosing an A2A signing
 * binding that AdCP has not defined — the SDK inventing protocol. The
 * supported answer is to sign a request issued by the official
 * `@a2a-js/sdk` client, which is not wired here yet. Until it is, those
 * vectors report the coverage gap.
 */
function gradableWithoutVectorTransport(
  kind: 'positive' | 'negative',
  vector: PositiveVector | NegativeVector
): boolean {
  return kind === 'negative' && (vector as NegativeVector).jwks_override !== undefined;
}

/**
 * The one capability dimension this runner reads off the agent's own
 * advertisement: `protocol_methods_required_for` (adcp#4326).
 *
 * Scoped to that field on purpose, in two directions.
 *
 * It does not read the rest of the block, because the rest of a vector's
 * `verifier_capability` describes an operator-selected grading profile
 * rather than an advertisement — comparing those dimensions to a live
 * declaration excludes 39 of 40 vectors for a permissive block, which would
 * let an agent switch the storyboard off by under-declaring.
 *
 * And it does not require the rest of the block to be present. The
 * capabilities schema requires only `supported` under `request_signing`
 * (`covers_content_digest` is conditionally required from AdCP 3.2, and
 * `required_for` never is), so demanding them would make a schema-legal
 * `{ supported: true }` agent miss the exclusion and FAIL vector 028 — the
 * inverse of what `compliance/{version}/universal/signed-requests.yaml`
 * specifies: "the runner skips when the agent does not declare the bucket,
 * and FAILs (not SKIPs) when it declares it but doesn't enforce".
 *
 * Absent and malformed stay different answers. Absent is the spec-defined
 * gate — the agent did not claim the bucket, so the vector is out of scope.
 * Malformed (a bare string, a mixed array) is not evidence of anything, and
 * reading it as absent would let a bad block shrink graded coverage, so the
 * declaration is discarded and the vector graded.
 */
function declaredProtocolMethodCoverage(
  options: StoryboardRunOptions,
  sourceDir: string
): Pick<VerifierCapabilityFixture, 'protocol_methods_required_for'> | undefined {
  const raw = options._profile?.raw_capabilities;
  if (!raw || typeof raw !== 'object') return undefined;
  const block = (raw as { request_signing?: unknown }).request_signing;
  if (!block || typeof block !== 'object') return undefined;
  const declared = block as Record<string, unknown>;
  // An agent that does not claim support is not graded against this
  // storyboard at all (the `request_signer` requirement gate), so a block
  // without `supported: true` carries no applicability signal worth reading.
  if (declared.supported !== true) return undefined;
  const bucket = declaredProtocolMethods(
    declared.protocol_methods_required_for,
    protocolMethodGrammarFor(complianceLineOf(sourceDir) ?? options.adcpVersion ?? ADCP_VERSION)
  );
  if (!bucket.ok) return undefined;
  return { ...(bucket.value && { protocol_methods_required_for: bucket.value }) };
}

/**
 * The AdCP line a resolved compliance cache directory belongs to, e.g.
 * `3.1.18` for `<root>/compliance/cache/3.1.18/test-vectors/request-signing`.
 *
 * Read from the directory the vectors actually loaded from rather than from
 * `options.adcpVersion`, so a run pointed at a cache with `--compliance-dir`
 * is validated against that cache's own grammar. Returns `undefined` for a
 * path that is not version-shaped (a bespoke fixture root), and the caller
 * falls back to the run's declared version.
 */
function complianceLineOf(sourceDir: string): string | undefined {
  const version = basename(dirname(dirname(sourceDir)));
  return /^\d+\.\d+/.test(version) ? version : undefined;
}

/**
 * Read a declared `protocol_methods_required_for` bucket, fail-closed.
 *
 *   - absent (`undefined`) → `{ ok: true }`, the spec-defined gate: the agent
 *     did not claim the bucket, so a protocol-method vector is out of scope.
 *   - a schema-valid array, `[]` included → `{ ok: true, value }`.
 *   - anything else → `{ ok: false }`: the declaration is discarded and the
 *     vector graded.
 *
 * `null`, a bare string, a number, a non-string entry, an empty or
 * whitespace-bearing token, an over-long one, a name outside the line's
 * wire-name grammar, and (from 3.2) the forbidden `tools/call` all land in
 * the last bucket. None of them is evidence that the agent did not claim the
 * method, and reading them as absence is a suppression: a server that accepts
 * an unsigned `tasks/cancel` could publish `protocol_methods_required_for:
 * null` — or `[""]`, or `["tasks/cancel "]` — and have vector 028 excluded,
 * reporting `overall_passed: true` and exit 0 with the vector never
 * dispatched.
 */
function declaredProtocolMethods(
  value: unknown,
  isValidToken: (token: string) => boolean
): { ok: true; value?: string[] } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false };
  return value.every(entry => typeof entry === 'string' && isValidToken(entry))
    ? { ok: true, value: value as string[] }
    : { ok: false };
}

/**
 * Wire-name grammar for `request_signing.protocol_methods_*`, mirroring the
 * `items` constraint the capabilities schema ships for each AdCP line:
 *
 *   - 3.2+ — slash paths of one or more segments (`tasks/cancel`,
 *     `tasks/pushNotificationConfig/set`) or A2A 1.0 PascalCase names
 *     (`CancelTask`), 256 characters max, and never `tools/call`.
 *   - pre-3.2 — a single lowercase slash pair (`tasks/cancel`), with no
 *     length cap, because that line's schema declares none.
 *
 * Keyed by line rather than taking the union of both, because the union is
 * unsafe in one direction: honouring a 3.2-only name on a 3.1 run accepts a
 * declaration that line's schema rejects, and any accepted declaration
 * omitting the vector's method suppresses that vector.
 *
 * Pinned against both shipped schemas by test — a grammar that drifts wider
 * than the schema re-opens exactly that hole.
 */
export const PROTOCOL_METHOD_GRAMMARS = {
  since_3_2: {
    pattern: /^(?:[a-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)+|[A-Z][A-Za-z0-9_]*)$/,
    maxLength: 256 as number | undefined,
    forbidden: ['tools/call'] as readonly string[],
  },
  // 3.1 declares no `maxLength`, so imposing one would reject a name that
  // line's schema accepts — and a rejected declaration is graded, which
  // fails a vector the agent never claimed. Each line matches its own schema.
  pre_3_2: {
    pattern: /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/,
    maxLength: undefined as number | undefined,
    forbidden: [] as readonly string[],
  },
} as const;

/** Token validator for an AdCP version string, per `PROTOCOL_METHOD_GRAMMARS`. */
export function protocolMethodGrammarFor(version: string): (token: string) => boolean {
  const trimmed = version.startsWith('v') ? version.slice(1) : version;
  const match = /^(\d+)(?:\.(\d+))?/.exec(trimmed);
  const major = Number.parseInt(match?.[1] ?? '0', 10);
  const minor = Number.parseInt(match?.[2] ?? '0', 10);
  const grammar =
    major > 3 || (major === 3 && minor >= 2) ? PROTOCOL_METHOD_GRAMMARS.since_3_2 : PROTOCOL_METHOD_GRAMMARS.pre_3_2;
  return token =>
    (grammar.maxLength === undefined || token.length <= grammar.maxLength) &&
    grammar.pattern.test(token) &&
    !grammar.forbidden.includes(token);
}

/**
 * A probe that could not run for a reason the runner owns. Deliberately not a
 * skip: skips are pass-shaped, and a runner fault must fail the step rather
 * than quietly subtract it from the graded set.
 */
function probeError(url: string, message: string): HttpProbeResult {
  // `probe_error` separates this from an in-library grade that failed: both
  // report `status: 0` with an `error`, and only one of them is a verdict.
  return { url, status: 0, headers: {}, body: null, error: message, probe_error: true };
}

function skipProbe(url: string, reason: RunnerDetailedSkipReason, detail?: string): HttpProbeResult {
  // The runner builds `skip.detail` from `CANONICAL_SKIP_DETAILS[reason] ??
  // error ?? …`, so a supplied detail is what the operator reads — as long as
  // the reason has no entry in that contract-mandated map. Add one there and
  // this argument stops being visible.
  return {
    url,
    status: 0,
    headers: {},
    body: null,
    skipped: true,
    skip_reason: reason,
    ...(detail && { error: detail }),
  };
}
