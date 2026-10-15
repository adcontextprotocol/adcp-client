/** Experimental drafts; the released SDK wire/schema pin remains 3.2.4. */
import type { GeneratedAccountCapabilities, ResolveAgentOnboarding } from './generated-compat';

export type BillingParty = 'operator' | 'agent' | 'advertiser';

/*
 * Seller onboarding posture (adcp#8170). The hand-written drafts below apply
 * only while the pinned schemas lack `account.agent_onboarding`. When the
 * generated `get_adcp_capabilities` types define it, every exported onboarding
 * type is derived from the generated shape instead, so the preview types track
 * the spec (renamed modes, dropped requirement kinds, ...) without edits here.
 */
type DraftAgentOnboardingRequirementKind =
  | 'agent_identity'
  | 'grant'
  | 'billing_entity'
  | 'contract'
  | 'credit_application'
  | 'aao_verified'
  | 'storyboard'
  | 'sandbox'
  | 'experimental_feature';
interface DraftAgentOnboardingRequirement {
  kind: DraftAgentOnboardingRequirementKind;
  role?: string;
  verification_modes?: string[];
  specialisms?: string[];
  adcp_version?: string;
  id?: string;
  ext?: Record<string, unknown>;
}
interface DraftAgentOnboardingTier {
  mode: 'open' | 'application' | 'invite_only';
  url?: string;
  requirements?: DraftAgentOnboardingRequirement[];
  ext?: Record<string, unknown>;
}
interface DraftAgentOnboarding {
  sandbox?: DraftAgentOnboardingTier;
  billing?: Partial<Record<BillingParty, DraftAgentOnboardingTier>>;
  url?: string;
  documentation_url?: string;
  message?: string;
  ext?: Record<string, unknown>;
}
/** `get_adcp_capabilities.account.agent_onboarding`: how a seller onboards buyer agents. */
export type AgentOnboarding = ResolveAgentOnboarding<GeneratedAccountCapabilities, DraftAgentOnboarding>;
/** The onboarding mode for sandbox access or for one billing party. */
export type AgentOnboardingTier = NonNullable<AgentOnboarding['sandbox']>;
export type AgentOnboardingMode = AgentOnboardingTier['mode'];
/** One requirement an onboarding mode imposes, discriminated by `kind`. */
export type AgentOnboardingRequirement = NonNullable<AgentOnboardingTier['requirements']>[number];
export type AgentOnboardingRequirementKind = AgentOnboardingRequirement['kind'];
/**
 * A requirement as read off the wire. Readers MUST treat a kind they do not
 * know as unsatisfiable, so this accepts any `kind` string. Structural on
 * purpose: every {@link AgentOnboardingRequirement} is assignable to it,
 * whichever shape the pinned schemas give that type.
 */
export interface ObservedAgentOnboardingRequirement {
  kind: AgentOnboardingRequirementKind | (string & {});
  role?: string;
  verification_modes?: readonly string[];
  specialisms?: readonly string[];
  adcp_version?: string;
  id?: string;
  ext?: Record<string, unknown>;
}
export interface BuyerOnboardingPosture {
  mode: 'considers_unsolicited' | 'application' | 'invite_only';
  requirements?: ObservedAgentOnboardingRequirement[];
  url?: string;
  documentation_url?: string;
  message?: string;
  ext?: Record<string, unknown>;
}
export interface PrincipalRelationship {
  status: 'pending' | 'active' | 'suspended' | 'blocked';
  expires_at?: string;
  setup?: { message: string; url?: string; expires_at?: string; [key: string]: unknown };
  ext?: Record<string, unknown>;
}
export type IdentityPrincipalChangedReason = 'relationship_changed' | 'relationship_expiring';
export interface TrustAgent {
  url: string;
  roles: string[];
  id?: string;
  protocols?: string[];
  countries?: string[];
  profiles?: { adcp?: { onboarding?: BuyerOnboardingPosture; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}
export interface TrustGrant {
  grantee: string;
  scopes: string[];
  agents?: { url: string }[];
  countries?: string[];
  valid_from?: string;
  valid_until?: string;
  profiles?: { adcp?: { brands?: string[]; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}
export interface TrustRecord {
  agents?: TrustAgent[];
  grants?: TrustGrant[];
  acknowledgements?: unknown[];
  exclusive_grants?: boolean;
  authoritative_location?: string;
  profiles?: { adcp?: { onboarding?: BuyerOnboardingPosture; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}
export type RevocationReason =
  | 'unspecified'
  | 'keyCompromise'
  | 'cACompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation'
  | 'certificateHold'
  | 'removeFromCRL'
  | 'privilegeWithdrawn'
  | 'aACompromise';
export interface RevocationDetail {
  reason?: RevocationReason;
  invalidity_date?: string;
}
export interface AgentGrantDeniedDetails {
  scope: 'agent';
  reason: 'grant_absent';
}
export interface Identity33Capabilities {
  request_signing?: { profiles?: ('adcp/request-signing/v1' | 'web-bot-auth')[]; wba_draft_revision?: string };
  webhook_signing?: {
    supported: boolean;
    profiles?: ('adcp/webhook-signing/v1' | 'web-bot-auth')[];
    wba_draft_revision?: string;
  };
  account?: { agent_onboarding?: AgentOnboarding };
}

export type Identity33GetPrincipalResponse = Omit<import('../types/tools.generated').GetPrincipalResponse, 'result'> & {
  result:
    | (Exclude<import('../types/tools.generated').GetPrincipalResponse['result'], { kind: 'failed' }> & {
        relationship?: PrincipalRelationship;
      })
    | Extract<import('../types/tools.generated').GetPrincipalResponse['result'], { kind: 'failed' }>;
};
