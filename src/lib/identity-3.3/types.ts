/** Experimental drafts; the released SDK wire/schema pin remains 3.2.4. */
export type AgentOnboardingMode = 'open' | 'application' | 'invite_only';
export type BillingParty = 'operator' | 'agent' | 'advertiser';
export type AgentOnboardingRequirementKind =
  | 'agent_identity'
  | 'grant'
  | 'billing_entity'
  | 'contract'
  | 'credit_application'
  | 'aao_verified'
  | 'storyboard'
  | 'sandbox'
  | 'experimental_feature';
export interface AgentOnboardingRequirement {
  kind: AgentOnboardingRequirementKind | (string & {});
  role?: string;
  verification_modes?: string[];
  specialisms?: string[];
  adcp_version?: string;
  id?: string;
  ext?: Record<string, unknown>;
}
export interface AgentOnboardingTier {
  mode: AgentOnboardingMode;
  url?: string;
  requirements?: AgentOnboardingRequirement[];
  ext?: Record<string, unknown>;
}
export interface AgentOnboarding {
  sandbox?: AgentOnboardingTier;
  billing?: Partial<Record<BillingParty, AgentOnboardingTier>>;
  url?: string;
  documentation_url?: string;
  message?: string;
  ext?: Record<string, unknown>;
}
export interface BuyerOnboardingPosture {
  mode: 'considers_unsolicited' | 'application' | 'invite_only';
  requirements?: AgentOnboardingRequirement[];
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
  request_signing?: { profiles?: ('adcp/request-signing/v1' | 'web-bot-auth')[] };
  webhook_signing?: { supported: boolean; profiles?: ('adcp/webhook-signing/v1' | 'web-bot-auth')[] };
  account?: { agent_onboarding?: AgentOnboarding };
}

export type Identity33GetPrincipalResponse = Omit<import('../types/tools.generated').GetPrincipalResponse, 'result'> & {
  result:
    | (Exclude<import('../types/tools.generated').GetPrincipalResponse['result'], { kind: 'failed' }> & {
        relationship?: PrincipalRelationship;
      })
    | Extract<import('../types/tools.generated').GetPrincipalResponse['result'], { kind: 'failed' }>;
};
