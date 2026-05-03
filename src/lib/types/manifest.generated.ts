// AUTO-GENERATED FROM schemas/cache/3.0.5/manifest.json — DO NOT EDIT.
// Run `npm run generate-manifest-derived` to regenerate.

/**
 * Manifest-derived constants for AdCP 3.0.5.
 *
 * Single source of truth for tool↔protocol grouping, error-code metadata
 * (description + recovery + suggestion), and specialism→required-tools
 * mapping. Replaces the hand-curated tables that previously lived in
 * `src/lib/utils/capabilities.ts` and `src/lib/types/error-codes.ts`.
 *
 * Source: `schemas/cache/3.0.5/manifest.json` (adcp_version: 3.0.5, generated_at:
 * 2026-05-02T21:51:30.257Z). Re-run `npm run sync-schemas` then
 * `npm run generate-manifest-derived` to refresh after a spec bump.
 */

export type ErrorRecovery = 'transient' | 'correctable' | 'terminal';

export interface StandardErrorCodeInfo {
  description: string;
  recovery: ErrorRecovery;
  suggestion?: string;
}

/**
 * Default recovery to fall back on for non-standard / unknown error codes.
 * Sourced from `error_code_policy.default_unknown_recovery` in the manifest.
 */
export const DEFAULT_UNKNOWN_RECOVERY: ErrorRecovery = "transient";

/**
 * Standard AdCP error codes with structured `description`, `recovery`, and
 * (where the spec provides one) `suggestion`. Keyed by the wire code.
 *
 * Typed loosely as `Record<string, StandardErrorCodeInfo>` on purpose: the
 * generated file does not import from `enums.generated.ts` so the codegen
 * stays decoupled from the rest of the type pipeline. The strict
 * `Record<StandardErrorCode, ErrorCodeInfo>` constraint is re-applied at
 * the consumer site (`src/lib/types/error-codes.ts`) — drift is caught
 * there. Don't tighten this annotation without rewiring that layering.
 */
export const STANDARD_ERROR_CODES_FROM_MANIFEST = {
  ACCOUNT_AMBIGUOUS: {
    description: "Natural key resolves to multiple accounts.",
    recovery: "correctable",
    suggestion: "pass explicit account_id or a more specific natural key"
  },
  ACCOUNT_NOT_FOUND: {
    description: "The account reference could not be resolved.",
    recovery: "terminal",
    suggestion: "verify account via list_accounts or contact seller"
  },
  ACCOUNT_PAYMENT_REQUIRED: {
    description: "Account has an outstanding balance requiring payment before new buys.",
    recovery: "terminal",
    suggestion: "buyer must resolve billing"
  },
  ACCOUNT_SETUP_REQUIRED: {
    description: "Natural key resolved but the account needs setup before use.",
    recovery: "correctable",
    suggestion: "check details.setup for URL or instructions"
  },
  ACCOUNT_SUSPENDED: {
    description: "Account has been suspended.",
    recovery: "terminal",
    suggestion: "contact seller to resolve suspension"
  },
  AUDIENCE_TOO_SMALL: {
    description: "Audience segment is below the minimum required size for targeting.",
    recovery: "correctable",
    suggestion: "broaden targeting or upload more audience members"
  },
  AUTH_REQUIRED: {
    description: "Authentication is required, or presented credentials were rejected. Two operational sub-cases share this code: (a) credentials missing — agent provides credentials and retries; (b) credentials presented but rejected (expired / revoked / malformed signature) — agent SHOULD NOT auto-retry, since re-presenting a rejected credential against an SSO endpoint creates retry-storm patterns indistinguishable from brute-force probes. In sub-case (b) the agent SHOULD escalate to operator for credential rotation rather than loop. A future minor release splits this code into AUTH_MISSING (correctable) and AUTH_INVALID (terminal); agents handling 3.0.x sellers SHOULD apply the same operational distinction at the application layer.",
    recovery: "correctable",
    suggestion: "provide credentials via auth header on missing-credential case; do NOT auto-retry on presented-but-rejected credentials — escalate to operator for credential rotation (3.1+ splits this into AUTH_MISSING / AUTH_INVALID)"
  },
  BUDGET_EXCEEDED: {
    description: "Operation would exceed the allocated budget for the media buy or package. Distinct from BUDGET_EXHAUSTED (already spent) and BUDGET_TOO_LOW (below minimum).",
    recovery: "correctable",
    suggestion: "reduce requested amount or increase budget allocation"
  },
  BUDGET_EXHAUSTED: {
    description: "Account or campaign budget has been fully spent. Distinct from BUDGET_TOO_LOW (rejected at submission).",
    recovery: "terminal",
    suggestion: "buyer must add funds or increase budget cap"
  },
  BUDGET_TOO_LOW: {
    description: "Budget is below the seller's minimum.",
    recovery: "correctable",
    suggestion: "increase budget or check capabilities.media_buy.limits"
  },
  CAMPAIGN_SUSPENDED: {
    description: "Campaign governance has been suspended pending human review; the governance agent MUST reject `check_governance` and `report_plan_outcome` calls on the affected plan until the escalation is resolved. Distinct from `ACCOUNT_SUSPENDED` (account-wide) — this is scoped to a single plan/campaign.",
    recovery: "transient",
    suggestion: "wait for the escalation to resolve; contact the plan operator if the suspension persists"
  },
  COMPLIANCE_UNSATISFIED: {
    description: "A required disclosure from the brief's compliance section cannot be satisfied by the target format — either the required position or the required persistence mode is not in the format's disclosure_capabilities.",
    recovery: "correctable",
    suggestion: "choose a format that supports the required disclosure positions and persistence modes, or remove the disclosure requirement"
  },
  CONFLICT: {
    description: "Concurrent modification detected. The resource was modified by another request between read and write.",
    recovery: "transient",
    suggestion: "re-read the resource and retry with current state"
  },
  CREATIVE_DEADLINE_EXCEEDED: {
    description: "Creative change submitted after the package's creative_deadline. Distinct from CREATIVE_REJECTED (content policy failure).",
    recovery: "correctable",
    suggestion: "check creative_deadline via get_media_buys before submitting changes, or negotiate a deadline extension with the seller"
  },
  CREATIVE_NOT_FOUND: {
    description: "Referenced creative does not exist in the agent's creative library. Sellers MUST return this code uniformly for any creative_id not owned by the calling account — never distinguish 'exists in another tenant' from 'does not exist', which would enable cross-tenant enumeration.",
    recovery: "correctable",
    suggestion: "verify creative_id via list_creatives, or sync_creatives to register it"
  },
  CREATIVE_REJECTED: {
    description: "Creative failed content policy review. For deadline violations, see CREATIVE_DEADLINE_EXCEEDED.",
    recovery: "correctable",
    suggestion: "revise the creative per the seller's advertising_policies"
  },
  GOVERNANCE_DENIED: {
    description: "A registered governance agent denied the transaction. The buyer may restructure the buy (e.g., reduce budget, split into smaller transactions), escalate to human spending authority, or contact the governance agent for details.",
    recovery: "correctable",
    suggestion: "restructure the buy, escalate to human spending authority, or contact the governance agent for details"
  },
  GOVERNANCE_UNAVAILABLE: {
    description: "A registered governance agent is unreachable (timeout, network error, or repeated failure) and the seller cannot obtain a governance decision for the spend-commit. Distinct from `GOVERNANCE_DENIED` (agent reachable and explicitly denied).",
    recovery: "transient",
    suggestion: "retry with backoff; if the agent remains unreachable, the buyer MUST contact the plan's governance operator"
  },
  IDEMPOTENCY_CONFLICT: {
    description: "An earlier request with the same idempotency_key was processed with a different canonical payload within the seller's replay window. Distinct from CONFLICT (concurrent write) — this indicates the client reused a key across semantically different requests.",
    recovery: "correctable",
    suggestion: "use a fresh UUID v4 for the new request, or resend the exact original payload to get the cached response"
  },
  IDEMPOTENCY_EXPIRED: {
    description: "The idempotency_key was seen previously but its cached response has been evicted because it is past the seller's declared replay_ttl_seconds. Distinct from IDEMPOTENCY_CONFLICT (different payload within window) — this indicates the retry arrived too late for at-most-once guarantees. If the buyer has any evidence the prior call succeeded (partial response received before crash, entry in the buyer's own DB, a webhook fired), the buyer MUST do the natural-key check BEFORE minting a new key — minting a new key in that situation is exactly how double-creation happens.",
    recovery: "correctable",
    suggestion: "perform a natural-key check to determine whether the original request succeeded; if no evidence of success, generate a fresh idempotency_key for a new attempt"
  },
  INVALID_REQUEST: {
    description: "Request is malformed, missing required fields, or violates schema constraints.",
    recovery: "correctable",
    suggestion: "check request parameters and fix"
  },
  INVALID_STATE: {
    description: "Operation is not permitted for the resource's current status (e.g., updating a completed or canceled media buy, or modifying a canceled package).",
    recovery: "correctable",
    suggestion: "check current status via get_media_buys and adjust request"
  },
  IO_REQUIRED: {
    description: "The committed proposal requires a signed insertion order but no io_acceptance was provided.",
    recovery: "correctable",
    suggestion: "review the proposal's insertion_order, accept terms, and include io_acceptance on create_media_buy"
  },
  MEDIA_BUY_NOT_FOUND: {
    description: "Referenced media buy does not exist or is not accessible to the requesting agent.",
    recovery: "correctable",
    suggestion: "verify media_buy_id or buyer_ref"
  },
  NOT_CANCELLABLE: {
    description: "The media buy or package cannot be canceled in its current state. The seller may have contractual or operational constraints that prevent cancellation.",
    recovery: "correctable",
    suggestion: "check the seller's cancellation policy or contact the seller"
  },
  PACKAGE_NOT_FOUND: {
    description: "Referenced package does not exist within the specified media buy.",
    recovery: "correctable",
    suggestion: "verify package_id or buyer_ref via get_media_buys"
  },
  PERMISSION_DENIED: {
    description: "The authenticated caller is not authorized for the requested action under the seller's own policies, or a required signed credential (e.g., a `governance_context` token on a spend-commit) is missing, fails verification, or was issued for a different plan, seller, or phase. Distinct from `AUTH_REQUIRED` (no credentials presented) and `GOVERNANCE_DENIED` (governance agent denied).",
    recovery: "correctable",
    suggestion: "call check_governance to mint a valid token, or contact the seller to resolve the underlying permission"
  },
  PLAN_NOT_FOUND: {
    description: "Referenced governance plan does not exist or is not accessible to the requesting agent. Sellers MUST return this code uniformly for any plan_id not accessible to the calling account — never distinguish 'exists but unauthorized' from 'does not exist', which would enable cross-tenant enumeration of governance plans.",
    recovery: "correctable",
    suggestion: "verify plan_id via sync_plans, or register the plan first"
  },
  POLICY_VIOLATION: {
    description: "Request violates the seller's content or advertising policies.",
    recovery: "correctable",
    suggestion: "review policy requirements in the error details"
  },
  PRODUCT_EXPIRED: {
    description: "One or more referenced products have passed their expires_at timestamp and are no longer available for purchase.",
    recovery: "correctable",
    suggestion: "re-discover with get_products to find current inventory"
  },
  PRODUCT_NOT_FOUND: {
    description: "One or more referenced product IDs are unknown or expired.",
    recovery: "correctable",
    suggestion: "remove invalid IDs and retry, or re-discover with get_products"
  },
  PRODUCT_UNAVAILABLE: {
    description: "The requested product is sold out or no longer available.",
    recovery: "correctable",
    suggestion: "choose a different product"
  },
  PROPOSAL_EXPIRED: {
    description: "A referenced proposal ID has passed its expires_at timestamp.",
    recovery: "correctable",
    suggestion: "re-discover with get_products to get a fresh proposal"
  },
  PROPOSAL_NOT_COMMITTED: {
    description: "The referenced proposal has proposal_status 'draft' and cannot be used to create a media buy.",
    recovery: "correctable",
    suggestion: "finalize the proposal first using get_products with buying_mode 'refine' and action 'finalize'"
  },
  RATE_LIMITED: {
    description: "Request rate exceeded. Retry after the retry_after interval.",
    recovery: "transient",
    suggestion: "retry after the retry_after interval"
  },
  REFERENCE_NOT_FOUND: {
    description: "Generic fallback for a referenced identifier, grant, session, or other resource that does not exist or is not accessible by the caller. Use when no resource-specific not-found code applies (e.g., property lists, content standards, rights grants, SI offerings, proposals, catalogs, event sources, collection lists, brands, individual properties). Typed parameters that lack a dedicated standard code MUST also use REFERENCE_NOT_FOUND rather than minting a custom *_NOT_FOUND code. See 'Uniform response for inaccessible references' in error-handling.mdx for the full MUST list. Summary of the uniform-response MUST: sellers MUST return the same response for 'exists but the caller lacks access' as for 'does not exist' across every observable channel — error.code/message/field/details (message MUST be generic; error.field MUST be identical across both cases on typed parameters); HTTP status, A2A task.status.state, and MCP isError; response headers (ETag, Cache-Control, per-type rate-limit buckets, CDN tags); side effects (webhook/audit writes, background-job enqueues, per-type quota counters, DB-shard routing); and observability (logs, APM spans, third-party error telemetry like Sentry/Datadog). Sellers MUST perform the same resolution-and-authorization work on both paths (resolve-then-authorize; on true-miss still run an authorization decision of equivalent shape against an empty principal set so authorizer latency is not a side channel). Cache population MUST NOT be gated on authorization. Polymorphism is evaluated against the tool-schema's declared parameter shape before any lookup, and a tool's declared shape MUST be identical across all callers.",
    recovery: "correctable",
    suggestion: "verify the referenced identifier exists and is accessible to the caller"
  },
  REQUOTE_REQUIRED: {
    description: "An update_media_buy request changes the parameter envelope (budget, flight dates, volume, targeting) the original quote was priced against. The pricing_option remains locked; the seller is declining the requested shape at that price. Distinct from TERMS_REJECTED (measurement) and POLICY_VIOLATION (content). Sellers SHOULD populate error.details.envelope_field with the field path(s) that breached the envelope (e.g., 'packages[0].budget', 'end_time') so the buyer's agent can autonomously re-discover.",
    recovery: "correctable",
    suggestion: "re-negotiate via get_products in 'refine' mode against the existing proposal_id to obtain a fresh quote, then resubmit against the new proposal_id"
  },
  SERVICE_UNAVAILABLE: {
    description: "Seller service is temporarily unavailable. Retry with exponential backoff.",
    recovery: "transient",
    suggestion: "retry with exponential backoff"
  },
  SESSION_NOT_FOUND: {
    description: "SI session ID is invalid, expired, or does not exist.",
    recovery: "correctable",
    suggestion: "initiate a new session via si_initiate_session"
  },
  SESSION_TERMINATED: {
    description: "SI session has already been terminated and cannot accept further messages.",
    recovery: "correctable",
    suggestion: "initiate a new session via si_initiate_session"
  },
  SIGNAL_NOT_FOUND: {
    description: "Referenced signal does not exist in the agent's catalog. Sellers MUST return this code uniformly for any signal_id not accessible to the calling account — never distinguish 'exists but unauthorized' from 'does not exist', which would enable cross-tenant enumeration.",
    recovery: "correctable",
    suggestion: "verify signal_id via get_signals, or confirm the signal is available from this agent"
  },
  TERMS_REJECTED: {
    description: "Buyer-proposed measurement_terms were rejected by the seller. The error details SHOULD identify which specific term was rejected and the seller's acceptable range or supported vendors.",
    recovery: "correctable",
    suggestion: "adjust the proposed terms and retry, or omit measurement_terms to accept the product's defaults"
  },
  UNSUPPORTED_FEATURE: {
    description: "A requested feature or field is not supported by this seller.",
    recovery: "correctable",
    suggestion: "check get_adcp_capabilities and remove unsupported fields"
  },
  VALIDATION_ERROR: {
    description: "Request contains invalid field values or violates business rules beyond schema validation.",
    recovery: "correctable",
    suggestion: "review error details and fix field values"
  },
  VERSION_UNSUPPORTED: {
    description: "The declared adcp_major_version is not supported by this seller.",
    recovery: "correctable",
    suggestion: "re-pin to a release in supported_versions and retry, or call get_adcp_capabilities without a version pin to discover supported_versions"
  }
} as const satisfies Record<string, StandardErrorCodeInfo>;

// ---------------------------------------------------------------------------
// Tools by protocol — manifest-grouped const arrays.
// ---------------------------------------------------------------------------

export const ACCOUNT_TOOLS_FROM_MANIFEST = [
  "get_account_financials",
  "list_accounts",
  "report_usage",
  "sync_accounts",
  "sync_governance",
] as const;

export const BRAND_TOOLS_FROM_MANIFEST = [
  "acquire_rights",
  "creative_approval",
  "get_brand_identity",
  "get_rights",
  "update_rights",
] as const;

export const COLLECTION_TOOLS_FROM_MANIFEST = [
  "create_collection_list",
  "delete_collection_list",
  "get_collection_list",
  "list_collection_lists",
  "update_collection_list",
] as const;

export const COMPLIANCE_TOOLS_FROM_MANIFEST = [
  "comply_test_controller",
] as const;

export const CONTENT_STANDARDS_TOOLS_FROM_MANIFEST = [
  "calibrate_content",
  "create_content_standards",
  "get_content_standards",
  "get_media_buy_artifacts",
  "list_content_standards",
  "update_content_standards",
  "validate_content_delivery",
] as const;

export const CREATIVE_TOOLS_FROM_MANIFEST = [
  "get_creative_delivery",
  "get_creative_features",
  "list_creatives",
  "preview_creative",
  "sync_creatives",
] as const;

export const GOVERNANCE_TOOLS_FROM_MANIFEST = [
  "check_governance",
  "get_plan_audit_logs",
  "report_plan_outcome",
  "sync_plans",
] as const;

export const MEDIA_BUY_TOOLS_FROM_MANIFEST = [
  "build_creative",
  "create_media_buy",
  "get_media_buy_delivery",
  "get_media_buys",
  "get_products",
  "list_creative_formats",
  "log_event",
  "provide_performance_feedback",
  "sync_audiences",
  "sync_catalogs",
  "sync_event_sources",
  "update_media_buy",
] as const;

export const PROPERTY_TOOLS_FROM_MANIFEST = [
  "create_property_list",
  "delete_property_list",
  "get_property_list",
  "list_property_lists",
  "update_property_list",
  "validate_property_delivery",
] as const;

export const PROTOCOL_TOOLS_FROM_MANIFEST = [
  "get_adcp_capabilities",
] as const;

export const SIGNALS_TOOLS_FROM_MANIFEST = [
  "activate_signal",
  "get_signals",
] as const;

export const SPONSORED_INTELLIGENCE_TOOLS_FROM_MANIFEST = [
  "si_get_offering",
  "si_initiate_session",
  "si_send_message",
  "si_terminate_session",
] as const;

/**
 * Specialism → required tool list. Adopters claiming a specialism in
 * `get_adcp_capabilities` are expected to implement every tool in the
 * matching list per the spec's specialism YAML.
 */
export const SPECIALISM_REQUIRED_TOOLS = {

} as const;
