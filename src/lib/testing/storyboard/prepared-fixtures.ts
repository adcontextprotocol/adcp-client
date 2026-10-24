/**
 * Reusable fixture-preparation state, its binding identity, and the
 * every-lookup authorization gate.
 *
 * `prepareStoryboardFixtures` (in `runner.ts`) resolves a storyboard's
 * fixture graph once and returns a `PreparedStoryboardFixtures`. Both the
 * full runner and the standalone step runner can then execute against that
 * pinned selection instead of re-discovering — or, in the standalone case
 * today, silently transmitting literal authored handles.
 *
 * Two boundaries live here, and they are deliberately independent:
 *
 * **1. Binding coherence (portable, SDK-owned).** Prepared state is pinned
 * to the storyboard content, the resolved seller route, the exact schema
 * artifact in use, the contract version, the account/sandbox scope, a
 * nonsecret credential identity, and the run id. Reuse under a different
 * binding is a terminal failure, not a silent re-pick: retrying must not be
 * able to launder a failed preparation into a freshly discovered alternative.
 *
 * **2. Authorization (hosted, NOT implemented here).** Resolving a principal
 * from a session, storing grants, and revoking them are host duties. This
 * module mandates the integration shape — an authorizer consulted on *every*
 * lookup, before any snapshot is disclosed and before any dependent wire
 * call — and fails closed when a reference is supplied without one. It does
 * not implement a grant service, and nothing here should be read as claiming
 * that an SDK-local check substitutes for one.
 *
 * ## What is deliberately NOT authority
 *
 * An opaque or sealed reference, a successful decryption, a caller-supplied
 * `context_provenance` map, a principal string in caller JSON, a
 * seller-authored authorization boolean, or a structurally identical frozen
 * object are all reachable from untrusted input. None of them produce the
 * runtime capability this module requires. The capability is object identity
 * held in a module-private `WeakSet`: a `structuredClone`, a JSON round-trip,
 * or a hand-built look-alike is rejected, which is what stops "I have state
 * that looks prepared" from becoming "I am authorized".
 *
 * ## Process scope, stated plainly
 *
 * Because the capability is a live object identity and the credential
 * fingerprint is keyed by a per-process random HMAC key, prepared state is
 * **not portable across processes**. That is a deliberate limit, not an
 * oversight: a frozen JSON snapshot that survived a process boundary carries
 * no evidence that its grant is still live. Multi-process and durable reuse
 * require authenticated reconstruction, or a host-side reference lookup that
 * re-checks live scope — see `docs/guides/COLLECTION-FIXTURE-FOUNDATION.md`.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getActiveSchemaArtifactLocation } from '../../validation/schema-loader';
import { ADCP_VERSION } from '../../version';
import type { CollectionSelectionWitness } from './collection-selection';
import type { FixtureBindingRegistry } from './fixture-resolution';
import type {
  ContextProvenanceEntry,
  FixtureResolutionCoverageGap,
  FixtureResolutionRecord,
  Storyboard,
  StoryboardPhaseResult,
} from './types';

/**
 * Version of the prepared-state contract itself. A prepared state produced
 * under one contract version is never consumed under another: an older
 * runner must fail closed rather than reinterpret bindings it does not
 * understand.
 */
export const PREPARED_FIXTURES_CONTRACT_VERSION = '1.0.0';

/**
 * The single refusal sentence every reference-shaped lookup answers with.
 *
 * One constant rather than three literals: the whole point is that the text
 * cannot vary with whether the reference existed, resolved to trusted
 * state, or was simply not the caller's, and three copies drift.
 */
const REFERENCE_REFUSAL_DETAIL = 'prepared fixture state was refused by the configured authorizer';

/** Identity of the schema artifact validation resolved against. */
export interface PreparedSchemaArtifact {
  /** AdCP version the run pinned. */
  adcp_version: string;
  /** Bundle key the loader resolved that version to. */
  bundle_key: string;
  /** True when a caller-supplied external bundle was authoritative. */
  external: boolean;
  /**
   * Digest over the bundle tree's file inventory (relative path, byte size,
   * mtime) at the moment that root was FIRST resolved in this process.
   *
   * It detects reuse against a different resolved bundle root — the case a
   * `withExternalSchemaRoot` scope or a version change produces. It does NOT
   * detect in-place mutation of a root already observed: the digest is
   * cached per root for the process lifetime, so prepared and current
   * bindings would both read the same cached value. It is also not a
   * publisher-signed content digest. Treat it as bundle identity at first
   * observation, nothing stronger.
   */
  digest: string;
}

/** Nonsecret binding identity. Never contains a credential. */
export interface PreparedFixtureBinding {
  storyboard_id: string;
  /** SHA-256 over the canonicalized storyboard document. */
  storyboard_digest: string;
  /**
   * Resolved seller route(s), with credential material removed.
   *
   * A route URL can carry userinfo or query-string tokens, and this binding
   * is handed to the host authorizer (which a host will reasonably log for
   * audit) and exposed on the public accessor. The raw form must not
   * survive. Diff fidelity is preserved by `agent_route_fingerprint`, so two
   * routes differing only in credentials still refuse reuse.
   */
  agent_urls: string[];
  /**
   * The ONE route preparation actually contacted, positionally.
   *
   * `agent_urls` is sorted and `agent_route_fingerprint` sorts by key, so
   * neither records which of several routes the graph was pinned against.
   * Diffed, so a state pinned from one seller cannot be reused by a run
   * that would dispatch its pinned entities to another.
   */
  fixture_agent_url: string;
  /** Keyed fingerprint over the RAW routes, so redaction cannot merge two. */
  agent_route_fingerprint: string;
  schema_artifact: PreparedSchemaArtifact;
  contract_version: string;
  /**
   * Resolved account scope the graph was prepared under, taken from the same
   * `resolveAccount` the discovery call uses, so a run that switches account
   * cannot inherit another account's pinned catalog.
   *
   * Today `resolveAccount` derives `operator` from `brand.domain`, so this
   * is effectively the brand domain — one dimension, not two. Note also that
   * an unbranded run falls back to the SDK's default brand, which means all
   * unbranded runs share one scope. Multi-tenant hosts must not rely on this
   * field alone for isolation; that is what the authorizer is for.
   */
  account_scope: string;
  /**
   * The brand the graph was DISCOVERED under, canonicalized.
   *
   * Separate from `account_scope` because discovery resolves it separately:
   * `context.brand` wins over the account's brand, which wins over the
   * SDK default. A graph pinned against one advertiser's catalog must not be
   * reused under another's, and the authorizer needs a field it can refuse
   * on rather than two byte-identical payloads.
   */
  brand_scope: string;
  /**
   * The account the STEP's request will actually carry, when the step
   * authors one that overrides the context account.
   *
   * `resolveMediaBuyAccount` lets an authored `sample_request.account` with
   * an `account_id` or `operator` win over `context.account`, so
   * `account_scope` alone can describe an account the request never uses.
   * Absent when the step authors no overriding identity — then
   * `account_scope` is the effective one.
   *
   * NOT diffed, for the same reason `step_credential_fingerprint` is not:
   * it is per-step, so a preparation (which has no step) would mismatch
   * every step that sets it. It needs no diff to be safe — an authored
   * account lives in the storyboard body, which `storyboard_digest`
   * already pins. It is here so the authorizer is told the truth about
   * which account the call is about to transact under.
   */
  request_account_scope?: string;
  /** Sandbox flag in scope. */
  sandbox: boolean;
  /**
   * Caller-declared nonsecret principal. Supplied via
   * `options.prepared_fixtures_principal`; absent when the caller did not
   * declare one, which a host authorizer may itself choose to refuse.
   */
  principal?: string;
  /**
   * HMAC fingerprint of the transport credential under a per-process random
   * key. It detects a credential change between preparation and reuse while
   * disclosing nothing about the credential and remaining useless outside
   * this process. Never a token, never reversible, never an authorization.
   */
  credential_fingerprint: string;
  /**
   * Effective credential for the STEP about to execute, including its own
   * `auth` directive. Present only when the step in scope DECLARES its own
   * `auth`; a step that inherits the run credential produces no field, so an
   * absent value means "inherits", not "no step".
   *
   * Deliberately NOT part of `BINDING_FIELDS`: preparation has no step, so
   * diffing it would refuse every legitimate reuse. It exists so the host
   * authorizer can see what the step will actually dispatch with — the
   * `security_baseline` probes deliberately dispatch unauthenticated or
   * with an invalid key — and refuse on its own terms. Like the run
   * fingerprint it is an HMAC under a per-process key, never the credential.
   */
  step_credential_fingerprint?: string;
  /**
   * Nonsecret companion to `step_credential_fingerprint`: whether the step
   * dispatches with NO credential, with one it authored itself, or with the
   * credential of the specialism route it is dispatched to. The fingerprint
   * is keyed per process, so a host can see that it changed but not what it
   * is; this is the value an authorizer can branch on.
   */
  step_auth_kind?: 'none' | 'override' | 'routed';
  /**
   * `<specialism key>@<redacted url>` the step actually dispatches to, when
   * the run uses per-specialism routing.
   *
   * `agent_urls` is the sorted set of EVERY route in the run and says
   * nothing about which one this step uses, so an authorizer scoping a
   * grant to one seller had no field to refuse on. Also NOT diffed —
   * preparation has no step.
   */
  step_route?: string;
  /** Identity of the preparation run. */
  run_id: string;
}

/**
 * Why a lookup was refused. Surfaces verbatim as the `actual` of the
 * `prepared_fixtures_authorization` validation, so this union IS the
 * output contract a report consumer can switch on.
 */
export type PreparedFixturesRefusalCode =
  | 'untrusted_state'
  | 'binding_mismatch'
  | 'authorizer_required'
  | 'authorizer_denied'
  | 'contract_version_mismatch'
  /**
   * Caller-supplied `context`, `context_provenance` or
   * `response_derived_not_applicable_context_keys` carried a reserved or
   * prototype-sensitive key. Raised by the runner's pre-contact screen
   * rather than by `resolvePreparedFixtures`, but it grades through the
   * same validation, so a consumer typing on this union would otherwise
   * meet a value the union does not admit.
   */
  | 'unauthorized_metadata';

export interface PreparedFixturesRefusal {
  code: PreparedFixturesRefusalCode;
  detail: string;
}

/** Context handed to the host authorizer on every lookup. */
export interface PreparedFixturesLookup {
  /** Nonsecret binding recorded at preparation time. */
  binding: PreparedFixtureBinding;
  /** Nonsecret binding observed right now, after routing and auth overrides. */
  current: PreparedFixtureBinding;
  /** Storyboard step about to execute, when the lookup is per-step. */
  step_id?: string;
  /**
   * Which gate asked.
   *
   * A run makes one `run` lookup, one `pass` lookup per pass, and one `step`
   * lookup per step. A host implementing "every lookup is a fresh grant use"
   * literally — consume-once token, nonce, strict counter — needs to tell
   * them apart rather than seeing byte-identical payloads.
   */
  gate?: 'run' | 'pass' | 'step';
  /** Opaque reference the caller presented, when reuse came through one. */
  reference?: string;
}

/**
 * A host authorizer's answer. `authorized` must be literally `true`.
 *
 * **`detail` is echoed to the caller** when the refusal came from DIRECT
 * state — it is the only specific diagnostic a legitimate operator gets,
 * which is why it is not swallowed. It is your text, so keep
 * infrastructure addresses, scoped keys and credential material out of
 * it. A refusal that came through an opaque REFERENCE never echoes it:
 * a denial reading "not yours" would confirm the reference existed.
 */
export type PreparedFixturesDecision = { authorized: true } | { authorized: false; detail: string };

/**
 * Host-supplied authorization resolver, consulted on EVERY lookup.
 *
 * Implementations must resolve the principal/tenant/org and run from trusted
 * server session state (never from the request body), re-check the current
 * grant, revocation and expiry, and re-check effective per-step credential
 * scope after any routing or auth override. A decision made at preparation
 * time is not reusable: a grant revoked after a successful prior step must
 * fail the next one.
 */
export type PreparedFixturesAuthorizer = (
  lookup: PreparedFixturesLookup
) => PreparedFixturesDecision | Promise<PreparedFixturesDecision>;

/** Fresh preparation scope, computed locally before any seller contact. */
export interface PreparedFixturesPreparationLookup {
  readonly gate: 'prepare';
  /** The proposed scope; no stored binding or opaque reference exists yet. */
  readonly current: PreparedFixtureBinding;
}

/**
 * Asked once by prepareStoryboardFixtures before client creation. Only a
 * literal authorized: true grants. Refusal detail is never echoed to the
 * caller; private evidence goes to prepared_fixtures_audit_sink.
 * This grant never replaces the separate every-lookup reuse authorizer.
 */
export type PreparedFixturesPreparationAuthorizer = (
  lookup: PreparedFixturesPreparationLookup
) => PreparedFixturesDecision | Promise<PreparedFixturesDecision>;

/** @internal Refuse a preparation-only security option on other entry points. */
export function assertNoPreparationAuthorizer(options: object): void {
  if (
    (options as { prepared_fixtures_preparation_authorizer?: unknown }).prepared_fixtures_preparation_authorizer !==
    undefined
  ) {
    throw new Error(
      'prepared_fixtures_preparation_authorizer is supported only by prepareStoryboardFixtures(). ' +
        'Prepare the storyboard explicitly, then authorize reuse with prepared_fixtures_authorizer.'
    );
  }
}

/**
 * A reference to prepared state held in the host's authenticated run scope.
 *
 * The SDK cannot resolve one on its own — it has no session, no tenant and
 * no grant store — so a reference without a `resolve` hook fails closed.
 */
export interface PreparedFixturesReference {
  /** Opaque host-owned identifier. Not authority by itself. */
  ref: string;
  /**
   * Host resolver returning the in-process prepared state for `ref`. Invoked
   * on every lookup, so the host sees each use and can refuse a revoked one.
   */
  resolve: (ref: string) => PreparedStoryboardFixtures | undefined | Promise<PreparedStoryboardFixtures | undefined>;
}

/** Per-handle state the resolver pinned, exposed read-only. */
export interface PreparedFixtureSelection {
  handle: string;
  fixture_type: FixtureResolutionRecord['fixture_type'];
  product_handle?: string;
  seller_ids: NonNullable<FixtureResolutionRecord['seller_ids']>;
}

export interface PreparedStoryboardFixturesInit {
  binding: PreparedFixtureBinding;
  bindings?: FixtureBindingRegistry;
  resolutions: FixtureResolutionRecord[];
  coverageGaps: FixtureResolutionCoverageGap[];
  captures: Record<string, unknown>;
  captureProvenance: Record<string, ContextProvenanceEntry>;
  witnesses: Record<string, CollectionSelectionWitness>;
  /** Terminal preparation outcome, carried forward verbatim on reuse. */
  disposition: PreparedFixturesDisposition;
  phase?: StoryboardPhaseResult;
}

export type PreparedFixturesDisposition =
  /** Every declared fixture resolved; captures are published. */
  | { status: 'resolved' }
  /** A declared strategy ladder exhausted with no binding. */
  | { status: 'unsatisfied'; detail: string }
  /** Discovery, schema validation or setup failed. Terminal. */
  | { status: 'failed'; detail: string }
  /** The agent cannot be graded for this storyboard's fixtures. */
  | { status: 'unsupported'; detail: string };

const trustedStates = new WeakSet<PreparedStoryboardFixtures>();

/** Registry access is a capability, not a property. */
const registries = new WeakMap<PreparedStoryboardFixtures, FixtureBindingRegistry>();

/** Local deep freeze; the context module's copy is not importable here. */
function freezeDeepLocal<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeepLocal(nested);
  return value;
}

/**
 * Module-private construction token.
 *
 * A documentation tag on a constructor is not access control:
 * the class value is exported so hosts can `instanceof` it, and without this
 * any in-process caller could `new PreparedStoryboardFixtures({ binding })`
 * with a binding copied off a legitimate state and be fully trusted — with
 * the host authorizer seeing a byte-identical binding and no signal at all.
 * Requiring a token only this module holds makes the trust registry
 * unforgeable from outside the MODULE. It is not a defence against code
 * that can already load the module; the `exports` map simply gives no
 * package consumer a path to it.
 */
const CONSTRUCTION_TOKEN: unique symbol = Symbol('adcp.preparedStoryboardFixtures');

/**
 * Immutable prepared fixture state.
 *
 * Instances are produced only by `prepareStoryboardFixtures`. The public
 * accessors (`binding`, `disposition`, `resolutions`, `coverageGaps`,
 * `selections`, `captures`, `captureProvenance`, `witnesses`) hand back
 * detached clones, so a consumer that mutates what it reads cannot reach the
 * pinned selection. `phase` is cloned on ingestion as well as on read, so
 * the object the constructor was handed is not the canonical copy either.
 */
export class PreparedStoryboardFixtures {
  readonly #binding: PreparedFixtureBinding;
  readonly #resolutions: readonly FixtureResolutionRecord[];
  readonly #coverageGaps: readonly FixtureResolutionCoverageGap[];
  readonly #captures: Readonly<Record<string, unknown>>;
  readonly #captureProvenance: Readonly<Record<string, ContextProvenanceEntry>>;
  readonly #witnesses: Readonly<Record<string, CollectionSelectionWitness>>;
  readonly #disposition: PreparedFixturesDisposition;
  readonly #phase: StoryboardPhaseResult | undefined;

  /**
   * @internal Constructed only by `prepareStoryboardFixtures`. The token is
   * module-private, so an external `new` call cannot satisfy it.
   */
  constructor(init: PreparedStoryboardFixturesInit, token: typeof CONSTRUCTION_TOKEN) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new Error(
        'PreparedStoryboardFixtures cannot be constructed directly; call prepareStoryboardFixtures() to produce prepared state'
      );
    }
    this.#binding = freezeDeepLocal(structuredClone(init.binding));
    if (init.bindings) registries.set(this, init.bindings);
    this.#resolutions = Object.freeze(structuredClone(init.resolutions));
    this.#coverageGaps = Object.freeze(structuredClone(init.coverageGaps));
    this.#captures = Object.freeze(structuredClone(init.captures));
    this.#captureProvenance = Object.freeze(structuredClone(init.captureProvenance));
    this.#witnesses = Object.freeze(structuredClone(init.witnesses));
    this.#disposition = freezeDeepLocal(structuredClone(init.disposition));
    // Cloned on ingestion: the caller keeps a live reference to the object
    // it passed, and that must not be the canonical copy.
    this.#phase = init.phase === undefined ? undefined : (structuredClone(init.phase) as StoryboardPhaseResult);
    trustedStates.add(this);
    Object.freeze(this);
  }

  /** Nonsecret binding identity. Detached copy. */
  get binding(): PreparedFixtureBinding {
    return structuredClone(this.#binding);
  }

  get disposition(): PreparedFixturesDisposition {
    return structuredClone(this.#disposition);
  }

  /** Machine-readable per-handle resolution evidence. Detached copy. */
  get resolutions(): FixtureResolutionRecord[] {
    return structuredClone(this.#resolutions) as FixtureResolutionRecord[];
  }

  /** Coverage gaps observed during preparation. Detached copy. */
  get coverageGaps(): FixtureResolutionCoverageGap[] {
    return structuredClone(this.#coverageGaps) as FixtureResolutionCoverageGap[];
  }

  /** Pinned seller identities per handle. Detached copy. */
  get selections(): PreparedFixtureSelection[] {
    return this.#resolutions
      .filter(record => record.seller_ids !== undefined)
      .map(record => ({
        handle: record.handle,
        fixture_type: record.fixture_type,
        ...(record.product_handle && { product_handle: record.product_handle }),
        seller_ids: structuredClone(record.seller_ids!),
      }));
  }

  /** Reserved-namespace captures. Detached copy. */
  get captures(): Record<string, unknown> {
    return structuredClone(this.#captures) as Record<string, unknown>;
  }

  /** Capture provenance. Detached copy. */
  get captureProvenance(): Record<string, ContextProvenanceEntry> {
    return structuredClone(this.#captureProvenance) as Record<string, ContextProvenanceEntry>;
  }

  /** Retained collection witnesses per handle. Detached copy. */
  get witnesses(): Record<string, CollectionSelectionWitness> {
    return structuredClone(this.#witnesses) as Record<string, CollectionSelectionWitness>;
  }

  /**
   * Detached copy of the synthetic pre-flight phase, for attachment to a
   * full run's report. A live reference would let a report consumer mutate
   * the preparation's own evidence — including a failed or no-match
   * disposition's raw failure detail.
   */
  get phase(): StoryboardPhaseResult | undefined {
    return this.#phase === undefined ? undefined : (structuredClone(this.#phase) as StoryboardPhaseResult);
  }
}

// Trusted reads must not be redirected through a caller-replaced accessor.
Object.freeze(PreparedStoryboardFixtures.prototype);

/**
 * Read the fixture binding registry out of prepared state.
 *
 * Not exported, and no exported signature names the token: the registry
 * exposes mutable maps and live `bindProduct` / `bindPricingOption`
 * registration, so handing it out through the public surface would let any
 * holder of a prepared state re-point a pinned handle at a different seller
 * entity.
 */
function readPreparedBindingRegistry(state: PreparedStoryboardFixtures): FixtureBindingRegistry | undefined {
  return registries.get(state);
}

/**
 * @internal Runner-side accessor.
 *
 * Scope note, stated precisely: the token makes the trust registry
 * unforgeable from outside THIS MODULE. It is not a defence against code
 * that can already load the module — the package `exports` map has no
 * wildcard reaching `dist/lib/testing/storyboard/*`, so that requires
 * arbitrary in-process execution, which is not a distinct capability.
 */
export function preparedBindingRegistryFor(state: PreparedStoryboardFixtures): FixtureBindingRegistry | undefined {
  return readPreparedBindingRegistry(state);
}

/** @internal Factory for `prepareStoryboardFixtures`. */
export function createPreparedStoryboardFixtures(init: PreparedStoryboardFixturesInit): PreparedStoryboardFixtures {
  return new PreparedStoryboardFixtures(init, CONSTRUCTION_TOKEN);
}

/**
 * Pair prepared state with its authorizer, so neither can be supplied
 * without the other.
 *
 * `prepared_fixtures` and `prepared_fixtures_authorizer` are both optional
 * on `StoryboardRunOptions`, which means the one thing the guide calls a
 * requirement rather than optional hardening compiles clean when omitted —
 * every hosted integrator discovered it by running it. Spread the result
 * and the compiler asks for the authorizer:
 *
 * ```ts
 * const result = await runStoryboardStep(agentUrl, storyboard, stepId, {
 *   ...options,
 *   ...withPreparedFixtures(prepared, authorize),
 * });
 * ```
 *
 * The raw fields still work; this is ergonomics, not enforcement. The
 * enforcement is the fail-closed refusal in `resolvePreparedFixtures`.
 */
export function withPreparedFixtures(
  state: PreparedStoryboardFixtures | PreparedFixturesReference,
  authorizer: PreparedFixturesAuthorizer
): {
  prepared_fixtures: PreparedStoryboardFixtures | PreparedFixturesReference;
  prepared_fixtures_authorizer: PreparedFixturesAuthorizer;
} {
  return { prepared_fixtures: state, prepared_fixtures_authorizer: authorizer };
}

/**
 * True only for a state produced by this process's
 * `prepareStoryboardFixtures`. A JSON-rehydrated copy, a `structuredClone`,
 * a hand-built object with the same public shape, and a direct `new` call
 * all return false.
 */
export function isTrustedPreparedFixtures(value: unknown): value is PreparedStoryboardFixtures {
  return value instanceof PreparedStoryboardFixtures && trustedStates.has(value);
}

// ────────────────────────────────────────────────────────────
// Binding identity
// ────────────────────────────────────────────────────────────

/**
 * Per-process HMAC key for credential fingerprints.
 *
 * Regenerated on every process start and never persisted, so a fingerprint
 * cannot be correlated across processes or brute-forced offline against a
 * low-entropy token. Its only job is to answer "is this the same credential
 * the graph was prepared with, in this process?".
 */
const CREDENTIAL_FINGERPRINT_KEY = randomBytes(32);

/** @internal Visible for tests that assert non-portability. */
export function fingerprintCredential(secret: string): string {
  // Not a password verifier and not a credential-storage primitive: this is
  // an in-process equality tag over the run's credential material, used only
  // to detect that the credential CHANGED between preparation and reuse.
  //
  // A work-factor KDF would be the wrong primitive here, not a stronger one.
  // The security property comes from `CREDENTIAL_FINGERPRINT_KEY` — 32 random
  // bytes generated at process start, never persisted and never transmitted —
  // so the output is not brute-forceable by anyone who does not already hold
  // process memory, and therefore the credential itself. The fingerprint is
  // recomputed on every per-step lookup, so a deliberately slow KDF would add
  // latency to every step of every run for no security gain.
  // codeql[js/insufficient-password-hash]
  return createHmac('sha256', CREDENTIAL_FINGERPRINT_KEY).update(secret).digest('hex').slice(0, 32);
}

/**
 * Strip userinfo and credential-shaped query parameters from a route URL.
 * Deterministic and structure-preserving, so display stays stable.
 */
function redactRouteCredentials(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // routed mode passes `''`; nothing to strip
  }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/(token|secret|key|password|credential|signature|auth)/i.test(key)) {
      url.searchParams.set(key, '[redacted]');
    }
  }
  url.hash = '';
  return url.toString();
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`).join(',')}}`;
}

/**
 * SHA-256 over the canonicalized storyboard document.
 *
 * Deliberately NOT memoized by object identity. A `Storyboard` is a mutable
 * plain object, and caching its digest would preserve the authorized value
 * after a later edit to a request or a fixture declaration — defeating the
 * exact detection this field exists for. The cost is ~1.5 ms on a large
 * storyboard, paid per lookup, which is negligible against wire time and
 * nowhere near worth a stale integrity check.
 */
export function digestStoryboard(storyboard: Storyboard): string {
  return createHash('sha256').update(canonicalize(storyboard)).digest('hex');
}

const schemaDigestCache = new Map<string, string>();

function digestSchemaRoot(root: string): string {
  const cached = schemaDigestCache.get(root);
  if (cached !== undefined) return cached;
  // Seeded with the root PATH. Without it an unreadable or missing root
  // walked to zero lines and digested to sha256(""), so two different
  // broken roots compared equal and a broken root compared equal to any
  // other broken root — the binding would say "same schema artifact"
  // about two it had never read.
  const lines: string[] = [`root\u0000${root}`];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Recorded, not skipped: an unreadable directory is a real
      // difference between two roots and must not digest identically to
      // an empty one.
      lines.push(`${rel || '.'}\u0000unreadable-dir`);
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const absolute = path.join(dir, entry.name);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      try {
        const stat = statSync(absolute);
        lines.push(`${relative}\u0000${stat.size}\u0000${stat.mtimeMs}`);
      } catch {
        lines.push(`${relative}\u0000unreadable`);
      }
    }
  };
  walk(root, '');
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  schemaDigestCache.set(root, digest);
  return digest;
}

/** Resolve the schema artifact identity currently in effect. */
export function resolveSchemaArtifact(adcpVersion: string = ADCP_VERSION): PreparedSchemaArtifact {
  const location = getActiveSchemaArtifactLocation(adcpVersion);
  return {
    adcp_version: adcpVersion,
    bundle_key: location.bundle_key,
    external: location.external,
    digest: digestSchemaRoot(location.root),
  };
}

export interface BuildPreparedBindingInput {
  storyboard: Storyboard;
  agentUrls: string[];
  adcpVersion?: string;
  accountScope: string;
  brandScope: string;
  /** Account the step's own request authors, when it overrides the context. */
  requestAccountScope?: string;
  /** `[specialism key, url]` pairs, when the run uses per-specialism routing. */
  agentRouteMap?: Array<[string, string]>;
  sandbox: boolean;
  /** Effective step credential, when a step is in scope. */
  stepCredential?: string;
  /** Whether that step drops the credential entirely, overrides it, or inherits a route's. */
  stepAuthKind?: 'none' | 'override' | 'routed';
  /** `<specialism key>@<redacted url>` this step dispatches to, when routed. */
  stepRoute?: string;
  principal?: string;
  credential: string;
  runId?: string;
}

export function buildPreparedBinding(input: BuildPreparedBindingInput): PreparedFixtureBinding {
  return {
    storyboard_id: input.storyboard.id,
    storyboard_digest: digestStoryboard(input.storyboard),
    agent_urls: [...input.agentUrls].sort().map(redactRouteCredentials),
    // The route the GRAPH was pinned against, positionally — preparation
    // contacts exactly one agent, `agentUrls[0]`, and nothing else in the
    // binding records which one that was. `agent_urls` is sorted and
    // `agent_route_fingerprint` sorts by key, both deliberately
    // order-insensitive, so two runs whose `agents` maps differ only in
    // insertion order produced byte-identical bindings while preparation
    // had actually read seller B's catalog for one and seller A's for the
    // other. Reuse across them sent B's pinned product_id to A.
    fixture_agent_url: redactRouteCredentials(input.agentUrls[0] ?? ''),
    // Covers the specialism→URL PAIRING, not just the URL set. Sorting the
    // set alone meant swapping two specialisms' routes left the fingerprint
    // unchanged while every per-specialism credential went to a different
    // seller.
    agent_route_fingerprint: fingerprintCredential(
      JSON.stringify([
        [...input.agentUrls].sort(),
        input.agentRouteMap ? [...input.agentRouteMap].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null,
        // The RAW positional first url — the one preparation contacts.
        // `fixture_agent_url` beside it is redacted for the authorizer to
        // read, so two routes differing only in userinfo or a credential
        // query parameter render identically there and would have
        // collapsed into one binding.
        input.agentUrls[0] ?? null,
      ])
    ),
    schema_artifact: resolveSchemaArtifact(input.adcpVersion ?? ADCP_VERSION),
    contract_version: PREPARED_FIXTURES_CONTRACT_VERSION,
    account_scope: input.accountScope,
    brand_scope: input.brandScope,
    ...(input.requestAccountScope !== undefined && { request_account_scope: input.requestAccountScope }),
    sandbox: input.sandbox,
    ...(input.principal !== undefined && { principal: input.principal }),
    credential_fingerprint: fingerprintCredential(input.credential),
    ...(input.stepCredential !== undefined && {
      step_credential_fingerprint: fingerprintCredential(input.stepCredential),
    }),
    ...(input.stepAuthKind !== undefined && { step_auth_kind: input.stepAuthKind }),
    // Independent of the credential: a routed step whose credential happens
    // to equal the run's still dispatches to one specific seller.
    ...(input.stepRoute !== undefined && { step_route: input.stepRoute }),
    run_id: input.runId ?? randomUUID(),
  };
}

/** Fields compared on every reuse, in report order. */
const BINDING_FIELDS = [
  'storyboard_id',
  'storyboard_digest',
  'agent_urls',
  'agent_route_fingerprint',
  'fixture_agent_url',
  'schema_artifact',
  'contract_version',
  'account_scope',
  'brand_scope',
  'sandbox',
  'principal',
  'credential_fingerprint',
] as const;

/**
 * Compare a prepared binding against the binding observed right now.
 *
 * `run_id` is deliberately excluded: it identifies the preparation, and the
 * whole point of reuse is that later steps share it. Everything else must
 * match exactly — a different route, account, sandbox flag, schema artifact,
 * credential or storyboard body means the pinned graph describes a different
 * world than the one about to be called.
 */
export function diffPreparedBinding(prepared: PreparedFixtureBinding, current: PreparedFixtureBinding): string[] {
  const mismatches: string[] = [];
  for (const field of BINDING_FIELDS) {
    if (canonicalize(prepared[field]) !== canonicalize(current[field])) mismatches.push(field);
  }
  return mismatches;
}

export interface ResolvePreparedFixturesInput {
  /** Direct in-process state, or a host reference. */
  supplied: PreparedStoryboardFixtures | PreparedFixturesReference | undefined;
  /** Binding observed now, after routing and per-step auth overrides. */
  current: PreparedFixtureBinding;
  /** Host authorizer. REQUIRED for any reuse; absence fails closed. */
  authorizer?: PreparedFixturesAuthorizer;
  /** Step about to execute, for per-step authorization. */
  stepId?: string;
  /** Which gate is asking. */
  gate?: 'run' | 'pass' | 'step';
}

export type ResolvePreparedFixturesResult =
  | { ok: true; state: PreparedStoryboardFixtures }
  | { ok: false; refusal: PreparedFixturesRefusal };

function isReference(value: unknown): value is PreparedFixturesReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PreparedFixturesReference).ref === 'string' &&
    typeof (value as PreparedFixturesReference).resolve === 'function'
  );
}

/**
 * Resolve and authorize prepared state for ONE lookup.
 *
 * Called before every step that could consume prepared state — not once at
 * run start. Ordering matters and is load-bearing:
 *
 *   1. Establish that the object is genuinely this process's prepared state.
 *   2. Ask the host authorizer, which re-checks live grant and revocation.
 *   3. Only then re-check binding coherence against the CURRENT effective
 *      route, account, sandbox, schema artifact and credential.
 *
 * The authorizer runs BEFORE the binding diff, not after. In the hosted
 * reference flow the host resolver answers for any reference it holds, so
 * diffing first would answer an unauthorized caller's enumerated reference
 * with a mismatch report describing someone else's principal, routes,
 * account and credential fingerprint — and turn the fingerprint into a
 * credential-confirmation oracle. For the same reason the refusal detail
 * names only the FIELDS that differ, never their values.
 *
 * Only after all three does any snapshot become readable. A refusal returns
 * before the caller can read captures and before any dependent wire call.
 */
export async function resolvePreparedFixtures(
  input: ResolvePreparedFixturesInput
): Promise<ResolvePreparedFixturesResult | undefined> {
  const supplied = input.supplied;
  if (supplied === undefined) return undefined;

  // No authorizer, no reuse — for DIRECT in-process state as much as for an
  // opaque reference. Object identity proves where a state came from; it
  // says nothing about whether the grant behind it is still live, and
  // binding coherence observes a reroute or credential change but never a
  // revocation. A warning here would let an unenforced authorization
  // boundary ship while being described as every-lookup enforcement.
  const authorizer = input.authorizer;
  if (!authorizer) {
    return {
      ok: false,
      refusal: {
        code: 'authorizer_required',
        detail: isReference(supplied)
          ? 'prepared_fixtures was supplied as an opaque reference, but no prepared_fixtures_authorizer was configured. An opaque reference is never authorization: supply an authorizer, because the SDK has no session and no grant store and cannot decide whether this reference is still yours.'
          : 'prepared_fixtures reuse requires prepared_fixtures_authorizer. Trusted object identity proves the state came from prepareStoryboardFixtures in this process; it does not establish a current grant, and binding coherence cannot observe revocation. Supply an authorizer that re-checks live grant state on every lookup. If this run genuinely has no grant model (single-tenant CLI, local dev), either drop prepared_fixtures and let the runner re-resolve, or pass prepared_fixtures_authorizer: () => ({ authorized: true }) as an explicit, reviewable decision. See docs/guides/COLLECTION-FIXTURE-FOUNDATION.md section 4.',
      },
    };
  }

  let state: unknown = supplied;
  let reference: string | undefined;
  if (isReference(supplied)) {
    reference = supplied.ref;
    try {
      state = await supplied.resolve(supplied.ref);
    } catch {
      // A host store that throws on a missing row is an ordinary shape. Let
      // it become the same refusal as "not yours" rather than a rejected
      // promise carrying the store's internal text to the caller.
      state = undefined;
    }
  }

  /**
   * One refusal for every pre-authorization failure on a REFERENCE.
   *
   * Identical text, identical machine code, identical validation shape, and
   * the authorizer is still consulted on the not-found path (its answer
   * discarded) so the call count matches too. The direct form keeps its
   * specific codes — that caller already holds the object and learns
   * nothing from them.
   *
   * NOT a constant-time guarantee, and deliberately not claimed as one.
   * The resolving path additionally clones the prepared binding and reads
   * the host's decision, and the host's own resolver does unbounded work
   * on a hit, so a patient attacker with many samples can still
   * distinguish the paths by timing. Closing that would mean padding every
   * refusal to a fixed budget, which the SDK cannot size without knowing
   * the host's store. Hosts that need a timing-invariant answer must pad
   * in the resolver.
   */
  const refuseReference = async (): Promise<ResolvePreparedFixturesResult> => {
    try {
      await authorizer({
        // Cloned, and cloned SEPARATELY, exactly as the authorized path
        // does: handing the same object twice would let an authorizer
        // detect `binding === current` by reference.
        //
        // That closes the object-IDENTITY distinction and nothing more.
        // The VALUES still differ by path — a resolving reference carries
        // the stored preparation binding, this one carries a second copy
        // of `current` — so an authorizer that deep-compares them can
        // still tell a missing reference from a present one. That is not
        // the oracle this branch exists to close: the authorizer IS the
        // host, it owns the store it would be learning about, and it
        // cannot be given a fabricated stored binding without being lied
        // to. What is closed is the oracle available to the CALLER, who
        // sees only the refusal: identical text, identical machine code,
        // identical validation shape, same authorizer call count.
        binding: structuredClone(input.current),
        current: structuredClone(input.current),
        ...(input.stepId !== undefined && { step_id: input.stepId }),
        ...(input.gate !== undefined && { gate: input.gate }),
        ...(reference !== undefined && { reference }),
      });
    } catch {
      // The host's own failure must not separate the two cases either.
    }
    return { ok: false, refusal: { code: 'authorizer_denied', detail: REFERENCE_REFUSAL_DETAIL } };
  };

  if (!isTrustedPreparedFixtures(state)) {
    // For a REFERENCE, collapse into the authorizer's own refusal shape.
    // Distinguishing "no such reference" from "not yours" hands an
    // unauthorized caller a free existence oracle over the host's store.
    // The direct form keeps the specific code: that caller already holds
    // the object and learns nothing new.
    if (reference !== undefined) return refuseReference();
    return {
      ok: false,
      refusal: {
        code: 'untrusted_state',
        detail:
          'prepared fixture state was not produced by prepareStoryboardFixtures in this process; a rehydrated, cloned or caller-constructed look-alike carries no preparation authority',
      },
    };
  }

  const binding = state.binding;
  if (binding.contract_version !== PREPARED_FIXTURES_CONTRACT_VERSION) {
    if (reference !== undefined) return refuseReference();
    return {
      ok: false,
      refusal: {
        code: 'contract_version_mismatch',
        detail: `prepared state declares contract version ${binding.contract_version}; this runner implements ${PREPARED_FIXTURES_CONTRACT_VERSION}`,
      },
    };
  }

  // Both the CALL and the READS of its answer sit inside the guard. A
  // decision object is host-supplied and need not be a plain record — an
  // ORM row, a Proxy or a lazily hydrated object can throw from the
  // property getter, and reading `authorized` outside the try turned that
  // into an exception escaping `runStoryboardStep` instead of a refusal.
  let authorized = false;
  let decisionDetail: string | undefined;
  try {
    const decision: PreparedFixturesDecision | undefined = await authorizer({
      binding: structuredClone(binding),
      current: structuredClone(input.current),
      ...(input.stepId !== undefined && { step_id: input.stepId }),
      ...(input.gate !== undefined && { gate: input.gate }),
      ...(reference !== undefined && { reference }),
    });
    // Strictly `true`. A truthy string, `1`, or a missing field is a
    // malformed decision, and reading a malformed decision as consent is
    // the whole failure mode this gate exists to prevent.
    authorized = decision?.authorized === true;
    // Read through `unknown`: the union narrows `detail` away on the
    // authorized arm, but a host can return any object at runtime.
    const detail: unknown = (decision as { detail?: unknown } | undefined)?.detail;
    decisionDetail = typeof detail === 'string' ? detail : undefined;
  } catch {
    // Host errors may contain grant-store details or secrets. A resolving
    // reference must have the same refusal as a missing reference, even
    // when the authorizer throws. Fail closed for direct state as well.
    return { ok: false, refusal: { code: 'authorizer_denied', detail: REFERENCE_REFUSAL_DETAIL } };
  }
  if (!authorized) {
    // A resolving reference must refuse in exactly the text a nonresolving
    // one does. Echoing the host's `detail` here would reinstate the
    // existence oracle `refuseReference` closes: a host whose denial reads
    // "not yours" would answer a real reference with that sentence and an
    // invented one without it. The host still receives its own detail — it
    // wrote it — so nothing is lost but the echo.
    if (reference !== undefined) {
      return { ok: false, refusal: { code: 'authorizer_denied', detail: REFERENCE_REFUSAL_DETAIL } };
    }
    return {
      ok: false,
      refusal: {
        code: 'authorizer_denied',
        // `detail` is optional, so an absent one must not render as the
        // string "undefined" — a difference in text is a difference a
        // caller can measure.
        detail:
          decisionDetail !== undefined && decisionDetail.length > 0
            ? `prepared fixture state was refused by the configured authorizer: ${decisionDetail}`
            : REFERENCE_REFUSAL_DETAIL,
      },
    };
  }

  const mismatches = diffPreparedBinding(binding, input.current);
  if (mismatches.length > 0) {
    // Collapse for a REFERENCE, like every other arm. The field list is the
    // OWNER's identity attributes when the caller guessed the reference —
    // `principal, credential_fingerprint` tells an enumerating caller both
    // that the row exists and how its owner differs from them — and the
    // diff is redundant on this path anyway, because the host's resolver
    // already chose the row. The protection cannot rest on the authorizer
    // denying: the SDK itself recommends `() => ({ authorized: true })` for
    // single-tenant use, and a session-scoped (rather than
    // reference-scoped) host authorizer lands in exactly this shape.
    if (reference !== undefined) {
      return { ok: false, refusal: { code: 'authorizer_denied', detail: REFERENCE_REFUSAL_DETAIL } };
    }
    return {
      ok: false,
      refusal: {
        code: 'binding_mismatch',
        // Field names only. The values are another principal's identity when
        // the caller guessed a reference, and `credential_fingerprint` must
        // never reach operator-visible text at all.
        detail: `prepared fixture state does not match the current run scope; differing binding field(s): ${mismatches.join(', ')}`,
      },
    };
  }

  return { ok: true, state };
}
