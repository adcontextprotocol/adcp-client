/**
 * Cross-role governance authorization helpers (AdCP 3.2).
 *
 * Intent checks produce a compact JWS that authorizes one exact downstream
 * request. Services verify that token before performing a governed side
 * effect. This module deliberately keeps policy interpretation at the
 * governance agent: service-side code checks only cryptographic and request
 * bindings.
 */

import { createHash } from 'node:crypto';

import { compactVerify, importJWK, type JWK } from 'jose';

import type { AgentConfig } from '../types';
import type { CheckGovernanceRequest, GovernancePhase, PlannedDelivery } from '../types/tools.generated';
import type { AdcpCapabilities } from '../utils/capabilities';
import { canonicalize } from '../utils/jcs';
import type { JwksResolver } from '../signing/jwks';
import type { ReplayStore } from '../signing/replay';
import type { RevocationStore } from '../signing/revocation';
import { parseStrictJson } from '../signing/agent-resolver/strict-json';

export const GOVERNANCE_AUTHORIZATION_CRITICAL_CLAIMS = Object.freeze([
  'authorized_commitment',
  'authorized_task',
  'authorized_payload_hash',
] as const);

export type GovernanceAuthorizationCriticalClaim = (typeof GOVERNANCE_AUTHORIZATION_CRITICAL_CLAIMS)[number];

export type GovernanceEnforcementMode = 'signed_context' | 'online_execution_check';

export interface GovernanceCommitment {
  amount: number;
  currency: string;
}

export interface GovernanceEnforcementTask {
  task: string;
  modes: GovernanceEnforcementMode[];
}

export interface GovernanceAuthorizationClaims extends Record<string, unknown> {
  iss: string;
  sub: string;
  plan_hash: string;
  aud: string;
  iat: number;
  nbf?: number;
  exp: number;
  jti: string;
  phase: string;
  caller: string;
  check_id: string;
  authorized_commitment?: GovernanceCommitment;
  authorized_task?: string;
  authorized_payload_hash?: string;
}

export type GovernanceAuthorizationErrorCode =
  | 'governance_token_invalid'
  | 'governance_key_unknown'
  | 'governance_token_expired'
  | 'governance_token_not_yet_valid'
  | 'governance_token_not_applicable'
  | 'governance_token_replayed'
  | 'governance_token_revoked';

export interface GovernanceAuthorizationSuccess {
  ok: true;
  claims: GovernanceAuthorizationClaims;
  protectedHeader: Record<string, unknown>;
  payloadHash: string;
}

export interface GovernanceAuthorizationFailure {
  ok: false;
  error: GovernanceAuthorizationErrorCode;
  message: string;
}

export type GovernanceAuthorizationResult = GovernanceAuthorizationSuccess | GovernanceAuthorizationFailure;

export interface GovernanceReplayStore {
  /**
   * Atomically consume one `(issuer, audience, jti)` tuple. Only one caller
   * may receive `ok`; concurrent or later consumers receive `replayed`.
   */
  consume(
    issuer: string,
    audience: string,
    jti: string,
    expiresAt: number,
    now: number,
    binding?: GovernanceReplayBinding
  ): Promise<'ok' | 'conflict' | 'replayed' | 'rate_abuse'>;
}

export interface GovernanceReplayBinding {
  caller: string;
  task: string;
  payloadHash: string;
  idempotencyKey?: string;
}

export interface InMemoryGovernanceReplayStoreOptions {
  /** Maximum unexpired tuples per issuer/audience pair. Default: 100,000. */
  maxEntries?: number;
}

/**
 * Adapter for the SDK's signing replay stores. This lets governed services
 * reuse the same atomic Redis/Postgres replay infrastructure as HTTP signing.
 */
export class GovernanceReplayStoreAdapter implements GovernanceReplayStore {
  constructor(protected readonly replayStore: ReplayStore) {}

  consume(
    issuer: string,
    audience: string,
    jti: string,
    expiresAt: number,
    now: number,
    _binding?: GovernanceReplayBinding
  ): Promise<'ok' | 'replayed' | 'rate_abuse'> {
    return this.replayStore.insert(issuer, audience, jti, Math.max(0, expiresAt - now), now);
  }
}

/**
 * Process-local replay store for development and single-process services.
 * Multi-replica production services must supply an atomic shared store.
 */
export class InMemoryGovernanceReplayStore implements GovernanceReplayStore {
  private readonly scopes = new Map<string, Map<string, { expiresAt: number; binding?: GovernanceReplayBinding }>>();
  private readonly maxEntries: number;

  constructor(options: InMemoryGovernanceReplayStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 100_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('InMemoryGovernanceReplayStore.maxEntries must be a positive safe integer');
    }
    this.maxEntries = maxEntries;
  }

  /** Deterministic conformance-test preload. */
  preload(issuer: string, audience: string, jti: string, expiresAt: number): void {
    const scope = this.getScope(issuer, audience);
    scope.set(jti, { expiresAt });
  }

  async consume(
    issuer: string,
    audience: string,
    jti: string,
    expiresAt: number,
    now: number,
    binding?: GovernanceReplayBinding
  ): Promise<'ok' | 'conflict' | 'replayed' | 'rate_abuse'> {
    const scope = this.getScope(issuer, audience);
    const prior = scope.get(jti);
    if (prior && prior.expiresAt > now) {
      if (
        binding?.idempotencyKey &&
        prior.binding?.idempotencyKey === binding.idempotencyKey &&
        prior.binding.caller === binding.caller &&
        prior.binding.task === binding.task &&
        prior.binding.payloadHash === binding.payloadHash
      ) {
        return 'replayed';
      }
      return prior.binding ? 'conflict' : 'replayed';
    }
    if (prior) scope.delete(jti);

    if (scope.size >= this.maxEntries) {
      for (const [entryJti, entry] of scope) {
        if (entry.expiresAt <= now) scope.delete(entryJti);
      }
      if (scope.size >= this.maxEntries) return 'rate_abuse';
    }
    scope.set(jti, { expiresAt, ...(binding ? { binding: { ...binding } } : {}) });
    return 'ok';
  }

  private getScope(issuer: string, audience: string) {
    const key = `${issuer}\u001f${audience}`;
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = new Map();
      this.scopes.set(key, scope);
    }
    return scope;
  }
}

export interface GovernanceRevocationStatus {
  issuer: string;
  keyRevoked: boolean;
  jtiRevoked: boolean;
  /** Epoch seconds through which this combined status is authoritative. */
  nextUpdate: number;
}

export interface GovernanceRevocationResolver {
  resolve(issuer: string, kid: string, jti: string): GovernanceRevocationStatus | Promise<GovernanceRevocationStatus>;
}

export interface VerifyGovernanceAuthorizationOptions {
  token: unknown;
  expectedIssuer: string;
  expectedAudience: string;
  authenticatedCaller: string;
  expectedTask: string;
  payload: Record<string, unknown>;
  actualCommitment: GovernanceCommitment;
  /** Defaults to `intent`, the phase accepted by a downstream service. */
  expectedPhase?: 'intent';
  jwks: JwksResolver;
  replayStore: GovernanceReplayStore;
  /** Optional governance-key revocation source. */
  revocationStore?: RevocationStore;
  /** Optional token-level revocation check for the signed jti. */
  isJtiRevoked?: (issuer: string, jti: string) => boolean | Promise<boolean>;
  /**
   * Combined, freshness-bearing key and token revocation source. Required to
   * accept intent authorizations whose lifetime exceeds 15 minutes.
   */
  revocationResolver?: GovernanceRevocationResolver;
  /** Epoch seconds; defaults to the current time. */
  now?: () => number;
  /** Defaults to 60 seconds. */
  clockSkewSeconds?: number;
}

export interface BuildGovernanceIntentRequestInput {
  planId: string;
  caller: string;
  targetAgent: string | Pick<AgentConfig, 'agent_uri'>;
  tool: string;
  payload: Record<string, unknown>;
  purchaseType?: CheckGovernanceRequest['purchase_type'];
  proposedCommitment?: GovernanceCommitment;
  consultationContext?: string;
  proposal?: CheckGovernanceRequest['proposal'];
  runtimeAttestations?: CheckGovernanceRequest['runtime_attestations'];
  invoiceRecipient?: CheckGovernanceRequest['invoice_recipient'];
}

export interface BuildGovernanceExecutionRequestInput {
  caller: string;
  governanceContext: string;
  plannedDelivery: PlannedDelivery;
  phase?: GovernancePhase;
  executionCommitment?: GovernanceCommitment;
  deliveryMetrics?: CheckGovernanceRequest['delivery_metrics'];
  modificationSummary?: string;
}

export function buildGovernanceCommitment(amount: number, currency: string): GovernanceCommitment {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TypeError('Governance commitment amount must be finite and non-negative');
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('Governance commitment currency must be an ISO 4217 three-letter uppercase code');
  }
  return { amount, currency };
}

/** Build the orchestrator ceiling supplied on an intent check. */
export const buildGovernanceProposedCommitment = buildGovernanceCommitment;

/** Build the service-computed positive delta supplied on an execution check. */
export const buildGovernanceExecutionCommitment = buildGovernanceCommitment;

/** Tasks whose intent request needs an explicit task-neutral commitment. */
const EXPLICIT_PROPOSED_COMMITMENT_TASKS = new Set([
  'update_media_buy',
  'buy_products',
  'accept_proposal',
  'control_media_buy',
  'acquire_rights',
  'update_rights',
  'activate_signal',
  'build_creative',
]);

export function governanceTaskRequiresProposedCommitment(task: string): boolean {
  return EXPLICIT_PROPOSED_COMMITMENT_TASKS.has(task);
}

export function governancePurchaseTypeForTask(task: string): CheckGovernanceRequest['purchase_type'] | undefined {
  if (
    task === 'create_media_buy' ||
    task === 'update_media_buy' ||
    task === 'buy_products' ||
    task === 'accept_proposal' ||
    task === 'control_media_buy'
  ) {
    return 'media_buy';
  }
  if (task === 'activate_signal') return 'signal_activation';
  if (task === 'acquire_rights' || task === 'update_rights') return 'rights_license';
  if (task === 'build_creative') return 'creative_services';
  return undefined;
}

/** Build an intent-shaped check. Authorization context is intentionally absent. */
export function buildGovernanceIntentRequest(input: BuildGovernanceIntentRequestInput): CheckGovernanceRequest {
  const targetAgent = typeof input.targetAgent === 'string' ? input.targetAgent : input.targetAgent.agent_uri;
  if (!input.planId || !input.caller || !targetAgent || !input.tool) {
    throw new TypeError('Governance intent requires planId, caller, targetAgent, and tool');
  }
  if (governanceTaskRequiresProposedCommitment(input.tool) && !input.proposedCommitment) {
    throw new TypeError(`${input.tool} governance intent requires proposedCommitment`);
  }
  if (input.tool === 'accept_proposal' && !input.proposal) {
    throw new TypeError('accept_proposal governance intent requires proposal');
  }

  const request: CheckGovernanceRequest = {
    plan_id: input.planId,
    caller: input.caller,
    target_agent: targetAgent,
    tool: input.tool,
    payload: structuredClone(input.payload),
  };
  if (input.purchaseType !== undefined) request.purchase_type = input.purchaseType;
  if (input.proposedCommitment !== undefined) {
    request.proposed_commitment = buildGovernanceCommitment(
      input.proposedCommitment.amount,
      input.proposedCommitment.currency
    );
  }
  if (input.consultationContext !== undefined) request.consultation_context = input.consultationContext;
  if (input.proposal !== undefined) request.proposal = structuredClone(input.proposal);
  if (input.runtimeAttestations !== undefined)
    request.runtime_attestations = structuredClone(input.runtimeAttestations);
  if (input.invoiceRecipient !== undefined) request.invoice_recipient = structuredClone(input.invoiceRecipient);
  return request;
}

/** Build an execution-shaped check. Plan and buyer payload stay private. */
export function buildGovernanceExecutionRequest(input: BuildGovernanceExecutionRequestInput): CheckGovernanceRequest {
  if (!input.caller || !input.governanceContext) {
    throw new TypeError('Governance execution requires caller and governanceContext');
  }
  const phase = input.phase ?? 'purchase';
  if (
    (phase === 'modification' || phase === 'delivery') &&
    !(input.plannedDelivery as { media_buy_id?: string }).media_buy_id
  ) {
    throw new TypeError(`Governance ${phase} execution requires plannedDelivery.media_buy_id`);
  }
  if (phase === 'modification' && !input.executionCommitment) {
    throw new TypeError('Governance modification execution requires executionCommitment');
  }
  if (phase === 'delivery' && !input.deliveryMetrics) {
    throw new TypeError('Governance delivery execution requires deliveryMetrics');
  }

  const request: CheckGovernanceRequest = {
    caller: input.caller,
    governance_context: input.governanceContext,
    planned_delivery: structuredClone(input.plannedDelivery),
    phase,
  };
  if (input.executionCommitment !== undefined) {
    request.execution_commitment = buildGovernanceCommitment(
      input.executionCommitment.amount,
      input.executionCommitment.currency
    );
  }
  if (input.deliveryMetrics !== undefined) request.delivery_metrics = structuredClone(input.deliveryMetrics);
  if (input.modificationSummary !== undefined) request.modification_summary = input.modificationSummary;
  return request;
}

/**
 * SHA-256 over RFC 8785 JCS of the downstream request after removing exactly
 * the two top-level transport/governance fields excluded by the protocol.
 */
export function computeGovernedPayloadHash(payload: Record<string, unknown>): string {
  const businessPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'governance_context' && key !== 'context')
  );
  return createHash('sha256').update(canonicalize(businessPayload)).digest('base64url');
}

function capabilitiesRoot(capabilities: unknown): Record<string, unknown> | undefined {
  if (!isRecord(capabilities)) return undefined;
  const normalizedRaw = (capabilities as Partial<AdcpCapabilities>)._raw;
  return isRecord(normalizedRaw) ? normalizedRaw : capabilities;
}

/** Parse and validate the task-scoped governance-enforcement declaration. */
export function getGovernanceEnforcementTasks(capabilities: unknown): GovernanceEnforcementTask[] {
  const root = capabilitiesRoot(capabilities);
  const adcp = isRecord(root?.adcp) ? root.adcp : undefined;
  const enforcement = isRecord(adcp?.governance_enforcement) ? adcp.governance_enforcement : undefined;
  const rawTasks = enforcement?.tasks;
  if (!Array.isArray(rawTasks)) return [];

  const seen = new Set<string>();
  const tasks: GovernanceEnforcementTask[] = [];
  for (const raw of rawTasks) {
    if (!isRecord(raw) || typeof raw.task !== 'string' || !Array.isArray(raw.modes)) continue;
    if (seen.has(raw.task)) {
      throw new TypeError(`Duplicate governance_enforcement task declaration: ${raw.task}`);
    }
    seen.add(raw.task);
    const modes = raw.modes.filter(
      (mode): mode is GovernanceEnforcementMode => mode === 'signed_context' || mode === 'online_execution_check'
    );
    if (!modes.includes('signed_context')) continue;
    tasks.push({ task: raw.task, modes: [...new Set(modes)] });
  }
  return tasks;
}

export function targetDeclaresGovernanceEnforcement(
  capabilities: unknown,
  task: string,
  mode: GovernanceEnforcementMode = 'signed_context'
): boolean {
  const root = capabilitiesRoot(capabilities);
  const normalizedFeatures = isRecord(capabilities)
    ? (capabilities as { experimentalFeatures?: unknown }).experimentalFeatures
    : undefined;
  const rawFeatures = root?.experimental_features;
  const features = Array.isArray(rawFeatures) ? rawFeatures : normalizedFeatures;
  if (!Array.isArray(features) || !features.includes('governance.campaign')) return false;
  return getGovernanceEnforcementTasks(capabilities).some(
    declaration => declaration.task === task && declaration.modes.includes(mode)
  );
}

/** Deprecated 3.0/3.1 online-consultation declaration for create_media_buy. */
export function targetDeclaresLegacyGovernanceAwareness(capabilities: unknown, task: string): boolean {
  if (task !== 'create_media_buy') return false;
  const root = capabilitiesRoot(capabilities);
  const mediaBuy = isRecord(root?.media_buy) ? root.media_buy : undefined;
  return mediaBuy?.governance_aware === true;
}

/** Verify the published compact-JWS authorization profile and all service bindings. */
export async function verifyGovernanceAuthorization(
  options: VerifyGovernanceAuthorizationOptions
): Promise<GovernanceAuthorizationResult> {
  const reject = (error: GovernanceAuthorizationErrorCode, message: string): GovernanceAuthorizationFailure => ({
    ok: false,
    error,
    message,
  });

  if (!options.authenticatedCaller) {
    return reject('governance_token_invalid', 'Authenticated caller is required');
  }
  try {
    buildGovernanceCommitment(options.actualCommitment.amount, options.actualCommitment.currency);
  } catch (error) {
    return reject('governance_token_invalid', (error as Error).message);
  }

  if (typeof options.token !== 'string' || options.token.length === 0) {
    return reject('governance_token_invalid', 'governance_context is required');
  }
  if (options.token.length > 4096) {
    return reject('governance_token_invalid', 'governance_context exceeds the protocol size limit');
  }
  const parts = options.token.split('.');
  if (parts.length !== 3 || parts.some(part => !part || !/^[A-Za-z0-9_-]+$/.test(part))) {
    return reject('governance_token_invalid', 'governance_context is not a compact JWS');
  }

  const protectedHeader = decodeJsonObject(parts[0]!);
  const decodedClaims = decodeJsonObject(parts[1]!);
  if (!protectedHeader || !decodedClaims) {
    return reject('governance_token_invalid', 'governance_context contains invalid JSON');
  }

  const alg = protectedHeader.alg;
  if (alg !== 'EdDSA' && alg !== 'ES256') {
    return reject('governance_token_invalid', 'Unsupported governance JWS algorithm');
  }
  if (protectedHeader.typ !== 'adcp-gov+jws') {
    return reject('governance_token_invalid', 'Invalid governance JWS typ');
  }

  const critical = protectedHeader.crit;
  if (!Array.isArray(critical) || critical.some(name => typeof name !== 'string')) {
    return reject('governance_token_invalid', 'Governance JWS crit must be a string array');
  }
  const criticalNames = critical as string[];
  if (new Set(criticalNames).size !== criticalNames.length) {
    return reject('governance_token_invalid', 'Governance JWS crit contains duplicates');
  }
  if (criticalNames.some(name => !(GOVERNANCE_AUTHORIZATION_CRITICAL_CLAIMS as readonly string[]).includes(name))) {
    return reject('governance_token_invalid', 'Governance JWS has an unknown critical extension');
  }
  for (const name of GOVERNANCE_AUTHORIZATION_CRITICAL_CLAIMS) {
    const hasClaim = decodedClaims[name] !== undefined;
    const hasMarker = criticalNames.includes(name) && protectedHeader[name] === true;
    if (hasClaim !== hasMarker) {
      return reject('governance_token_invalid', `${name} claim and critical marker must appear together`);
    }
  }
  if ((decodedClaims.authorized_task === undefined) !== (decodedClaims.authorized_payload_hash === undefined)) {
    return reject('governance_token_invalid', 'authorized_task and authorized_payload_hash must appear together');
  }

  if (typeof decodedClaims.iss !== 'string' || decodedClaims.iss !== options.expectedIssuer) {
    return reject('governance_token_invalid', 'Governance token issuer mismatch');
  }
  const kid = typeof protectedHeader.kid === 'string' ? protectedHeader.kid : '';
  if (!kid) return reject('governance_key_unknown', 'Governance signing kid is missing');

  let jwk;
  try {
    jwk = await options.jwks.resolve(kid);
  } catch {
    return reject('governance_key_unknown', 'Governance signing key could not be resolved');
  }
  if (
    !jwk ||
    jwk.adcp_use !== 'governance-signing' ||
    jwk.use !== 'sig' ||
    !jwk.key_ops?.includes('verify') ||
    (jwk.alg !== undefined && jwk.alg !== alg)
  ) {
    return reject('governance_key_unknown', 'Governance signing key is unknown or not authorized');
  }

  try {
    const key = await importJWK(jwk as JWK, alg);
    await compactVerify(options.token, key, {
      algorithms: [alg],
      crit: {
        authorized_commitment: true,
        authorized_task: true,
        authorized_payload_hash: true,
      },
    });
  } catch {
    return reject('governance_token_invalid', 'Governance token signature verification failed');
  }

  try {
    if (options.revocationStore && (await options.revocationStore.isRevoked(kid))) {
      return reject('governance_token_revoked', 'Governance signing key is revoked');
    }
    if (
      options.isJtiRevoked &&
      typeof decodedClaims.jti === 'string' &&
      (await options.isJtiRevoked(decodedClaims.iss, decodedClaims.jti))
    ) {
      return reject('governance_token_revoked', 'Governance token is revoked');
    }
  } catch {
    return reject('governance_token_revoked', 'Governance revocation status could not be established');
  }

  if (typeof decodedClaims.aud !== 'string') {
    return reject('governance_token_invalid', 'Governance token audience is missing');
  }
  if (decodedClaims.aud !== options.expectedAudience) {
    return reject('governance_token_not_applicable', 'Governance token audience mismatch');
  }
  if (typeof decodedClaims.caller !== 'string' || decodedClaims.caller.length === 0) {
    return reject('governance_token_invalid', 'Governance token caller is missing');
  }
  if (decodedClaims.caller !== options.authenticatedCaller) {
    return reject('governance_token_not_applicable', 'Governance token caller mismatch');
  }
  if (typeof decodedClaims.sub !== 'string' || !decodedClaims.sub) {
    return reject('governance_token_invalid', 'Governance token action binding is missing');
  }
  if (typeof decodedClaims.plan_hash !== 'string' || !decodedClaims.plan_hash) {
    return reject('governance_token_invalid', 'Governance token plan binding is missing');
  }
  if (typeof decodedClaims.check_id !== 'string' || !decodedClaims.check_id) {
    return reject('governance_token_invalid', 'Governance token check binding is missing');
  }
  if (typeof decodedClaims.phase !== 'string') {
    return reject('governance_token_invalid', 'Governance token phase is missing');
  }
  if (decodedClaims.phase !== (options.expectedPhase ?? 'intent')) {
    return reject('governance_token_not_applicable', 'Governance token phase mismatch');
  }
  if (decodedClaims.media_buy_id !== undefined) {
    return reject('governance_token_not_applicable', 'Intent governance token must not contain media_buy_id');
  }

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  if (!Number.isFinite(now) || !Number.isFinite(skew) || skew < 0) {
    return reject('governance_token_invalid', 'Invalid governance verifier clock configuration');
  }
  if (typeof decodedClaims.iat !== 'number' || !Number.isFinite(decodedClaims.iat)) {
    return reject('governance_token_invalid', 'Governance token iat is missing or invalid');
  }
  if (decodedClaims.iat > now + skew) {
    return reject('governance_token_not_yet_valid', 'Governance token iat is in the future');
  }
  if (decodedClaims.nbf !== undefined) {
    if (typeof decodedClaims.nbf !== 'number' || !Number.isFinite(decodedClaims.nbf)) {
      return reject('governance_token_invalid', 'Governance token nbf is invalid');
    }
    if (decodedClaims.nbf > now + skew) {
      return reject('governance_token_not_yet_valid', 'Governance token is not active yet');
    }
  }
  if (typeof decodedClaims.exp !== 'number' || !Number.isFinite(decodedClaims.exp)) {
    return reject('governance_token_invalid', 'Governance token exp is missing or invalid');
  }
  if (decodedClaims.exp < now - skew) {
    return reject('governance_token_expired', 'Governance token is expired');
  }
  if (decodedClaims.exp <= decodedClaims.iat) {
    return reject('governance_token_invalid', 'Governance token expiry must be after issuance');
  }
  if (typeof decodedClaims.jti !== 'string' || !decodedClaims.jti) {
    return reject('governance_token_invalid', 'Governance token jti is missing');
  }

  let hasFreshCombinedRevocation = false;
  if (options.revocationResolver) {
    try {
      const status = await options.revocationResolver.resolve(decodedClaims.iss, kid, decodedClaims.jti);
      if (
        status.issuer !== decodedClaims.iss ||
        typeof status.keyRevoked !== 'boolean' ||
        typeof status.jtiRevoked !== 'boolean' ||
        !Number.isFinite(status.nextUpdate) ||
        status.nextUpdate < now
      ) {
        return reject('governance_token_revoked', 'Governance revocation status is stale or mismatched');
      }
      if (status.keyRevoked || status.jtiRevoked) {
        return reject('governance_token_revoked', 'Governance signing key or token is revoked');
      }
      hasFreshCombinedRevocation = true;
    } catch {
      return reject('governance_token_revoked', 'Governance revocation status could not be established');
    }
  }
  if (!hasFreshCombinedRevocation && decodedClaims.exp - decodedClaims.iat > 15 * 60) {
    return reject(
      'governance_token_invalid',
      'Governance token lifetime exceeds 15 minutes without fresh combined revocation status'
    );
  }

  if (typeof decodedClaims.authorized_task !== 'string') {
    return reject('governance_token_invalid', 'Governance token authorized_task is missing');
  }
  if (decodedClaims.authorized_task !== options.expectedTask) {
    return reject('governance_token_not_applicable', 'Governance token task mismatch');
  }

  let payloadHash: string;
  try {
    payloadHash = computeGovernedPayloadHash(options.payload);
  } catch {
    return reject('governance_token_invalid', 'Governed payload is not canonical JSON');
  }
  if (typeof decodedClaims.authorized_payload_hash !== 'string') {
    return reject('governance_token_invalid', 'Governance token payload hash is missing');
  }
  if (decodedClaims.authorized_payload_hash !== payloadHash) {
    return reject('governance_token_not_applicable', 'Governance token payload hash mismatch');
  }

  if (!isRecord(decodedClaims.authorized_commitment)) {
    return reject('governance_token_not_applicable', 'Governance token has no monetary authorization');
  }
  const authorizedAmount = decodedClaims.authorized_commitment.amount;
  const authorizedCurrency = decodedClaims.authorized_commitment.currency;
  if (typeof authorizedAmount !== 'number' || !Number.isFinite(authorizedAmount) || authorizedAmount < 0) {
    return reject('governance_token_invalid', 'Governance token authorized amount is invalid');
  }
  if (typeof authorizedCurrency !== 'string' || !/^[A-Z]{3}$/.test(authorizedCurrency)) {
    return reject('governance_token_invalid', 'Governance token authorized currency is invalid');
  }
  if (authorizedCurrency !== options.actualCommitment.currency || options.actualCommitment.amount > authorizedAmount) {
    return reject('governance_token_not_applicable', 'Actual commitment exceeds or mismatches authorization');
  }

  let replayResult: Awaited<ReturnType<GovernanceReplayStore['consume']>>;
  try {
    const idempotencyKey =
      typeof options.payload.idempotency_key === 'string' ? options.payload.idempotency_key : undefined;
    replayResult = await options.replayStore.consume(
      decodedClaims.iss,
      decodedClaims.aud,
      decodedClaims.jti,
      decodedClaims.exp + skew,
      now,
      {
        caller: options.authenticatedCaller,
        task: options.expectedTask,
        payloadHash,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }
    );
  } catch {
    return reject('governance_token_replayed', 'Governance replay state could not be committed');
  }
  if (replayResult !== 'ok') {
    return reject(
      'governance_token_replayed',
      replayResult === 'rate_abuse'
        ? 'Governance replay store is full'
        : replayResult === 'conflict'
          ? 'Governance token was reused with conflicting request bindings'
          : 'Governance token was already consumed'
    );
  }

  return {
    ok: true,
    claims: decodedClaims as GovernanceAuthorizationClaims,
    protectedHeader,
    payloadHash,
  };
}

export class GovernanceAuthorizationError extends Error {
  readonly code: GovernanceAuthorizationErrorCode;

  constructor(result: GovernanceAuthorizationFailure) {
    super(result.message);
    this.name = 'GovernanceAuthorizationError';
    this.code = result.error;
  }
}

export interface GovernanceEnforcementMiddlewareInput {
  token: unknown;
  authenticatedCaller: string;
  task: string;
  payload: Record<string, unknown>;
  actualCommitment: GovernanceCommitment;
  expectedPhase?: 'intent';
}

export type GovernanceEnforcementMiddlewareConfig = Omit<
  VerifyGovernanceAuthorizationOptions,
  'token' | 'authenticatedCaller' | 'expectedTask' | 'payload' | 'actualCommitment' | 'expectedPhase'
>;

export type GovernanceEnforcementMiddleware = <T>(
  input: GovernanceEnforcementMiddlewareInput,
  next: (authorization: GovernanceAuthorizationSuccess) => T | Promise<T>
) => Promise<T>;

/**
 * Framework-neutral governed-service middleware. Verification completes and
 * replay state is atomically consumed before `next` can perform side effects.
 */
export function createGovernanceEnforcementMiddleware(
  config: GovernanceEnforcementMiddlewareConfig
): GovernanceEnforcementMiddleware {
  return async <T>(
    input: GovernanceEnforcementMiddlewareInput,
    next: (authorization: GovernanceAuthorizationSuccess) => T | Promise<T>
  ): Promise<T> => {
    const result = await verifyGovernanceAuthorization({
      ...config,
      token: input.token,
      authenticatedCaller: input.authenticatedCaller,
      expectedTask: input.task,
      payload: input.payload,
      actualCommitment: input.actualCommitment,
      expectedPhase: input.expectedPhase,
    });
    if (!result.ok) throw new GovernanceAuthorizationError(result);
    return next(result);
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeJsonObject(segment: string): Record<string, unknown> | null {
  try {
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) return null;
    const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
