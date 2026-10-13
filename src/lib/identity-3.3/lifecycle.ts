import type { PrincipalKind } from '../server/principal/types';
import { randomUUID } from 'crypto';
import { parse as parseTld } from 'tldts';
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import { eTldPlusOne } from '../signing/agent-resolver/etld';
import { IdentityAuthorizationError, TrustEvaluator, validateIdentity33Schema } from './trust';
import type {
  AgentOnboarding,
  AgentOnboardingRequirement,
  AgentOnboardingTier,
  BillingParty,
  PrincipalRelationship,
  IdentityPrincipalChangedReason,
} from './types';
export interface OriginBinding {
  origin: string;
  operator: string;
  principalId: string;
  principalKind?: PrincipalKind;
  audit: { approvedBy: string; approvedAt: string; reason: string; migrationApproved?: boolean };
  /** Restricts a newly auto-created principal to the specifically opened tiers. */
  openAccess?: { sandbox?: true; billing?: BillingParty[] };
}
export interface IdentityApplication {
  relationship: PrincipalRelationship;
  revision: number;
  expiryNotified?: string;
  pendingNotifications?: Array<{ id: string; reason: IdentityPrincipalChangedReason }>;
}
/** Every write must be atomic. Namespace this store to one seller and tenant. */
export interface OriginIdentityStore {
  getBinding(origin: string): Promise<OriginBinding | undefined>;
  /** Must enforce one principal per origin, including concurrent migrations. */
  bind(binding: OriginBinding): Promise<void>;
  /** Must atomically enforce operator-domain quota and allocate a NEW principal. */
  bindOpen(binding: OriginBinding, maxPerOperator: number): Promise<OriginBinding>;
  getApplication(origin: string): Promise<IdentityApplication | undefined>;
  compareAndSetApplication(
    origin: string,
    expectedRevision: number | undefined,
    application: IdentityApplication
  ): Promise<boolean>;
}
export class InMemoryOriginIdentityStore implements OriginIdentityStore {
  readonly durability = 'process-local' as const;
  private readonly bindings = new Map<string, OriginBinding>();
  private readonly applications = new Map<string, IdentityApplication>();
  async getBinding(origin: string): Promise<OriginBinding | undefined> {
    const value = this.bindings.get(canonicalAgentOrigin(origin));
    return value && structuredClone(value);
  }
  async bind(binding: OriginBinding): Promise<void> {
    const origin = canonicalAgentOrigin(binding.origin);
    if (
      origin !== binding.origin ||
      !binding.principalId ||
      !binding.audit.approvedBy ||
      !binding.audit.reason ||
      !Number.isFinite(Date.parse(binding.audit.approvedAt))
    )
      throw new TypeError('Explicit bindings require canonical origin and audit evidence');
    const existing = this.bindings.get(origin);
    if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) throw new IdentityAuthorizationError();
    this.bindings.set(origin, structuredClone(binding));
  }
  async bindOpen(binding: OriginBinding, maxPerOperator: number): Promise<OriginBinding> {
    const existing = this.bindings.get(binding.origin);
    if (existing) throw new IdentityAuthorizationError();
    if (
      !binding.openAccess ||
      !Number.isInteger(maxPerOperator) ||
      maxPerOperator < 1 ||
      [...this.bindings.values()].filter(b => b.operator === binding.operator && b.openAccess).length >= maxPerOperator
    )
      throw new IdentityAuthorizationError();
    await this.bind(binding);
    return structuredClone(binding);
  }
  async getApplication(origin: string): Promise<IdentityApplication | undefined> {
    const value = this.applications.get(canonicalAgentOrigin(origin));
    return value && structuredClone(value);
  }
  async compareAndSetApplication(
    origin: string,
    expectedRevision: number | undefined,
    application: IdentityApplication
  ): Promise<boolean> {
    origin = canonicalAgentOrigin(origin);
    if (
      this.applications.get(origin)?.revision !== expectedRevision ||
      application.revision !== (expectedRevision ?? 0) + 1
    )
      return false;
    this.applications.set(origin, structuredClone(application));
    return true;
  }
}
const BUYER_GATES = new Set(['aao_verified', 'storyboard', 'sandbox', 'experimental_feature']);
const SELLER_GATES = new Set(['agent_identity', 'grant', 'billing_entity', 'contract', 'credit_application']);
/** Wrong-direction gates are ignored; unknown gates remain unsatisfied. */
export async function evaluateOnboardingRequirements(
  requirements: readonly AgentOnboardingRequirement[],
  direction: 'seller' | 'buyer',
  check: (requirement: AgentOnboardingRequirement) => Promise<boolean>
): Promise<{ satisfied: boolean; unsatisfied: AgentOnboardingRequirement[] }> {
  const relevant = direction === 'seller' ? SELLER_GATES : BUYER_GATES;
  const wrong = direction === 'seller' ? BUYER_GATES : SELLER_GATES;
  const unsatisfied: AgentOnboardingRequirement[] = [];
  for (const requirement of requirements) {
    if (wrong.has(requirement.kind)) continue;
    const wellFormed =
      requirement.kind !== 'aao_verified' ||
      (!!requirement.role &&
        !!requirement.verification_modes?.length &&
        !!requirement.specialisms?.length &&
        !!requirement.adcp_version);
    const hasId = !['storyboard', 'experimental_feature'].includes(requirement.kind) || !!requirement.id;
    if (!relevant.has(requirement.kind) || !wellFormed || !hasId || !(await check(requirement)))
      unsatisfied.push(requirement);
  }
  return { satisfied: !unsatisfied.length, unsatisfied };
}
export function validateAgentOnboarding(
  posture: AgentOnboarding,
  account: { sandbox?: boolean; supported_billing?: readonly BillingParty[] },
  experimentalFeatures: readonly string[]
): void {
  if (
    !validateIdentity33Schema('core/agent-onboarding', posture) ||
    !experimentalFeatures.includes('account.agent_onboarding') ||
    (posture.sandbox && account.sandbox !== true) ||
    Object.keys(posture.billing ?? {}).some(k => !account.supported_billing?.includes(k as BillingParty))
  )
    throw new TypeError('Invalid experimental agent onboarding posture');
}
export interface OriginIdentityLifecycleOptions {
  store: OriginIdentityStore;
  trust: TrustEvaluator;
  now?: () => number;
  /** Supply for open onboarding only. */
  onboarding?: AgentOnboarding;
  maxOpenPrincipalsPerOperator?: number;
  checkRequirement?: (origin: string, requirement: AgentOnboardingRequirement) => Promise<boolean>;
  hasBillingRelationship?: (billedPartyDomain: string, billing: BillingParty) => Promise<boolean>;
  /** Publish only after the new application state is durable; duplicate notifications are allowed. */
  notify?: (origin: string, reason: IdentityPrincipalChangedReason, notificationId: string) => Promise<void>;
  /** Seller ledger lookup, required before automatic creation to prevent RFC principal splitting. */
  lookupLegacyPrincipals?: (origin: string) => Promise<readonly string[]>;
}
export class OriginIdentityLifecycle {
  constructor(private readonly options: OriginIdentityLifecycleOptions) {}
  /** Identity-established origins get no durable identifier. Reads never create. */
  async getPrincipal(originUrl: string): Promise<{
    binding?: OriginBinding;
    result: {
      kind: 'unconfigured' | 'recognized';
      principal_id?: string;
      principal_kind?: PrincipalKind;
      relationship?: PrincipalRelationship;
    };
  }> {
    const origin = canonicalAgentOrigin(originUrl);
    const binding = await this.options.store.getBinding(origin);
    const application = await this.options.store.getApplication(origin);
    return {
      ...(binding ? { binding } : {}),
      result: {
        kind: binding ? 'recognized' : 'unconfigured',
        ...(binding
          ? { principal_id: binding.principalId, principal_kind: binding.principalKind ?? 'buyer_agent' }
          : {}),
        ...(application ? { relationship: application.relationship } : {}),
      },
    };
  }
  async bindPrincipal(input: {
    origin: string;
    principalId: string;
    approvedBy: string;
    reason: string;
    principalKind?: PrincipalKind;
    existingRfcPrincipal?: boolean;
    migrationApproved?: boolean;
    sharedOrigin?: boolean;
  }): Promise<OriginBinding> {
    if (
      (input.principalKind !== undefined && !['buyer_agent', 'operator'].includes(input.principalKind)) ||
      input.sharedOrigin ||
      (input.existingRfcPrincipal && input.migrationApproved !== true)
    )
      throw new IdentityAuthorizationError();
    const origin = canonicalAgentOrigin(input.origin);
    const legacy = await this.options.lookupLegacyPrincipals?.(origin);
    if (
      legacy &&
      (legacy.length > 1 || (legacy.length === 1 && (legacy[0] !== input.principalId || !input.migrationApproved)))
    )
      throw new IdentityAuthorizationError();
    const trust = await this.options.trust.match(origin, 'adcp:buying');
    const binding: OriginBinding = {
      origin,
      operator: trust.operator,
      principalId: input.principalId,
      ...(input.principalKind && { principalKind: input.principalKind }),
      audit: {
        approvedBy: input.approvedBy,
        reason: input.reason,
        approvedAt: new Date(this.now() * 1000).toISOString(),
        ...(input.migrationApproved ? { migrationApproved: true } : {}),
      },
    };
    await this.options.store.bind(binding);
    return binding;
  }
  /** Cryptographic verification does not call this. Authorization revalidates delisting. */
  async authorizeBound(
    originUrl: string,
    access?: {
      readOnly?: true;
      identityConfiguration?: true;
      sandbox?: boolean;
      billing?: BillingParty;
      brandDomain?: string;
    }
  ): Promise<OriginBinding | undefined> {
    const origin = canonicalAgentOrigin(originUrl);
    const binding = await this.options.store.getBinding(origin);
    if (!binding) throw new IdentityAuthorizationError();
    const trust = await this.options.trust.match(origin, 'adcp:buying');
    if (binding.operator !== trust.operator) throw new IdentityAuthorizationError();
    const relationship = (await this.options.store.getApplication(origin))?.relationship;
    if (
      !access?.readOnly &&
      relationship &&
      (relationship.status !== 'active' ||
        (relationship.expires_at && Date.parse(relationship.expires_at) <= this.now() * 1000))
    )
      throw new IdentityAuthorizationError();
    if (binding.openAccess && !access) throw new IdentityAuthorizationError();
    if (binding.openAccess && access && !access.readOnly && !access.identityConfiguration) {
      if (access.sandbox) {
        if (!binding.openAccess.sandbox) throw new IdentityAuthorizationError();
      } else {
        if (!access.billing || access.billing === 'agent' || !binding.openAccess.billing?.includes(access.billing))
          throw new IdentityAuthorizationError();
        const billedParty =
          access.billing === 'operator' ? binding.operator : access.brandDomain && eTldPlusOne(access.brandDomain);
        if (!billedParty || !(await this.options.hasBillingRelationship?.(billedParty, access.billing)))
          throw new IdentityAuthorizationError();
      }
    }
    return binding;
  }
  /** Called by explicit sync_principal only; allocates new identities, never migrates existing ones. */
  async syncOpen(originUrl: string, options?: { dryRun?: boolean }): Promise<OriginBinding> {
    const origin = canonicalAgentOrigin(originUrl);
    if (
      ![this.options.onboarding?.sandbox, ...Object.values(this.options.onboarding?.billing ?? {})].some(
        tier => tier?.mode === 'open'
      )
    )
      throw new IdentityAuthorizationError();
    if (await this.options.store.getBinding(origin)) throw new IdentityAuthorizationError();
    if (!this.options.lookupLegacyPrincipals || (await this.options.lookupLegacyPrincipals(origin)).length)
      throw new IdentityAuthorizationError();
    const relationship = (await this.options.store.getApplication(origin))?.relationship;
    if (
      relationship &&
      (['blocked', 'suspended'].includes(relationship.status) ||
        (relationship.expires_at && Date.parse(relationship.expires_at) <= this.now() * 1000))
    )
      throw new IdentityAuthorizationError();
    const trust = await this.options.trust.match(origin, 'adcp:buying');
    const privateSuffix = parseTld(new URL(origin).hostname, { allowPrivateDomains: true }).isPrivate;
    const access: NonNullable<OriginBinding['openAccess']> = {};
    const eligible = async (tier: AgentOnboardingTier | undefined) =>
      tier?.mode === 'open' &&
      (
        await evaluateOnboardingRequirements(
          tier.requirements ?? [],
          'seller',
          req => this.options.checkRequirement?.(origin, req) ?? Promise.resolve(false)
        )
      ).satisfied;
    if (await eligible(this.options.onboarding?.sandbox)) access.sandbox = true;
    if (!privateSuffix) {
      for (const billing of ['operator', 'advertiser'] as const)
        if (await eligible(this.options.onboarding?.billing?.[billing])) (access.billing ??= []).push(billing);
    }
    if (!access.sandbox && !access.billing?.length) throw new IdentityAuthorizationError();
    const binding: OriginBinding = {
      origin,
      operator: trust.operator,
      principalId: randomUUID(),
      openAccess: access,
      audit: {
        approvedBy: 'open-onboarding-policy',
        reason: 'new principal for declared open tiers',
        approvedAt: new Date(this.now() * 1000).toISOString(),
      },
    };
    if (options?.dryRun) return binding;
    return this.options.store.bindOpen(binding, this.options.maxOpenPrincipalsPerOperator ?? 10);
  }
  async setRelationship(originUrl: string, relationship: PrincipalRelationship): Promise<void> {
    if (!validateIdentity33Schema('core/principal-relationship', relationship))
      throw new TypeError('Invalid relationship');
    const origin = canonicalAgentOrigin(originUrl);
    for (let attempt = 0; attempt < 5; attempt++) {
      const prior = await this.options.store.getApplication(origin);
      if (prior && JSON.stringify(prior.relationship) === JSON.stringify(relationship)) {
        await this.flushRelationshipNotifications(origin);
        return;
      }
      if (
        await this.options.store.compareAndSetApplication(origin, prior?.revision, {
          relationship: structuredClone(relationship),
          revision: (prior?.revision ?? 0) + 1,
          ...(prior?.relationship.expires_at === relationship.expires_at && prior?.expiryNotified
            ? { expiryNotified: prior.expiryNotified }
            : {}),
          pendingNotifications: [
            ...(prior?.pendingNotifications ?? []),
            { id: randomUUID(), reason: 'relationship_changed' },
          ],
        })
      ) {
        await this.flushRelationshipNotifications(origin);
        return;
      }
    }
    throw new IdentityAuthorizationError();
  }
  async notifyRelationshipExpiring(originUrl: string, leadSeconds: number): Promise<boolean> {
    if (!Number.isFinite(leadSeconds) || leadSeconds < 0) throw new TypeError('Invalid expiry lead time');
    const origin = canonicalAgentOrigin(originUrl);
    await this.flushRelationshipNotifications(origin);
    const prior = await this.options.store.getApplication(origin);
    const expires = prior?.relationship.expires_at;
    if (
      !prior ||
      !expires ||
      prior.expiryNotified === expires ||
      Date.parse(expires) / 1000 - this.now() > leadSeconds ||
      Date.parse(expires) / 1000 <= this.now()
    )
      return false;
    if (
      !(await this.options.store.compareAndSetApplication(origin, prior.revision, {
        ...prior,
        revision: prior.revision + 1,
        expiryNotified: expires,
        pendingNotifications: [
          ...(prior.pendingNotifications ?? []),
          { id: randomUUID(), reason: 'relationship_expiring' },
        ],
      }))
    )
      return false;
    await this.flushRelationshipNotifications(origin);
    return true;
  }
  async flushRelationshipNotifications(originUrl: string): Promise<void> {
    if (!this.options.notify) return;
    const origin = canonicalAgentOrigin(originUrl);
    for (let attempt = 0; attempt < 100; attempt++) {
      const prior = await this.options.store.getApplication(origin),
        notification = prior?.pendingNotifications?.[0];
      if (!prior || !notification) return;
      await this.options.notify(origin, notification.reason, notification.id);
      await this.options.store.compareAndSetApplication(origin, prior.revision, {
        ...prior,
        revision: prior.revision + 1,
        pendingNotifications: prior.pendingNotifications!.slice(1),
      });
    }
  }
  async assertLegacyAllowed(agentUrl: string): Promise<void> {
    if (await this.options.store.getBinding(canonicalAgentOrigin(agentUrl))) throw new IdentityAuthorizationError();
  }
  private now(): number {
    return (this.options.now ?? (() => Date.now() / 1000))();
  }
}
