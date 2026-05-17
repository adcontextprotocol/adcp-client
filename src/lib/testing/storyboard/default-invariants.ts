/**
 * Default assertion registrations for invariant ids that upstream storyboards
 * reference but that every SDK consumer would otherwise have to implement
 * themselves. Importing this module side-registers the ids below, so
 * `resolveAssertions` doesn't throw on fresh `@adcp/sdk` installs.
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
 *   - `impairment.coherence` — cross-resource invariant: every entry in
 *     `media_buy.impairments[]` MUST reference a resource the seller has
 *     reported in an offline state (forward); any resource the run
 *     transitioned to an offline state AND that the buy references MUST
 *     appear in `impairments[]` while the buy is non-terminal (inverse);
 *     `health == "impaired"` iff `impairments[]` is non-empty. See
 *     adcontextprotocol/adcp#2859 for the originating spec issue.
 */

import { ADCP_VERSION } from '../../version';
import { CONFLICT_ADCP_ERROR_ALLOWLIST } from '../../server/envelope-allowlist';
import {
  CREATIVE_ASSET_TRANSITIONS as CREATIVE_ASSET_TRANSITIONS_TYPED,
  MEDIA_BUY_TRANSITIONS as MEDIA_BUY_TRANSITIONS_TYPED,
} from '../../server/state-machine';
import { registerAssertion } from './assertions';

// Register only once per process. `registerAssertion` throws on duplicates —
// consumers who import `@adcp/sdk/testing` multiple times would hit that.
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
        // Name-based dragnet. The SUSPECT_PROPERTY_NAMES set catches the
        // "bare token on a credential-named field" leak shape that the
        // BEARER_TOKEN_PATTERN value-scan misses (a JWT without `Bearer `
        // prefix won't match the regex). But the dragnet over-rejects
        // when the field's VALUE is a structured object or array — those
        // are spec-legitimate config payloads, not credential echoes.
        // `compliance/cache/{version}/property/validation-result.json`
        // declares an `authorization` object field carrying authorization-
        // validation metadata, not a token; sellers extending
        // `sync_accounts` via the schema's `additionalProperties: true`
        // may carry their own structured `authorization` posture. Both
        // are spec-conformant.
        //
        // Gate the name-based fail on `typeof inner === 'string'` and
        // non-empty so structured values pass through to the recursive
        // walk below. The recursion still scans nested string values, so
        // a `Bearer xyz...` literal embedded in a structured object is
        // still caught by the regex at the top of this loop.
        // Spec: adcp-client#1713 / adcp#4419.
        if (SUSPECT_PROPERTY_NAMES.has(key.toLowerCase()) && typeof inner === 'string' && inner.length > 0) {
          return `contains suspect property name "${key}" with string value`;
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

// Source of truth for both graphs lives in `server/state-machine.ts` so
// production sellers and the runner enforce identical edges. Wrap the typed
// maps in `TransitionGraph` for the runner's string-keyed extractors.
const MEDIA_BUY_TRANSITIONS: TransitionGraph = {
  transitions: MEDIA_BUY_TRANSITIONS_TYPED as ReadonlyMap<string, ReadonlySet<string>>,
  enumFile: 'media-buy-status.json',
};

const CREATIVE_ASSET_TRANSITIONS: TransitionGraph = {
  transitions: CREATIVE_ASSET_TRANSITIONS_TYPED as ReadonlyMap<string, ReadonlySet<string>>,
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
  // Emit a run-level summary so the track rollup can distinguish
  // "wired and exercised" (history.size > 0) from "wired but never
  // observed a lifecycle resource" (history.size === 0). The latter
  // demotes the track to TrackStatus: 'silent' even though every step
  // and every per-step assertion record passed. Companion to
  // adcontextprotocol/adcp#2834.
  onEnd: ctx => {
    const history = ctx.state.history as Map<string, MonotonicState> | undefined;
    const observation_count = history?.size ?? 0;
    return [
      {
        passed: true,
        description: 'Resource statuses transition only along spec lifecycle edges',
        observation_count,
        status: observation_count === 0 ? ('silent' as const) : ('pass' as const),
      },
    ];
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

// ────────────────────────────────────────────────────────────
// impairment.coherence
// ────────────────────────────────────────────────────────────

/**
 * Per-resource-type offline status sets. An impairment entry referencing
 * `(resource_type, resource_id)` is coherent when the runner's last
 * observation for that resource matches one of these values.
 *
 * Sourced from spec issue #2859 plus the resource-status enum schemas:
 *   - audience:     `suspended`    (audience-status.json)
 *   - creative:     `rejected`     (creative-status.json — terminal)
 *   - catalog_item: `withdrawn`    (catalog-item-status.json)
 *   - event_source: `insufficient` (assessment-status.json, on
 *                                   event-source-health.status)
 *
 * `property` is intentionally absent — offline state is sourced from
 * `brand.json` / `adagents.json` depublishing, not from a status enum on
 * the wire. The runner has no observation hook for that transition today,
 * so property-typed impairments grade silent rather than emitting a forward
 * pass / fail. The spec issue calls this out explicitly.
 */
const IMPAIRMENT_OFFLINE_STATUS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['audience', new Set(['suspended'])],
  ['creative', new Set(['rejected'])],
  ['catalog_item', new Set(['withdrawn'])],
  ['event_source', new Set(['insufficient'])],
]);

/**
 * Media-buy statuses that are non-terminal — the inverse rule only applies
 * while the buy is still serving (or about to). The spec issue carves out
 * `completed`, `canceled`, `rejected` as the terminal set that MAY remain
 * unreported because the buy is no longer accruing impressions.
 */
const NON_TERMINAL_MEDIA_BUY_STATUSES: ReadonlySet<string> = new Set([
  'pending_creatives',
  'pending_start',
  'active',
  'paused',
]);

interface ImpairmentEntry {
  resource_type: string;
  resource_id: string;
}

interface BuySnapshot {
  media_buy_id: string;
  status: string | undefined;
  health: string | undefined;
  impairments: ImpairmentEntry[];
  referencedCreativeIds: Set<string>;
  stepId: string;
}

interface ResourceObservation {
  status: string;
  stepId: string;
}

/**
 * Resource families the inverse rule does NOT yet grade — the buy-side
 * reference shape for these in `media_buy.packages` isn't stable in the
 * cached schema, so we can't reliably tell which buys reference which
 * resources. Tracked in adcontextprotocol/adcp#2860. Listed here so the
 * onEnd summary can emit a runtime "partial inverse coverage" signal when
 * the run actually observed offline resources in one of these families —
 * making the deferral visible to storyboard authors and reviewers rather
 * than burying it in PR prose and JSDoc.
 */
const INVERSE_DEFERRED_FAMILIES: ReadonlySet<string> = new Set(['audience', 'catalog_item', 'event_source']);

/**
 * Private per-run scratch state. Namespaced under
 * `ctx.state.impairmentCoherence` so generic field names (`offlineResources`,
 * `observedTransition`) can't collide with another assertion that lands
 * later and pokes the same shared `ctx.state` bag.
 */
interface ImpairmentCoherenceState {
  /** `${resource_type}:${resource_id}` → last observation, offline or not. */
  resourceStatus: Map<string, ResourceObservation>;
  /** `${resource_type}:${resource_id}` for entries currently in an offline status. */
  offlineResources: Map<string, ResourceObservation>;
  /** Run actually observed at least one resource status transition. */
  observedTransition: boolean;
  /** Run actually observed at least one media-buy snapshot read. */
  observedBuySnapshot: boolean;
  /**
   * Per-family count of offline observations the run saw, used by the
   * onEnd summary to flag deferred inverse-rule coverage. A non-zero
   * count for any family in `INVERSE_DEFERRED_FAMILIES` means the run
   * exercised the cross-resource path for a family the runner can't yet
   * grade — surfaced so reviewers see the gap at run-time.
   */
  offlineObservationsByFamily: Map<string, number>;
}

const IMPAIRMENT_STATE_KEY = 'impairmentCoherence';

function getImpairmentState(ctx: import('./assertions').AssertionContext): ImpairmentCoherenceState {
  // onStart populates the namespaced slot; the cast is safe because no other
  // assertion writes there.
  return ctx.state[IMPAIRMENT_STATE_KEY] as ImpairmentCoherenceState;
}

registerOnce('impairment.coherence', {
  id: 'impairment.coherence',
  default: true,
  description:
    'media_buy.impairments[] MUST reference currently-offline resources (forward); any offline resource referenced by a non-terminal buy MUST appear in impairments[] (inverse); health == "impaired" iff impairments[] is non-empty.',
  onStart: ctx => {
    const state: ImpairmentCoherenceState = {
      resourceStatus: new Map(),
      offlineResources: new Map(),
      observedTransition: false,
      observedBuySnapshot: false,
      offlineObservationsByFamily: new Map(),
    };
    ctx.state[IMPAIRMENT_STATE_KEY] = state;
  },
  onStep: (ctx, stepResult) => {
    if (stepResult.skipped) return [];
    if (stepResult.expect_error) return [];
    if (!stepResult.passed) return [];
    const body = (stepResult as unknown as { response?: unknown }).response;
    if (!body || typeof body !== 'object') return [];
    if (extractAdcpError(stepResult)) return [];

    const state = getImpairmentState(ctx);

    // Direct, dedicated extractor for the four families this invariant cares
    // about. NOT routed through `extractStatusObservations` (which is bound
    // to the `status.monotonic` transition graphs and therefore excludes
    // the new offline values `suspended` / `withdrawn` / `insufficient`):
    // monotonic's graphs intentionally enumerate only spec-stable enum
    // values, but those new offline states are exactly what this invariant
    // needs to observe.
    for (const ob of extractImpairmentObservations(stepResult.task, body as Record<string, unknown>)) {
      const key = `${ob.resource_type}:${ob.resource_id}`;
      state.resourceStatus.set(key, { status: ob.status, stepId: stepResult.step_id });
      const offline = IMPAIRMENT_OFFLINE_STATUS.get(ob.resource_type);
      if (offline?.has(ob.status)) {
        state.offlineResources.set(key, { status: ob.status, stepId: stepResult.step_id });
        state.observedTransition = true;
        state.offlineObservationsByFamily.set(
          ob.resource_type,
          (state.offlineObservationsByFamily.get(ob.resource_type) ?? 0) + 1
        );
      } else {
        // Resource recovered from offline → drop the entry so the inverse
        // rule no longer expects it in impairments[].
        state.offlineResources.delete(key);
      }
    }

    // Extract media-buy snapshots and run the three coherence checks.
    const snapshots = extractBuySnapshots(stepResult.task, body as Record<string, unknown>, stepResult.step_id);
    if (snapshots.length === 0) return [];
    state.observedBuySnapshot = true;

    const description = 'media_buy.impairments[] coheres with resource state and buy health';
    type CoherenceResult = {
      passed: boolean;
      description: string;
      step_id: string;
      error?: string;
      hint?: import('./types').ImpairmentCoherenceHint;
    };
    const results: CoherenceResult[] = [];

    for (const snap of snapshots) {
      const isTerminal = Boolean(snap.status && !NON_TERMINAL_MEDIA_BUY_STATUSES.has(snap.status));

      // Health-iff-impairments check. The spec ties the two together — a
      // buy with non-empty impairments[] MUST report `health: "impaired"`,
      // and an `impaired` health MUST have at least one impairment entry.
      // Skip on terminal buys (the spec's terminal carve-out lets the
      // seller stop tracking impairments, which makes the biconditional
      // moot) and on snapshots that omit `health` entirely (sellers
      // without health scoring grade silent).
      if (!isTerminal && snap.health !== undefined) {
        const hasImpairments = snap.impairments.length > 0;
        const isImpaired = snap.health === 'impaired';
        if (hasImpairments !== isImpaired) {
          const message =
            `media_buy ${snap.media_buy_id} health="${snap.health}" but impairments[] has ` +
            `${snap.impairments.length} entries. ` +
            `Spec: health MUST be "impaired" iff impairments[] is non-empty (adcp#2859).`;
          results.push({
            passed: false,
            description,
            step_id: stepResult.step_id,
            error: message,
            hint: {
              kind: 'impairment_coherence_violation',
              violation: 'health',
              message,
              media_buy_id: snap.media_buy_id,
              buy_step_id: snap.stepId,
              buy_health: snap.health,
              impairments_count: snap.impairments.length,
            },
          });
        }
      }

      // Forward check. Every impairment entry must reference a resource the
      // runner has observed in an offline state. If we have an observation
      // and it's NOT offline, the seller is reporting a phantom impairment;
      // if we have no observation at all, grade silent (can't disprove).
      for (const entry of snap.impairments) {
        const key = `${entry.resource_type}:${entry.resource_id}`;
        const offline = IMPAIRMENT_OFFLINE_STATUS.get(entry.resource_type);
        if (!offline) continue; // property or unknown family — skip silently
        if (state.offlineResources.has(key)) continue; // ok, we agree it's offline

        const lastStatus = state.resourceStatus.get(key);
        if (!lastStatus) continue; // never observed — can't grade

        const offlineList = [...offline].sort().join(', ');
        const message =
          `media_buy ${snap.media_buy_id} impairments[] references ${entry.resource_type} ` +
          `${entry.resource_id}, but its last observed status is "${lastStatus.status}" (step "${lastStatus.stepId}"). ` +
          `Offline statuses for ${entry.resource_type}: ${offlineList}.`;
        results.push({
          passed: false,
          description,
          step_id: stepResult.step_id,
          error: message,
          hint: {
            kind: 'impairment_coherence_violation',
            violation: 'forward',
            message,
            media_buy_id: snap.media_buy_id,
            buy_step_id: snap.stepId,
            resource_type: entry.resource_type,
            resource_id: entry.resource_id,
            resource_status: lastStatus.status,
            resource_step_id: lastStatus.stepId,
            impairments_count: snap.impairments.length,
          },
        });
      }

      // Inverse check (creative only). For each creative_id the buy
      // references via packages[].creative_assignments[].creative_id, if
      // the runner has it in the offline set AND the buy is non-terminal
      // AND the impairments[] list doesn't mention it, the seller failed
      // to propagate the resource state into the buy. Audience / catalog /
      // event-source inverse coverage is intentionally deferred: their
      // buy-side reference shape isn't yet stable enough in the cached
      // schema to extract without ambiguity. Tracked in adcp#2860.
      if (isTerminal) continue;

      const impairedCreativeIds = new Set(
        snap.impairments.filter(e => e.resource_type === 'creative').map(e => e.resource_id)
      );
      for (const creativeId of snap.referencedCreativeIds) {
        const key = `creative:${creativeId}`;
        const offline = state.offlineResources.get(key);
        if (!offline) continue;
        if (impairedCreativeIds.has(creativeId)) continue;
        const message =
          `media_buy ${snap.media_buy_id} (status="${snap.status ?? 'unknown'}") references creative ` +
          `${creativeId} which is offline (status="${offline.status}", step "${offline.stepId}"), ` +
          `but impairments[] does not list it. Spec: any offline resource referenced by a ` +
          `non-terminal buy MUST appear in impairments[] (adcp#2859).`;
        results.push({
          passed: false,
          description,
          step_id: stepResult.step_id,
          error: message,
          hint: {
            kind: 'impairment_coherence_violation',
            violation: 'inverse',
            message,
            media_buy_id: snap.media_buy_id,
            buy_step_id: snap.stepId,
            resource_type: 'creative',
            resource_id: creativeId,
            resource_status: offline.status,
            resource_step_id: offline.stepId,
            impairments_count: snap.impairments.length,
          },
        });
      }
    }

    if (results.length === 0) {
      return [{ passed: true, description, step_id: stepResult.step_id }];
    }
    return results;
  },
  // Emit a run-level summary so the track rollup can distinguish
  // "wired and exercised" from "wired but neither side observed". When
  // either side is missing the assertion is functionally NA — the spec
  // issue explicitly carves out that case rather than treating it as a
  // silent pass with false confidence.
  onEnd: ctx => {
    const state = ctx.state[IMPAIRMENT_STATE_KEY] as ImpairmentCoherenceState | undefined;
    const exercised = Boolean(state?.observedTransition && state?.observedBuySnapshot);
    const results: Omit<import('./types').AssertionResult, 'assertion_id' | 'scope'>[] = [
      {
        passed: true,
        description: 'media_buy.impairments[] coheres with resource state and buy health',
        observation_count: exercised ? 1 : 0,
        status: exercised ? ('pass' as const) : ('silent' as const),
      },
    ];

    // Surface partial inverse-rule coverage. If the run observed at least
    // one offline resource in a deferred family (audience, catalog_item,
    // event_source), the inverse rule's silence on those families is
    // material to this run — naming the gap loudly at the end of the run
    // beats burying it in PR prose and JSDoc.
    if (state) {
      const deferredCounts: { family: string; count: number }[] = [];
      for (const family of INVERSE_DEFERRED_FAMILIES) {
        const count = state.offlineObservationsByFamily.get(family) ?? 0;
        if (count > 0) deferredCounts.push({ family, count });
      }
      if (deferredCounts.length > 0) {
        const summary = deferredCounts.map(d => `${d.family} (${d.count})`).join(', ');
        results.push({
          passed: true,
          description:
            'inverse coverage gap: offline resources observed for families the runner does not yet grade ' +
            'on the inverse rule (creative is graded; audience/catalog_item/event_source are forward-only). ' +
            `Observed: ${summary}. Tracked in adcontextprotocol/adcp#2860.`,
          observation_count: 0,
        });
      }
    }

    return results;
  },
});

/**
 * Dedicated status extractor for the resource families this invariant
 * grades. Returns `(resource_type, resource_id, status)` triples for every
 * shape the spec carries an offline value on. Independent of
 * `status.monotonic`'s `extractStatusObservations` so the new offline
 * statuses (`suspended`, `withdrawn`, `insufficient`) — which monotonic's
 * graphs intentionally don't enumerate — are still observable here.
 */
function extractImpairmentObservations(
  task: string,
  body: Record<string, unknown>
): { resource_type: string; resource_id: string; status: string }[] {
  const out: { resource_type: string; resource_id: string; status: string }[] = [];
  if (task === 'sync_creatives' || task === 'list_creatives') {
    for (const c of asArray(body.creatives)) {
      if (!isObject(c)) continue;
      const id = asString(c.creative_id);
      const status = asString(c.status);
      if (id && status) out.push({ resource_type: 'creative', resource_id: id, status });
    }
  } else if (task === 'sync_audiences') {
    for (const a of asArray(body.audiences)) {
      if (!isObject(a)) continue;
      const id = asString(a.audience_id);
      const status = asString(a.status);
      if (id && status) out.push({ resource_type: 'audience', resource_id: id, status });
    }
  } else if (task === 'sync_catalogs' || task === 'list_catalogs') {
    // Two response shapes: catalogs[].items[] (nested) or items[] (flat).
    // Heterogeneous item ids — prefer `item_id` (spec-canonical), then
    // `offering_id` (SI), `sku` (retail), else `id`. Matches the fallback
    // chain in `pushCatalogItem`.
    const collect = (item: Record<string, unknown>) => {
      const id = asString(item.item_id) ?? asString(item.offering_id) ?? asString(item.sku) ?? asString(item.id);
      const status = asString(item.status);
      if (id && status) out.push({ resource_type: 'catalog_item', resource_id: id, status });
    };
    for (const cat of asArray(body.catalogs)) {
      if (!isObject(cat)) continue;
      for (const item of asArray(cat.items)) if (isObject(item)) collect(item);
    }
    for (const item of asArray(body.items)) if (isObject(item)) collect(item);
  } else if (task === 'sync_event_sources') {
    for (const es of asArray(body.event_sources)) {
      if (!isObject(es)) continue;
      const id = asString(es.event_source_id);
      // event_source health lives under `health.status` per
      // `core/event-source-health.json`; the top-level enum is
      // `assessment-status.json` (`insufficient | minimum | good | excellent`).
      const health = isObject(es.health) ? es.health : undefined;
      const status = health ? asString(health.status) : undefined;
      if (id && status) out.push({ resource_type: 'event_source', resource_id: id, status });
    }
  }
  return out;
}

/**
 * Extract every media-buy snapshot present on a step response. Walks
 * `create_media_buy` / `update_media_buy` (top-level buy object) and
 * `get_media_buys` (`media_buys[]` array). Returns each snapshot's
 * impairments[], health, status, and the set of `creative_id`s the buy
 * references through `packages[].creative_assignments[]` — used by the
 * inverse rule.
 */
function extractBuySnapshots(task: string, body: Record<string, unknown>, stepId: string): BuySnapshot[] {
  const out: BuySnapshot[] = [];
  if (task === 'create_media_buy' || task === 'update_media_buy') {
    const snap = readBuySnapshot(body, stepId);
    if (snap) out.push(snap);
  } else if (task === 'get_media_buys') {
    for (const mb of asArray(body.media_buys)) {
      if (!isObject(mb)) continue;
      const snap = readBuySnapshot(mb, stepId);
      if (snap) out.push(snap);
    }
  }
  return out;
}

function readBuySnapshot(record: Record<string, unknown>, stepId: string): BuySnapshot | undefined {
  const media_buy_id = asString(record.media_buy_id);
  if (!media_buy_id) return undefined;
  const status = asString(record.status);
  const health = asString(record.health);
  const impairments: ImpairmentEntry[] = [];
  for (const entry of asArray(record.impairments)) {
    if (!isObject(entry)) continue;
    const resource_type = asString(entry.resource_type);
    const resource_id = asString(entry.resource_id);
    if (!resource_type || !resource_id) continue;
    impairments.push({ resource_type, resource_id });
  }
  const referencedCreativeIds = new Set<string>();
  for (const pkg of asArray(record.packages)) {
    if (!isObject(pkg)) continue;
    for (const ca of asArray(pkg.creative_assignments)) {
      if (!isObject(ca)) continue;
      const cid = asString(ca.creative_id);
      if (cid) referencedCreativeIds.add(cid);
    }
  }
  return { media_buy_id, status, health, impairments, referencedCreativeIds, stepId };
}
