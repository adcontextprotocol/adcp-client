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
 *   - `status.monotonic` — across the steps of a run, no observed resource's
 *     `status` (or creative `approval_status`) may transition along an edge
 *     that is not in the spec-published lifecycle graph for its resource
 *     type. Catches regressions like `active → pending_creatives` that
 *     per-step validations miss. Scoped by `(resource_type, resource_id)`
 *     so unrelated resources don't interfere. Tables below cite the spec
 *     enum schemas in `static/schemas/source/enums/*-status.json`.
 */

import { ADCP_VERSION } from '../../version';
import { CONFLICT_ADCP_ERROR_ALLOWLIST } from '../../server/envelope-allowlist';
import { registerAssertion } from './assertions';

// Register only once per process. `registerAssertion` throws on duplicates —
// consumers who import `@adcp/client/testing` multiple times would hit that.
const REGISTERED = new Set<string>();

function registerOnce(id: string, spec: Parameters<typeof registerAssertion>[0]): void {
  if (REGISTERED.has(id)) return;
  REGISTERED.add(id);
  registerAssertion(spec);
}

registerOnce('idempotency.conflict_no_payload_leak', {
  id: 'idempotency.conflict_no_payload_leak',
  default: true,
  description:
    'IDEMPOTENCY_CONFLICT errors MUST NOT echo the prior request payload or response (stolen-key read oracle).',
  onStep: (_ctx, stepResult) => {
    const err = extractAdcpError(stepResult);
    if (!err) return [];
    if (err.code !== 'IDEMPOTENCY_CONFLICT') return [];

    const description = 'IDEMPOTENCY_CONFLICT error redacts prior payload';
    const leaked: string[] = [];
    for (const key of Object.keys(err.details)) {
      if (!CONFLICT_ADCP_ERROR_ALLOWLIST.has(key)) leaked.push(key);
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
          `Allowed envelope keys (ADCP_ERROR_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT): ` +
          `${[...CONFLICT_ADCP_ERROR_ALLOWLIST].join(', ')}.`,
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
  default: true,
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
  default: true,
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
      // A step marked `expect_error: true` is the storyboard author explicitly
      // acknowledging the denial. Subsequent mutations in the same run are a
      // recovery path, not a silent bypass — don't anchor. The invariant still
      // catches silent denials (check_governance 200 `status: denied`, or
      // adcp_error responses the author did not expect).
      if (stepResult.expect_error) return [];
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

    // Always surface the step-level escape hatch — it's the one hint that
    // works for both wire-error denials and `check_governance` 200
    // `status: denied`. Names the step, names the field, shows the YAML so
    // the author doesn't have to re-derive the escape from source.
    const escapeHint =
      `. If the denial at step "${anchor.stepId}" is an intentional recovery-path setup, add to that step:\n` +
      `  invariants:\n` +
      `    disable: [governance.denial_blocks_mutation]`;

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
          (planId ? ' for the same plan' : '') +
          escapeHint,
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

// ────────────────────────────────────────────────────────────
// status.monotonic
// ────────────────────────────────────────────────────────────

/**
 * Per-resource-type lifecycle transition graphs. Each inner map is
 * `from → Set<to>`. An observed transition `prev → curr` is legal iff
 * `TRANSITIONS[type].get(prev)?.has(curr)` (self-edges `prev === curr`
 * are always legal and skipped). The tables are hand-written from the
 * spec enum schemas in `static/schemas/source/enums/*-status.json` and
 * the narrative transitions documented there. When an enum gains a
 * value this module needs an update alongside the schema change — that's
 * the right coupling, visible in PR review.
 *
 * Bidirectional edges are listed in both directions explicitly (no
 * auto-mirroring) so one-way edges like `rejected → processing` for
 * creative assets don't accidentally become reversible.
 */
interface TransitionGraph {
  readonly transitions: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Filename of the canonical enum schema this graph mirrors, relative to
   * `/schemas/<adcp-version>/enums/`. Used to render a deep-link in the
   * assertion failure message so implementors can jump straight to the
   * spec's lifecycle doc instead of grep-searching for it.
   */
  readonly enumFile: string;
}

const SCHEMA_URL_BASE = 'https://adcontextprotocol.org';

function buildEnumSchemaUrl(enumFile: string): string {
  return `${SCHEMA_URL_BASE}/schemas/${ADCP_VERSION}/enums/${enumFile}`;
}

const MEDIA_BUY_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/media-buy-status.json`. `active ↔ paused`
  // is reversible (buyer pauses, seller resumes). `completed | rejected |
  // canceled` are terminal.
  //
  // NOTE: `pending_start → rejected` is defensible but not explicit in the
  // schema prose — rejected is described as "declined by the seller after
  // creation", which is ambiguous on whether post-start rejection is in
  // scope. Kept for now; flagged for spec clarification.
  transitions: new Map<string, ReadonlySet<string>>([
    ['pending_creatives', new Set(['pending_start', 'active', 'paused', 'canceled', 'rejected'])],
    ['pending_start', new Set(['active', 'paused', 'canceled', 'rejected'])],
    ['active', new Set(['paused', 'completed', 'canceled'])],
    ['paused', new Set(['active', 'completed', 'canceled'])],
    ['completed', new Set()],
    ['rejected', new Set()],
    ['canceled', new Set()],
  ]),
  enumFile: 'media-buy-status.json',
};

const CREATIVE_ASSET_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/creative-status.json`. The schema is
  // explicit on which edges exist:
  //   - processing: "Automatically transitions to pending_review when
  //     processing completes, or to rejected if processing fails." → no
  //     direct `processing → approved` edge.
  //   - pending_review: "Transitions to approved or rejected after review."
  //     → no `pending_review → processing` edge.
  //   - rejected: "Buyer can re-submit by calling sync_creatives again,
  //     which moves the creative back to processing." → the re-sync path.
  //   - approved ↔ archived is reversible (buyer archives / unarchives).
  // No terminals — everything can recover via re-sync.
  transitions: new Map<string, ReadonlySet<string>>([
    ['processing', new Set(['pending_review', 'rejected'])],
    ['pending_review', new Set(['approved', 'rejected'])],
    ['approved', new Set(['archived', 'rejected'])],
    ['archived', new Set(['approved'])],
    ['rejected', new Set(['processing', 'pending_review'])],
  ]),
  enumFile: 'creative-status.json',
};

const CREATIVE_APPROVAL_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/creative-approval-status.json`.
  // Per-assignment approval state on a package. `rejected → pending_review`
  // is allowed on re-sync.
  transitions: new Map<string, ReadonlySet<string>>([
    ['pending_review', new Set(['approved', 'rejected'])],
    ['approved', new Set(['rejected'])],
    ['rejected', new Set(['pending_review'])],
  ]),
  enumFile: 'creative-approval-status.json',
};

const ACCOUNT_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/account-status.json`. `active ↔
  // suspended` and `active ↔ payment_required` are both reversible.
  // `suspended → payment_required` covers the legitimate case where a
  // suspended account's credit lapses during the suspension window.
  // `rejected | closed` are terminal.
  transitions: new Map<string, ReadonlySet<string>>([
    ['pending_approval', new Set(['active', 'rejected'])],
    ['active', new Set(['suspended', 'payment_required', 'closed'])],
    ['suspended', new Set(['active', 'payment_required', 'closed'])],
    ['payment_required', new Set(['active', 'suspended', 'closed'])],
    ['rejected', new Set()],
    ['closed', new Set()],
  ]),
  enumFile: 'account-status.json',
};

const SI_SESSION_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/si-session-status.json`.
  // `complete | terminated` are terminal.
  transitions: new Map<string, ReadonlySet<string>>([
    ['active', new Set(['pending_handoff', 'complete', 'terminated'])],
    ['pending_handoff', new Set(['complete', 'terminated'])],
    ['complete', new Set()],
    ['terminated', new Set()],
  ]),
  enumFile: 'si-session-status.json',
};

const CATALOG_ITEM_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/catalog-item-status.json`. `approved ↔
  // warning` is reversible (seller flags a warning, then clears it).
  // `rejected → pending` is allowed on re-sync. No terminals.
  transitions: new Map<string, ReadonlySet<string>>([
    ['pending', new Set(['approved', 'rejected', 'warning'])],
    ['approved', new Set(['warning', 'rejected'])],
    ['warning', new Set(['approved', 'rejected'])],
    ['rejected', new Set(['pending'])],
  ]),
  enumFile: 'catalog-item-status.json',
};

const PROPOSAL_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/proposal-status.json`. One-way.
  transitions: new Map<string, ReadonlySet<string>>([
    ['draft', new Set(['committed'])],
    ['committed', new Set()],
  ]),
  enumFile: 'proposal-status.json',
};

const AUDIENCE_TRANSITIONS: TransitionGraph = {
  // See `static/schemas/source/enums/audience-status.json`. Fully bidirectional
  // across the three states — sellers MAY re-enter `processing` on re-sync
  // from `ready` or `too_small`, and `ready ↔ too_small` can happen as
  // member counts cross `minimum_size` (spec hedges this as MAY, not MUST).
  // No terminals: delete / fail omit `status` entirely via the envelope's
  // `action` field, so there's nothing to record for them.
  transitions: new Map<string, ReadonlySet<string>>([
    ['processing', new Set(['ready', 'too_small'])],
    ['ready', new Set(['processing', 'too_small'])],
    ['too_small', new Set(['processing', 'ready'])],
  ]),
  enumFile: 'audience-status.json',
};

/**
 * Extractor record per resource type. For each response shape we recognize,
 * describe how to walk the body and emit `(resource_id, status)` pairs.
 * The runner hands us `stepResult.response` — we look at the shape and
 * the task name to disambiguate (e.g. `get_media_buys` vs `sync_creatives`).
 */
interface StatusObservation {
  resource_type: string;
  resource_id: string;
  status: string;
  graph: TransitionGraph;
}

/**
 * Task-aware extractors. Each knows the response shape for its task family
 * and walks arrays where present. Unknown tasks produce no observations —
 * the assertion is silent on tasks it doesn't recognize.
 */
function extractStatusObservations(task: string, body: Record<string, unknown>): StatusObservation[] {
  const obs: StatusObservation[] = [];

  // Media-buy: create/update_media_buy return top-level status + packages
  // with per-creative approval_status. get_media_buys returns media_buys[].
  if (task === 'create_media_buy' || task === 'update_media_buy') {
    pushMediaBuy(obs, body);
  } else if (task === 'get_media_buys') {
    for (const mb of asArray(body.media_buys)) {
      if (isObject(mb)) pushMediaBuy(obs, mb);
    }
  }

  // Creative asset lifecycle: sync_creatives and list_creatives.
  if (task === 'sync_creatives' || task === 'list_creatives') {
    for (const c of asArray(body.creatives)) {
      if (isObject(c)) pushCreative(obs, c);
    }
  }

  // Account: sync_accounts and list_accounts. Embedded `account` objects on
  // media-buy responses do not carry a lifecycle status — they're just
  // references (brand, operator) — so we don't read them here.
  if (task === 'sync_accounts' || task === 'list_accounts') {
    for (const a of asArray(body.accounts)) {
      if (isObject(a)) pushAccount(obs, a);
    }
  }

  // SI session: si_initiate_session / si_send_message return top-level
  // `session_id` + `status`.
  if (task === 'si_initiate_session' || task === 'si_send_message' || task === 'si_terminate_session') {
    pushSiSession(obs, body);
  }

  // Catalog items: sync_catalogs / list_catalogs return `items[]` per catalog.
  if (task === 'sync_catalogs' || task === 'list_catalogs') {
    for (const cat of asArray(body.catalogs)) {
      if (!isObject(cat)) continue;
      for (const item of asArray(cat.items)) {
        if (isObject(item)) pushCatalogItem(obs, item);
      }
    }
    for (const item of asArray(body.items)) {
      if (isObject(item)) pushCatalogItem(obs, item);
    }
  }

  // Proposal: get_products may return a `proposal` object when the
  // caller is refining toward commitment.
  if (task === 'get_products' && isObject(body.proposal)) {
    pushProposal(obs, body.proposal);
  }

  // Audience lifecycle: sync_audiences is both the write and discovery path
  // (discovery-only calls omit the request `audiences` array but still return
  // `audiences[]`). No separate list_audiences task exists.
  if (task === 'sync_audiences') {
    for (const a of asArray(body.audiences)) {
      if (isObject(a)) pushAudience(obs, a);
    }
  }

  return obs;
}

function pushMediaBuy(obs: StatusObservation[], record: Record<string, unknown>): void {
  const id = asString(record.media_buy_id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'media_buy',
      resource_id: id,
      status,
      graph: MEDIA_BUY_TRANSITIONS,
    });
  }
  // Each media_buy carries packages; each package can list creative_approvals
  // with per-creative approval_status. Track those against the approval graph.
  for (const pkg of asArray(record.packages)) {
    if (!isObject(pkg)) continue;
    for (const ca of asArray(pkg.creative_approvals)) {
      if (!isObject(ca)) continue;
      const cid = asString(ca.creative_id);
      const astatus = asString(ca.approval_status);
      if (cid && astatus) {
        obs.push({
          resource_type: 'creative_approval',
          resource_id: cid,
          status: astatus,
          graph: CREATIVE_APPROVAL_TRANSITIONS,
        });
      }
    }
  }
}

function pushCreative(obs: StatusObservation[], record: Record<string, unknown>): void {
  const id = asString(record.creative_id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'creative',
      resource_id: id,
      status,
      graph: CREATIVE_ASSET_TRANSITIONS,
    });
  }
}

function pushAccount(obs: StatusObservation[], record: Record<string, unknown>): void {
  const id = asString(record.account_id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'account',
      resource_id: id,
      status,
      graph: ACCOUNT_TRANSITIONS,
    });
  }
}

function pushSiSession(obs: StatusObservation[], record: Record<string, unknown>): void {
  const id = asString(record.session_id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'si_session',
      resource_id: id,
      status,
      graph: SI_SESSION_TRANSITIONS,
    });
  }
}

function pushCatalogItem(obs: StatusObservation[], record: Record<string, unknown>): void {
  // Catalog items are heterogeneous across catalog types. Prefer `item_id`
  // (spec-canonical on sync/list responses), then domain-specific
  // `offering_id` (SI) and `sku` (retail), then a generic `id` as last
  // resort. The fallback chain silently mis-identifies if a seller echoes
  // a non-canonical id — the resulting history splits per id shape rather
  // than emitting an error. Acceptable tradeoff given schema churn; enum
  // drift stays under `response_schema`'s purview.
  const id = asString(record.item_id) ?? asString(record.offering_id) ?? asString(record.sku) ?? asString(record.id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'catalog_item',
      resource_id: id,
      status,
      graph: CATALOG_ITEM_TRANSITIONS,
    });
  }
}

function pushProposal(obs: StatusObservation[], record: Record<string, unknown>): void {
  const id = asString(record.proposal_id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'proposal',
      resource_id: id,
      status,
      graph: PROPOSAL_TRANSITIONS,
    });
  }
}

function pushAudience(obs: StatusObservation[], record: Record<string, unknown>): void {
  // `status` is absent when `action` is `deleted` or `failed` — spec
  // envelope intentionally omits the field rather than emitting a terminal
  // value. The `&& status` guard below makes those observations silent.
  const id = asString(record.audience_id);
  const status = asString(record.status);
  if (id && status) {
    obs.push({
      resource_type: 'audience',
      resource_id: id,
      status,
      graph: AUDIENCE_TRANSITIONS,
    });
  }
}

interface MonotonicState {
  stepId: string;
  status: string;
}

registerOnce('status.monotonic', {
  id: 'status.monotonic',
  default: true,
  description:
    'Observed resource statuses (media_buy, creative, account, si_session, catalog_item, proposal, creative_approval, audience) MUST only transition along edges in the spec lifecycle graph.',
  onStart: ctx => {
    // `${resource_type}:${resource_id}` → last-observed state. Tuple key
    // disambiguates the unlikely `media_buy_id` / `creative_id` collision.
    ctx.state.history = new Map<string, MonotonicState>();
  },
  onStep: (ctx, stepResult) => {
    // Skip error / skipped / negative-path steps. An errored read doesn't
    // observe a new state; `expect_error: true` runs are probing error
    // codes, not transitions.
    if (stepResult.skipped) return [];
    if (stepResult.expect_error) return [];
    if (!stepResult.passed) return [];
    const body = (stepResult as unknown as { response?: unknown }).response;
    if (!body || typeof body !== 'object') return [];
    if (extractAdcpError(stepResult)) return [];

    const history = ctx.state.history as Map<string, MonotonicState>;
    const observations = extractStatusObservations(stepResult.task, body as Record<string, unknown>);
    const description = 'Resource statuses transition only along spec lifecycle edges';

    for (const ob of observations) {
      const key = `${ob.resource_type}:${ob.resource_id}`;
      const prev = history.get(key);
      if (!prev) {
        history.set(key, { stepId: stepResult.step_id, status: ob.status });
        continue;
      }
      if (prev.status === ob.status) {
        // No-op observation (replay, re-read of unchanged state). Don't emit,
        // don't advance the anchor step — the earlier stepId stays useful for
        // diagnostics if a later backward edge appears.
        continue;
      }
      const allowedTargets = ob.graph.transitions.get(prev.status);
      if (!allowedTargets) {
        // Unknown previous status (enum drift or we missed a state in the
        // table). Don't fail — `response_schema` catches enum violations;
        // reset the anchor so downstream transitions still get checked.
        history.set(key, { stepId: stepResult.step_id, status: ob.status });
        continue;
      }
      if (!allowedTargets.has(ob.status)) {
        // Surface the legal next states + a canonical enum URL so implementors
        // can self-diagnose without grepping the SDK source for the
        // lifecycle table. `allowedTargets` is empty for terminal states
        // (completed / rejected / canceled / etc.) — call that out explicitly
        // rather than rendering an empty list that reads as "any target is
        // fine, just not this one".
        const legalTargets = [...allowedTargets].sort();
        const legalDescription =
          legalTargets.length > 0 ? legalTargets.map(t => `"${t}"`).join(', ') : '(none — terminal state)';
        const enumUrl = buildEnumSchemaUrl(ob.graph.enumFile);
        const errorMessage =
          `${ob.resource_type} ${ob.resource_id}: ${prev.status} → ${ob.status} ` +
          `(step "${prev.stepId}" → step "${stepResult.step_id}") is not in the lifecycle graph. ` +
          `Legal next states from "${prev.status}": ${legalDescription}. ` +
          `See ${enumUrl} for the canonical lifecycle.`;
        return [
          {
            passed: false,
            description,
            step_id: stepResult.step_id,
            error: errorMessage,
            // Issue #935: structured `MonotonicViolationHint` mirrored into
            // the owning step's `hints[]` so renderers can branch on the
            // discriminator and render the legal-target set in a per-kind
            // template instead of regex-parsing the prose error string.
            hint: {
              kind: 'monotonic_violation',
              message: errorMessage,
              resource_type: ob.resource_type,
              resource_id: ob.resource_id,
              from_status: prev.status,
              to_status: ob.status,
              from_step_id: prev.stepId,
              legal_next_states: legalTargets,
              enum_url: enumUrl,
            },
          },
        ];
      }
      history.set(key, { stepId: stepResult.step_id, status: ob.status });
    }

    if (observations.length === 0) return [];
    return [{ passed: true, description, step_id: stepResult.step_id }];
  },
});

// Tiny type-safety helpers for the extractors above.
function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
