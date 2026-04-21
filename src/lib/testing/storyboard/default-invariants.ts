/**
 * Default assertion registrations for invariant ids that upstream storyboards
 * reference but that every SDK consumer would otherwise have to implement
 * themselves. Importing this module side-registers the ids below, so
 * `resolveAssertions` doesn't throw on fresh `@adcp/client` installs.
 *
 * The implementations aim for the spec's stated intent, not byte-perfect
 * fidelity with the upstream reference. Consumers can override by calling
 * `clearAssertionRegistry()` then re-registering with their own spec.
 *
 * Registered ids:
 *   - `idempotency.conflict_no_payload_leak` — when a mutating step returns
 *     `IDEMPOTENCY_CONFLICT`, the error must not echo the prior request's
 *     payload or response (stolen-key read oracle). We scan error envelopes
 *     for fields that look like leaked payload / identifiers.
 *   - `context.no_secret_echo` — the echoed `context` object on any step
 *     must not contain any bearer token, API key, or auth header value
 *     supplied in the options. Scan recursively.
 */

import { registerAssertion } from './assertions';

// Register only once per process. `registerAssertion` throws on duplicates —
// consumers who import `@adcp/client/testing` multiple times would hit that.
const REGISTERED = new Set<string>();

function registerOnce(id: string, spec: Parameters<typeof registerAssertion>[0]): void {
  if (REGISTERED.has(id)) return;
  REGISTERED.add(id);
  registerAssertion(spec);
}

// Tokens indicative of leaked payload on an IDEMPOTENCY_CONFLICT error.
const CONFLICT_LEAK_FIELDS = ['payload', 'stored_payload', 'request_body', 'original_request', 'original_response'];

registerOnce('idempotency.conflict_no_payload_leak', {
  id: 'idempotency.conflict_no_payload_leak',
  description:
    'IDEMPOTENCY_CONFLICT errors MUST NOT echo the prior request payload or response (stolen-key read oracle).',
  onStep: (_ctx, stepResult) => {
    const err = extractAdcpError(stepResult);
    if (!err) return [];
    if (err.code !== 'IDEMPOTENCY_CONFLICT') return [];

    const findings: Omit<import('./types').AssertionResult, 'assertion_id' | 'scope'>[] = [];
    const description = 'IDEMPOTENCY_CONFLICT error redacts prior payload';
    for (const field of CONFLICT_LEAK_FIELDS) {
      if (field in err.details) {
        findings.push({
          passed: false,
          description,
          step_id: stepResult.step_id,
          error: `IDEMPOTENCY_CONFLICT error leaked field "${field}" — must redact prior payload.`,
        });
      }
    }
    if (findings.length === 0) {
      findings.push({ passed: true, description, step_id: stepResult.step_id });
    }
    return findings;
  },
});

registerOnce('context.no_secret_echo', {
  id: 'context.no_secret_echo',
  description: 'Echoed context MUST NOT contain bearer tokens, API keys, or auth header values.',
  onStart: ctx => {
    // Stash the sensitive values we know about. Options.auth_token is the
    // primary one; consumers can extend via options.secrets if they want.
    const secrets = new Set<string>();
    const optAny = ctx.options as unknown as { auth_token?: string; auth?: string; secrets?: string[] };
    if (optAny.auth_token) secrets.add(optAny.auth_token);
    if (optAny.auth) secrets.add(optAny.auth);
    for (const s of optAny.secrets ?? []) secrets.add(s);
    ctx.state.secrets = secrets;
  },
  onStep: (ctx, stepResult) => {
    const secrets = ctx.state.secrets as Set<string> | undefined;
    if (!secrets || secrets.size === 0) return [];
    const context = extractResponseContext(stepResult);
    if (context === undefined) return [];
    const dumped = safeStringify(context);
    const description = 'Response context omits caller-supplied secrets';
    for (const secret of secrets) {
      if (secret && dumped.includes(secret)) {
        return [
          {
            passed: false,
            description,
            step_id: stepResult.step_id,
            error: `Response context echoed a caller-supplied secret verbatim.`,
          },
        ];
      }
    }
    return [{ passed: true, description, step_id: stepResult.step_id }];
  },
});

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

interface AdcpErrorShape {
  code: string;
  details: Record<string, unknown>;
}

function extractAdcpError(step: import('./types').StoryboardStepResult): AdcpErrorShape | null {
  const resp = (step as unknown as { response?: unknown }).response;
  if (!resp || typeof resp !== 'object') return null;
  const envelope = (resp as { adcp_error?: unknown }).adcp_error;
  if (!envelope || typeof envelope !== 'object') return null;
  const code = (envelope as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  return { code, details: envelope as Record<string, unknown> };
}

function extractResponseContext(step: import('./types').StoryboardStepResult): unknown {
  const resp = (step as unknown as { response?: unknown }).response;
  if (!resp || typeof resp !== 'object') return undefined;
  return (resp as { context?: unknown }).context;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
