/** Supply-path contract from adcontextprotocol/adcp#6897. */
import type { SsrfFetchOptions } from '../net/ssrf-fetch';
import type { RegistryClient } from '../registry';

/** Untrusted evidence. The evaluator validates every authorization-relevant field. */
export interface SupplyPathManifest {
  authorized_agents?: unknown;
  properties?: unknown;
  collections?: unknown;
  revoked_publisher_domains?: unknown;
  [key: string]: unknown;
}

export type SupplyPathState = 'verified_owner_sold' | 'host_delegated' | 'owner_attested' | 'unverified';

export type OwnerCollectionFailure =
  | 'manifest_not_found'
  | 'no_collections_declared'
  | 'collection_not_declared'
  | 'publisher_revoked';

export type OwnerCarriageFailure =
  | 'collection_leg_failed'
  | 'no_distribution_for_host'
  | 'property_ids_unresolved'
  | 'host_manifest_not_found';

export type OwnerAgentFailure = 'manifest_not_found' | 'agent_not_declared_by_owner';

export type HostAuthorizationFailure =
  | 'manifest_not_found'
  | 'no_agent_entry'
  | 'collection_scope_mismatch'
  | 'property_scope_mismatch'
  | 'unsupported_constraints';

export interface Leg<F extends string> {
  ok: boolean;
  failure?: F | 'evaluation_limit_exceeded';
  detail?: string;
}

export interface SupplyPathLegs {
  /** Owner's adagents.json declares the collection (kind noted in detail). */
  owner_collection_declared: Leg<OwnerCollectionFailure>;
  /** The collection's distribution[] names the host, and any property_ids resolve in the host manifest. */
  owner_distribution_carriage: Leg<OwnerCarriageFailure> & {
    property_ids_matched?: string[];
    property_ids_unmatched?: string[];
  };
  /** Owner's own adagents.json lists the sales agent. */
  owner_agent_declared: Leg<OwnerAgentFailure>;
  /** Host adagents.json authorizes the agent for the property, collection-scoped. */
  host_authorization: Leg<HostAuthorizationFailure> & {
    matched_entry?: {
      url: string;
      authorization_type?: string;
      delegation_type?: string;
      collections?: Array<{ publisher_domain: string; collection_ids?: string[] }>;
    };
  };
  /** Host ads.txt / app-ads.txt names the owner via inventorypartnerdomain=. */
  inventory_partner_domain: Leg<'not_declared' | 'ads_txt_unavailable' | 'not_evaluated'>;
}

export interface SupplyPathVerdict {
  /** Version of the canonical evaluator semantics and shared vector corpus. */
  semantics_version: '1';
  /** Concrete winning collection, including domain-level inquiries. */
  resolved_collection_id?: string;
  state: SupplyPathState;
  legs: SupplyPathLegs;
}

export interface SupplyPathInput {
  /** Canonicalized owner (channel publisher) domain. */
  ownerDomain: string;
  /** Canonicalized host (carrying property publisher) domain. */
  hostDomain: string;
  /** Seller agent URL as the buyer sees it. */
  agentUrl: string;
  /** Owner-assigned collection ID. Omit to verify the path at domain level (bulk deals). */
  collectionId?: string;
  /** Optional concrete product scope, resolved from the host manifest. Empty means unresolved. */
  requiredHostPropertyIds?: string[];
  /** Cross-origin authoritative documents must explicitly attribute every host property. */
  requireExplicitHostPublisherDomain?: boolean;
  /** Cross-origin owner catalogs must explicitly attribute collections and owner agent grants. */
  requireExplicitOwnerPublisherDomain?: boolean;
  ownerManifest: SupplyPathManifest | null;
  hostManifest: SupplyPathManifest | null;
  /**
   * inventorypartnerdomain values from the host's ads.txt/app-ads.txt,
   * already canonicalized. null = the files could not be fetched (distinct
   * from fetched-and-absent, which is an empty array).
   */
  hostInventoryPartnerDomains: string[] | null;
  /** Per-file parsed evidence, so bulk inquiries evaluate each collection's applicable surfaces independently. */
  hostInventoryPartnerDomainsByFile?: Partial<Record<'ads.txt' | 'app-ads.txt', string[] | null>>;
  /** Previously observed authority-scoped revocations, even when a current manifest is unavailable. */
  heldRevocations?: { owner?: string[]; host?: string[] };
  /** False when the caller deliberately skipped IAB evidence after host authorization succeeded. */
  inventoryPartnerDomainEvaluated?: boolean;
}

/** Canonical registry request; collection_id omission is a domain-level inquiry. */
export interface SupplyPathRequest {
  owner_domain: string;
  host_domain: string;
  agent_url: string;
  collection_id?: string;
}

export interface RegistrySupplyPathResult extends SupplyPathRequest, Omit<SupplyPathVerdict, 'legs'> {
  legs: { [K in keyof SupplyPathLegs]: Omit<SupplyPathLegs[K], 'failure'> & { failure?: string } };
  sources: {
    owner_adagents_url: string;
    host_adagents_url: string;
    cached: boolean;
    /** Cache observation times, distinct from the verdict's checked_at. */
    owner_fetched_at: string | null;
    host_fetched_at: string | null;
    owner_resolved_url: string | null;
    host_resolved_url: string | null;
  };
  checked_at: string;
}

export interface SupplyPathEvidence {
  kind: 'adagents' | 'ads.txt' | 'app-ads.txt';
  publisher_domain: string;
  requested_url: string;
  resolved_url?: string;
  fetched_at: string;
  status?: number;
  /** Hash of the exact decompressed response bytes, including pointer/redirect bodies. */
  sha256?: string;
  byte_length?: number;
  connection_pinned?: boolean;
  error?: string;
  /** Present for HTTP redirects and authoritative_location delegation. */
  delegated_to?: string;
  /** Exact bytes for audit/replay when retainEvidenceBodies is enabled. */
  body_base64?: string;
}

export interface AuthoritativeSupplyPathResult extends Omit<RegistrySupplyPathResult, 'sources'> {
  source: 'authoritative';
  legs: SupplyPathLegs;
  property_selectors?: import('../discovery/types').SinglePublisherPropertySelector[];
  sources: Pick<RegistrySupplyPathResult['sources'], 'owner_adagents_url' | 'host_adagents_url'> & {
    cached: false;
    evidence: SupplyPathEvidence[];
    held_revocations: Array<{ authority: string; entries: readonly import('./revocations').SupplyPathRevocation[] }>;
  };
}

export interface AuthoritativeSupplyPathOptions {
  source: 'authoritative';
  /** Defaults to a process-local seven-day hold; supply durable storage across workers/restarts. */
  revocationStore?: import('./revocations').SupplyPathRevocationStore;
  /** Pins authoritative locations. Changed pointers require independently confirmed migration. */
  authorityStore?: import('./revocations').SupplyPathAuthorityStore;
  /** Optional product property scope. Every selected host property must be proven. */
  propertySelectors?: import('../discovery/types').SinglePublisherPropertySelector[];
  /** Overall deadline, including all evidence and redirect fetches. Default 15 seconds, max 60 seconds. */
  timeoutMs?: number;
  /** Per-response decompressed byte cap. Default 256 KiB, max 20 MiB. */
  maxBodyBytes?: number;
  signal?: AbortSignal;
  /** Default false. Bodies contain counterparty-controlled content; store as opaque evidence. */
  retainEvidenceBodies?: boolean;
  /** Trusted egress implementation; takes responsibility for DNS and address policy. */
  trustedFetchFn?: SsrfFetchOptions['trustedFetchFn'];
}

export interface RegistrySupplyPathOptions {
  source: 'registry';
  /** Caller-configured registry; omitted uses the canonical registry client. */
  registry?: Pick<RegistryClient, 'verifySupplyPath'>;
}
export type VerifySupplyPathOptions = AuthoritativeSupplyPathOptions | RegistrySupplyPathOptions;
