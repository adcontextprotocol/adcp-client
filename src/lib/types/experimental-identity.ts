/**
 * EXPERIMENTAL — AdCP 3.3 agent identity types, pinned to draft schemas
 * (see `schemas/identity-preview/UPSTREAM.json`) and independent of the
 * SDK's AdCP 3.2 wire pin. They may change before 3.3 is released.
 *
 * Validate trust records with `validateTrustRecord`: origin ownership and one
 * agent per origin are behavioral rules the types cannot express.
 */
import type { PrincipalRelationship } from './experimental-identity.generated';

export type {
  AgentOnboardingPosture as AgentOnboarding,
  AgentOnboardingTier,
  AgentOnboardingRequirement,
  AgentOnboardingMode,
  AgentOnboardingRequirementKind,
  BuyerOnboardingPosture,
  BuyerOnboardingMode,
  PrincipalRelationship,
  TrustJson as TrustDocument,
  TrustRecord,
  AuthoritativeLocationRedirect as TrustRecordRedirect,
  Agent as TrustRecordAgent,
  Grant as TrustRecordGrant,
  GrantedAgent as TrustRecordGrantedAgent,
  Acknowledgement as TrustRecordAcknowledgement,
  IdentityRelyingParty,
} from './experimental-identity.generated';
export type { RevocationDetails, RevocationReason, RevocationListPayload } from '../signing/wba/revocation';

/** Request-signing profiles in `request_signing.profiles` (adcp#7894). */
export type RequestSigningProfileId = 'adcp/request-signing/v1' | 'web-bot-auth';
/** Webhook-signing profiles in `webhook_signing.profiles` and `signing_profile` (adcp#7894). */
export type WebhookSigningProfileId = 'adcp/webhook-signing/v1' | 'web-bot-auth';

/** `request_signing` capability additions. Omitted `profiles` means the RFC 9421 profile only. */
export interface ExperimentalRequestSigningCapability {
  profiles?: RequestSigningProfileId[];
}

/** `webhook_signing` capability additions. */
export interface ExperimentalWebhookSigningCapability {
  profiles?: WebhookSigningProfileId[];
}

/**
 * `account` capability additions (`account.agent_onboarding`). Sellers that
 * declare it MUST list `account.agent_onboarding` in `experimental_features`.
 */
export interface ExperimentalAccountCapabilities {
  agent_onboarding?: import('./experimental-identity.generated').AgentOnboardingPosture;
}

/** `relationship` on every non-failed `get_principal` result (spec R8). */
export interface ExperimentalPrincipalResultRelationship {
  relationship?: PrincipalRelationship;
}

/** New `principal.changed` reasons (spec R8). */
export type ExperimentalPrincipalChangedReason = 'relationship_changed' | 'relationship_expiring';

/** `error.details` on `PERMISSION_DENIED` when no grant covers the claim (DR-0025). */
export interface GrantAbsentDetails {
  scope: 'agent';
  reason: 'grant_absent';
}

/** `agent-permission-denied` reasons including the 3.3 draft value. */
export type ExperimentalAgentPermissionDeniedReason = 'sandbox_only' | 'grant_absent';
