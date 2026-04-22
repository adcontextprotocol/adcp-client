/**
 * Default assertion registrations for invariant ids that upstream storyboards
 * reference but that every SDK consumer would otherwise have to implement
 * themselves. Importing this module side-registers the ids below, so
 * `resolveAssertions` doesn't throw on fresh `@adcp/client` installs.
 *
 * The implementations aim for the spec's stated intent, not byte-perfect
 * fidelity with the upstream reference. Consumers can override a default by
 * calling `registerAssertion(spec, { override: true })` with a stricter
 * implementation of their own.
 *
 * Registered ids:
 *   - `idempotency.conflict_no_payload_leak` — when a mutating step returns
 *     `IDEMPOTENCY_CONFLICT`, the error envelope must carry only allowlisted
 *     keys. Any other top-level property is flagged as a potential payload
 *     leak (stolen-key read oracle).
 *   - `context.no_secret_echo` — response bodies (not just `.context`) MUST
 *     NOT contain bearer tokens, API keys, auth header values, or any leaf
 *     string extracted from the caller-supplied `auth` union. Walks the
 *     whole body, matches on suspect property names at any depth, and
 *     catches bearer-token literals via regex.
 *   - `governance.denial_blocks_mutation` — once a plan is denied by a
 *     governance signal (GOVERNANCE_DENIED, CAMPAIGN_SUSPENDED, etc., or
 *     `check_governance` returning `status: "denied"`), no subsequent step
 *     in the run may acquire a resource for that plan. Plan-scoped via
 *     `plan_id`; runs without a denial signal are a silent pass.
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

/**
 * Envelope fields that MAY legitimately appear on an IDEMPOTENCY_CONFLICT
 * error body. Anything else on the error envelope is flagged as a potential
 * payload leak. The allowlist is narrow on purpose: sellers that need more
 * fields should push back on the spec, not silently leak cached state.
 *
 * The previous implementation used a denylist of 5 specific field names
 * (`payload`, `stored_payload`, etc.) — trivially bypassed by a seller
 * inlining `budget` / `product_id` / `account_id` at the envelope root,
 * which turns key-reuse into a read oracle for the stolen-key attacker.
 */
const CONFLICT_ALLOWED_ENVELOPE_KEYS = new Set([
  'code',
  'message',
  'status',
  'retry_after',
  'correlation_id',
  'request_id',
  'operation_id',
]);

registerOnce('idempotency.conflict_no_payload_leak', {
  id: 'idempotency.conflict_no_payload_leak',
  description:
    'IDEMPOTENCY_CONFLICT errors MUST NOT echo the prior request payload or response (stolen-key read oracle).',
  onStep: (_ctx, stepResult) => {
    const err = extractAdcpError(stepResult);
    if (!err) return [];
    if (err.code !== 'IDEMPOTENCY_CONFLICT') return [];

    const description = 'IDEMPOTENCY_CONFLICT error redacts prior payload';
    const leaked: string[] = [];
    for (const key of Object.keys(err.details)) {
      if (!CONFLICT_ALLOWED_ENVELOPE_KEYS.has(key)) leaked.push(key);
    }
    if (leaked.length === 0) {
      return [{ passed: true, description, step_id: stepResult.step_id }];
    }
    return [
      {
        passed: false,
        description,
        step_id: stepResult.step_id,
        error:
          `IDEMPOTENCY_CONFLICT error envelope leaked non-allowlisted field(s): ${leaked.sort().join(', ')}. ` +
          `Allowed envelope keys: ${[...CONFLICT_ALLOWED_ENVELOPE_KEYS].join(', ')}.`,
      },
    ];
  },
});

/**
 * Bearer-token literal pattern. Matches the wire form a seller might echo
 * from `Authorization: Bearer <token>` — case-insensitive `bearer` keyword
 * followed by a token body of at least 10 characters of base64url / JWT
 * vocabulary. Kept strict on length to avoid false positives on prose like
 * "bearer of bad news".
 */
const BEARER_TOKEN_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/i;

/**
 * Property names that MUST NOT appear on a response body — a seller that
 * serializes `Authorization` / `api_key` / `x-api-key` headers or fields
 * into the response is almost certainly leaking credentials, regardless of
 * whether the scanner picks up the value verbatim (header normalization,
 * whitespace differences, etc. can mask verbatim matches). Case-insensitive.
 */
const SUSPECT_PROPERTY_NAMES = new Set(['authorization', 'api_key', 'apikey', 'bearer', 'x-api-key']);

/**
 * Minimum length for a caller-supplied secret to be hunted for verbatim.
 * Set to 16 because real OAuth access tokens, refresh tokens, and signing
 * secrets are ≥20 chars by convention (opaque UUIDs, JWTs, HMAC hex). A
 * shorter floor would false-positive on benign identifiers (short
 * usernames, environment names, 8-char hex prefixes, ISO timestamps).
 * Hand-coded fixture keys like `"test-key"` below this bar are not caught
 * — that's the right tradeoff: a real agent echoing such a value is an
 * obvious leak a human reviewer would spot, and the collision cost of
 * matching short strings against every response body is too high to
 * justify the coverage.
 */
const SECRET_MIN_LENGTH = 16;

registerOnce('context.no_secret_echo', {
  id: 'context.no_secret_echo',
  description: 'Response bodies MUST NOT echo bearer tokens, API keys, or auth header values back to the caller.',
  onStart: ctx => {
    // Stash caller-supplied secrets worth hunting verbatim. `auth` is the
    // structured discriminated union from TestOptions — we walk it and
    // extract leaf strings so `String.includes(obj)` can't silently no-op.
    // test_kit api_key pickup matches what storyboards typically stage;
    // options.secrets is a consumer hook for custom credentials.
    const secrets = new Set<string>();
    const optAny = ctx.options as unknown as {
      auth_token?: string;
      auth?: unknown;
      secrets?: string[];
      test_kit?: { auth?: { api_key?: string } };
    };
    addIfSecret(secrets, optAny.auth_token);
    for (const s of extractAuthSecrets(optAny.auth)) addIfSecret(secrets, s);
    for (const s of optAny.secrets ?? []) addIfSecret(secrets, s);
    addIfSecret(secrets, optAny.test_kit?.auth?.api_key);
    ctx.state.secrets = secrets;
  },
  onStep: (ctx, stepResult) => {
    const body = (stepResult as unknown as { response?: unknown }).response;
    if (body === undefined || body === null) return [];

    const secrets = (ctx.state.secrets as Set<string> | undefined) ?? new Set<string>();
    const description = 'Response omits caller-supplied secrets and credential-shaped fields';

    const hit = findSecretEcho(body, secrets);
    if (hit) {
      return [
        {
          passed: false,
          description,
          step_id: stepResult.step_id,
          error: `step "${stepResult.step_id}" response ${hit}`,
        },
      ];
    }
    return [{ passed: true, description, step_id: stepResult.step_id }];
  },
});

/**
 * Recursively walk `value` hunting for (a) suspect property names at any
 * depth, (b) bearer-token literals in any string value, and (c) verbatim
 * copies of caller-supplied secrets. First hit wins; the caller turns the
 * reason into a human-readable error message.
 */
function findSecretEcho(value: unknown, secrets: Set<string>): string | null {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (BEARER_TOKEN_PATTERN.test(v)) return 'contains a bearer-token literal';
      for (const s of secrets) {
        if (v.includes(s)) return 'contains a caller-supplied secret value verbatim';
      }
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    if (v !== null && typeof v === 'object') {
      for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
        if (SUSPECT_PROPERTY_NAMES.has(key.toLowerCase())) {
          return `contains suspect property name "${key}"`;
        }
        stack.push(inner);
      }
    }
  }
  return null;
}

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
 * Add a value to the secrets set if it is a non-empty string of at least
 * `SECRET_MIN_LENGTH` chars. Centralises the length guard so every source
 * (structured auth, `auth_token`, `secrets[]`, `test_kit.auth.api_key`)
 * gets the same floor.
 */
function addIfSecret(out: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  if (value.length < SECRET_MIN_LENGTH) return;
  out.add(value);
}

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
 *   - basic                     → `password` and, when both credentials are
 *                                 present, the `base64(user:pass)` blob an
 *                                 `Authorization: Basic` header carries.
 *                                 Username alone is NOT extracted — it's a
 *                                 public identifier (welcome messages, audit
 *                                 logs, "last login by X" echoes legitimately).
 *   - oauth                     → `tokens.access_token`, `tokens.refresh_token`,
 *                                 `client.client_secret` (if confidential)
 *   - oauth_client_credentials  → `credentials.client_secret` (may be a
 *                                 `$ENV:VAR` reference, resolved at runtime),
 *                                 `tokens.access_token`, `tokens.refresh_token`.
 *                                 `client_id` is NOT extracted — RFC 6749 §2.2
 *                                 is explicit that the client identifier is
 *                                 public and legitimately echoed in token
 *                                 responses, introspection payloads, audit
 *                                 logs, and error bodies.
 *
 * Returns an empty list for anything we can't recognise — the goal is a best-
 * effort extraction, not schema validation. The SECRET_MIN_LENGTH guard is
 * applied by the caller via `addIfSecret`.
 */
function extractAuthSecrets(auth: unknown): string[] {
  if (!auth || typeof auth !== 'object') return [];
  const a = auth as Record<string, unknown>;
  const out: string[] = [];
  pushCredentialValue(out, a.token); // bearer

  // basic: the password is the secret; the base64 blob catches echoes of the
  // full Authorization: Basic header. Username alone is not a secret.
  if (typeof a.password === 'string' && a.password) {
    out.push(a.password);
    if (typeof a.username === 'string' && a.username) {
      out.push(Buffer.from(`${a.username}:${a.password}`, 'utf8').toString('base64'));
    }
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
    // client_secret on AgentOAuthClientCredentials may be a `$ENV:VAR`
    // reference — resolve so the assertion compares the real runtime value
    // the AS sees, not the reference string. client_id is NOT extracted
    // (RFC 6749 §2.2 — public identifier).
    pushCredentialValue(out, c.client_secret);
  }
  return out;
}
