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
 *   - `governance.denial_blocks_mutation` — once a plan is denied by a
 *     governance signal (GOVERNANCE_DENIED, CAMPAIGN_SUSPENDED, etc., or
 *     `check_governance` returning `status: "denied"`), no subsequent step
 *     in the run may acquire a resource for that plan. Catches sellers that
 *     surface the denial but mutate anyway. Plan-scoped via `plan_id`; runs
 *     without a denial signal are a silent pass.
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
    // Stash the sensitive values we know about. `auth` is the structured
    // discriminated union from TestOptions — we walk it and extract leaf
    // strings so `String.includes(obj)` can't silently no-op. Consumers can
    // extend via `options.secrets` with additional raw strings.
    const secrets = new Set<string>();
    const optAny = ctx.options as unknown as { auth_token?: string; auth?: unknown; secrets?: string[] };
    if (typeof optAny.auth_token === 'string' && optAny.auth_token) secrets.add(optAny.auth_token);
    for (const s of extractAuthSecrets(optAny.auth)) secrets.add(s);
    for (const s of optAny.secrets ?? []) if (typeof s === 'string' && s) secrets.add(s);
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
      // Minimum length guards against collisions on short fixture values
      // (e.g. a 2-char `client_id` would match most JSON payloads by accident).
      // Real bearer / access tokens are ≥ 20 chars in practice; the threshold
      // keeps false positives out without missing realistic secrets.
      if (secret.length >= SECRET_MIN_LENGTH && dumped.includes(secret)) {
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
// governance.denial_blocks_mutation
// ────────────────────────────────────────────────────────────

/**
 * Error codes that signal a seller-side refusal with plan scope. Grounded
 * in `ErrorCodeSchema` in `src/lib/types/schemas.generated.ts`. Excludes
 * transient (`GOVERNANCE_UNAVAILABLE` — no decision rendered) and
 * account-state (`ACCOUNT_SUSPENDED`) codes — those aren't plan denials.
 */
const GOVERNANCE_DENIAL_CODES = new Set([
  'GOVERNANCE_DENIED',
  'CAMPAIGN_SUSPENDED',
  'PERMISSION_DENIED',
  'POLICY_VIOLATION',
  'TERMS_REJECTED',
  'COMPLIANCE_UNSATISFIED',
]);

/**
 * Write-class tasks whose successful response carries a server-minted
 * resource id at the top level. Read tasks (`get_*`, `list_*`,
 * `check_governance`) can echo ids without having created anything; they
 * are excluded so the assertion doesn't false-positive on lookups after
 * a denial. Sync-batch tasks (`sync_*`) are excluded until per-item
 * acquisition detection lands — see follow-up in the spec repo.
 */
const GOVERNANCE_WRITE_TASKS = new Set([
  'create_media_buy',
  'update_media_buy',
  'activate_signal',
  'create_property_list',
  'update_property_list',
  'delete_property_list',
  'create_collection_list',
  'update_collection_list',
  'delete_collection_list',
  'acquire_rights',
]);

const GOVERNANCE_ACQUIRED_STATUSES = new Set(['pending_creatives', 'pending_start', 'active', 'paused', 'completed']);

const GOVERNANCE_RESOURCE_ID_FIELDS = [
  'media_buy_id',
  'plan_id',
  'creative_id',
  'audience_id',
  'catalog_id',
  'activation_id',
  'property_list_id',
  'collection_list_id',
  'acquisition_id',
  'operation_id',
];

interface GovernanceDenialAnchor {
  stepId: string;
  signal: string;
}

registerOnce('governance.denial_blocks_mutation', {
  id: 'governance.denial_blocks_mutation',
  description:
    'Once a governance signal denies a plan, no subsequent step in the run may acquire a resource for that plan.',
  onStart: ctx => {
    ctx.state.deniedPlans = new Map<string, GovernanceDenialAnchor>();
    ctx.state.runDenial = undefined;
  },
  onStep: (ctx, stepResult) => {
    const state = ctx.state as {
      deniedPlans: Map<string, GovernanceDenialAnchor>;
      runDenial?: GovernanceDenialAnchor;
    };
    const planId = extractGovernancePlanId(stepResult);

    // Denial observation is never itself a failure — record and return.
    const denial = detectGovernanceDenial(stepResult);
    if (denial) {
      const anchor: GovernanceDenialAnchor = { stepId: stepResult.step_id, signal: denial };
      if (planId) {
        if (!state.deniedPlans.has(planId)) state.deniedPlans.set(planId, anchor);
      } else if (!state.runDenial) {
        state.runDenial = anchor;
      }
      return [];
    }

    const acquired = detectGovernanceAcquisition(stepResult);
    if (!acquired) return [];

    const anchor = (planId && state.deniedPlans.get(planId)) ?? state.runDenial;
    if (!anchor) return [];

    return [
      {
        passed: false,
        description: 'Mutation acquired a resource after a governance denial',
        step_id: stepResult.step_id,
        error:
          `step "${anchor.stepId}" returned ${anchor.signal}` +
          (planId ? ` for plan_id=${planId}` : ' (run-wide)') +
          `; subsequent step "${stepResult.step_id}" (task=${stepResult.task}) ` +
          `acquired ${acquired.field}=${acquired.id}` +
          (planId ? ' for the same plan' : ''),
      },
    ];
  },
});

function detectGovernanceDenial(step: import('./types').StoryboardStepResult): string | undefined {
  const err = extractAdcpError(step);
  if (err && GOVERNANCE_DENIAL_CODES.has(err.code)) return err.code;
  // `check_governance` decides-no via a 200 response with `status: "denied"`
  // (see static/schemas/source/governance/check-governance-response.json in
  // the spec repo). The body isn't wrapped in `adcp_error`.
  if (step.task === 'check_governance') {
    const body = (step as unknown as { response?: unknown }).response;
    if (body && typeof body === 'object') {
      const status = (body as Record<string, unknown>).status;
      if (status === 'denied') return 'CHECK_GOVERNANCE_DENIED';
    }
  }
  return undefined;
}

function extractGovernancePlanId(step: import('./types').StoryboardStepResult): string | undefined {
  const body = (step as unknown as { response?: unknown }).response;
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (typeof rec.plan_id === 'string' && rec.plan_id) return rec.plan_id;
  }
  // The runner records the outgoing payload on `stepResult.request` — read
  // from there rather than accumulated step context to avoid stale plan_id
  // bleed from earlier unrelated steps.
  const req = (step as unknown as { request?: { payload?: unknown } }).request;
  if (req && typeof req.payload === 'object' && req.payload !== null) {
    const payload = req.payload as Record<string, unknown>;
    if (typeof payload.plan_id === 'string' && payload.plan_id) return payload.plan_id;
  }
  return undefined;
}

function detectGovernanceAcquisition(
  step: import('./types').StoryboardStepResult
): { field: string; id: string } | undefined {
  if (step.expect_error) return undefined;
  if (!step.passed) return undefined;
  if (!GOVERNANCE_WRITE_TASKS.has(step.task)) return undefined;

  const body = (step as unknown as { response?: unknown }).response;
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;

  if (step.task === 'create_media_buy' || step.task === 'update_media_buy') {
    const status = record.status;
    if (typeof status === 'string' && !GOVERNANCE_ACQUIRED_STATUSES.has(status)) return undefined;
  }

  for (const field of GOVERNANCE_RESOURCE_ID_FIELDS) {
    const val = record[field];
    if (typeof val === 'string' && val.length > 0) return { field, id: val };
  }
  return undefined;
}

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

/**
 * Minimum secret length before substring matching runs. Anything shorter is
 * almost certainly a test fixture value that would collide with benign JSON.
 * Bearer / OAuth access tokens in practice are well above this threshold.
 */
const SECRET_MIN_LENGTH = 8;

const ENV_REFERENCE_PREFIX = '$ENV:';

/**
 * Resolve a possibly `$ENV:VAR`-prefixed credential value to the literal it
 * references at runtime. Mirrors the auth-layer `resolveSecret` in
 * `src/lib/auth/oauth/secret-resolver.ts`, but swallows missing / empty
 * variables instead of throwing — the assertion must never break a
 * storyboard run just because it can't resolve a ref.
 *
 * Returns `undefined` if the value is not an env reference, or if the
 * referenced variable is unset / empty. Callers should skip `undefined`
 * results. The literal `$ENV:FOO` string itself is never returned because
 * it is a reference, not a secret, and cannot appear in an agent response.
 */
function resolveEnvReference(value: string): string | undefined {
  if (!value.startsWith(ENV_REFERENCE_PREFIX)) return undefined;
  const envVar = value.slice(ENV_REFERENCE_PREFIX.length).trim();
  if (!envVar) return undefined;
  const resolved = process.env[envVar];
  if (!resolved) return undefined;
  return resolved;
}

/**
 * Push a credential-field string onto `out`, resolving `$ENV:VAR` references
 * to their literal runtime value. Literal values pass through unchanged.
 * `$ENV:` references only contribute the resolved value — the reference
 * string itself is not a secret.
 */
function pushCredentialValue(out: string[], value: unknown): void {
  if (typeof value !== 'string' || !value) return;
  if (value.startsWith(ENV_REFERENCE_PREFIX)) {
    const resolved = resolveEnvReference(value);
    if (resolved) out.push(resolved);
    return;
  }
  out.push(value);
}

/**
 * Extract every leaf string secret from a structured `TestOptions.auth` value.
 * Mirrors the four variants in `src/lib/testing/types.ts`:
 *   - bearer                    → `token`
 *   - basic                     → `password`, `username`, and the
 *                                 `base64(user:pass)` an Authorization: Basic
 *                                 header would carry, so echoes of the full
 *                                 header or the raw tuple are both caught
 *   - oauth                     → `tokens.access_token`, `tokens.refresh_token`,
 *                                 `client.client_secret` (if confidential)
 *   - oauth_client_credentials  → `credentials.client_secret` and
 *                                 `credentials.client_id` (both may be
 *                                 `$ENV:VAR` references, resolved at runtime),
 *                                 `tokens.access_token`, `tokens.refresh_token`
 *
 * Returns an empty list for anything we can't recognise — the goal is a best-
 * effort extraction, not schema validation.
 */
function extractAuthSecrets(auth: unknown): string[] {
  if (!auth || typeof auth !== 'object') return [];
  const a = auth as Record<string, unknown>;
  const out: string[] = [];
  pushCredentialValue(out, a.token); // bearer

  // basic: echo of the decoded tuple, the username alone, or the full
  // base64 Authorization header are all plausible leaks.
  if (typeof a.username === 'string' && a.username && typeof a.password === 'string' && a.password) {
    out.push(a.username);
    out.push(a.password);
    out.push(Buffer.from(`${a.username}:${a.password}`, 'utf8').toString('base64'));
  } else if (typeof a.password === 'string' && a.password) {
    out.push(a.password);
  }

  if (a.tokens && typeof a.tokens === 'object') {
    const t = a.tokens as Record<string, unknown>;
    if (typeof t.access_token === 'string' && t.access_token) out.push(t.access_token);
    if (typeof t.refresh_token === 'string' && t.refresh_token) out.push(t.refresh_token);
  }
  if (a.client && typeof a.client === 'object') {
    const c = a.client as Record<string, unknown>;
    if (typeof c.client_secret === 'string' && c.client_secret) out.push(c.client_secret);
  }
  if (a.credentials && typeof a.credentials === 'object') {
    const c = a.credentials as Record<string, unknown>;
    // client_id/client_secret on AgentOAuthClientCredentials may be
    // `$ENV:VAR` references (see adcp.ts). Resolve so the assertion compares
    // the real runtime value the AS sees, not the reference string.
    pushCredentialValue(out, c.client_id);
    pushCredentialValue(out, c.client_secret);
  }
  return out;
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
