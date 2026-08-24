# AdCP Type Summary

> Generated at: 2026-08-24
> @adcp/sdk v14.0.0-beta.7

Curated reference of the types that matter for using the AdCP client. For full generated types see `src/lib/types/tools.generated.ts` and `src/lib/types/core.generated.ts`.

## Client Types

```typescript
interface AgentConfig {
  id: string;
  name: string;
  agent_uri: string;             // MCP: ends with /mcp/, A2A: base domain
  protocol: 'mcp' | 'a2a';
  auth_token?: string;           // Bearer token
  oauth_tokens?: AgentOAuthTokens;
  oauth_resource?: string;       // Explicit RFC 8707 override retained for refresh
  headers?: Record<string, string>;
}

interface TaskResult<T = any> {
  success: boolean;
  status: 'completed' | 'deferred' | 'submitted' | 'input-required'
        | 'auth-required' | 'working' | 'failed' | 'governance-denied';
  data?: T;
  error?: string;
  deferred?: DeferredContinuation<T>;
  submitted?: SubmittedContinuation<T>;
  governance?: GovernanceCheckResult;
  metadata: {
    taskId: string;
    contextId?: string;         // Seller conversation identity
    serverTaskId?: string;      // AdCP tasks/get work handle
    a2aTaskId?: string;         // Live A2A transport Task.id for threading
    taskName: string;
    agent: { id: string; name: string; protocol: string };
    responseTimeMs: number;
    timestamp: string;
    clarificationRounds: number;
    adcpVersion?: string;        // Seller-served release-precision response adcp_version
  };
  conversation?: Message[];
}

type InputHandler = (context: ConversationContext) => InputHandlerResponse;

interface CanonicalReference {
  uri: string;
  digest: string; // sha256:<64 lowercase hex chars>
}

type CanonicalReferenceStatus =
  | 'resolved'
  | 'unresolvable'
  | 'invalid_document'
  | 'invalid_schema'
  | 'digest_mismatch'
  | 'blocked_unsafe_url'
  | 'invalid_ref';

interface CanonicalReferenceResult<T = unknown> {
  ok: boolean;
  status: CanonicalReferenceStatus;
  fromCache: boolean;
  document?: T;
  schemaMeta?: { draft: 'draft-07' | '2020-12'; refCount: number };
  error?: { code: string; retryable: boolean; securitySignal?: 'substitution_attack' };
}

// import { createCanonicalReferenceResolver } from '@adcp/sdk/canonical-references'
// resolver.resolveFormatSchema(ref, { externalRefDigests }) validates pinned JSON Schema refs.

interface ConversationContext {
  messages: Message[];
  inputRequest: {
    question: string;
    field?: string;
    expectedType?: string;
    suggestions?: string[];
  };
  taskId: string;
  agent: { id: string; name: string; protocol: string };
  attempt: number;
  maxAttempts: number;
  deferToHuman(): Promise<{ defer: true; token: string }>;
  abort(reason?: string): never;
}

interface EstablishedProposalScope { principalScope: string; sellerScope: string; sourceAdcpVersion: '3.0' | '3.1'; }
interface EstablishedProposalTaskScope extends EstablishedProposalScope { accountScope: string; }
interface EstablishedProposalBinding extends EstablishedProposalTaskScope { proposalId: string; }
interface EstablishedProposalMutationBinding extends EstablishedProposalBinding { snapshotFingerprint: string; }
interface ProposalSnapshotEntry extends EstablishedProposalBinding { proposal: Record<string, unknown>; expiresAt?: string; canonicalTermsDigest?: string; snapshotFingerprint: string; capturedAt: string; }
type EstablishedProposalOperation = { state: 'available' } | { state: 'reserved' | 'retryable'; operation: 'accept' | 'refine' | 'decline'; operationKey: string; requestFingerprint: string; idempotencyKey?: string; reservedAt: string; retryExpiresAt?: string; sellerTaskId?: string; ambiguity?: 'paused' | 'commit-uncertain' } | { state: 'terminal'; disposition: 'accepted' | 'refined' | 'declined' | 'commit-uncertain'; terminalResultFingerprint?: string; operation: 'accept' | 'refine' | 'decline'; operationKey: string; requestFingerprint: string; idempotencyKey?: string; reservedAt: string; retryExpiresAt?: string; sellerTaskId?: string; };
interface EstablishedProposalRecord { snapshot: ProposalSnapshotEntry; operation: EstablishedProposalOperation; }
interface EstablishedProposalReserveRequest { bindings: readonly EstablishedProposalMutationBinding[]; claim: { operation: 'accept' | 'refine' | 'decline'; operationKey: string; requestFingerprint: string; idempotencyKey?: string; retryTtlMs?: number; }; }
type EstablishedProposalPutResult = { outcome: 'stored' | 'unchanged' | 'fenced'; record: EstablishedProposalRecord } | { outcome: 'missing' | 'capacity' };
type EstablishedProposalReserveResult = { outcome: 'reserved'; records: EstablishedProposalRecord[]; retry: boolean } | { outcome: 'missing' | 'expired' | 'in_flight' | 'ambiguous' | 'terminal' | 'conflict' | 'capacity'; records: EstablishedProposalRecord[] };
type EstablishedProposalTransitionResult = { outcome: 'updated'; records: EstablishedProposalRecord[] } | { outcome: 'missing' | 'conflict' | 'capacity'; records: EstablishedProposalRecord[] };
const ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS = 604800000;
interface EstablishedProposalCompletionWindow { completedAt: string; retainUntil: string; }
interface EstablishedProposalSubmittedOperation { request: EstablishedProposalReserveRequest; records: EstablishedProposalRecord[]; sellerTaskId: string; settled?: boolean; completion?: EstablishedProposalCompletionWindow; }

interface EstablishedProposalStore {
  putSnapshot(snapshot: ProposalSnapshotEntry, expectedSnapshotFingerprint?: string): Promise<EstablishedProposalPutResult>;
  discardSnapshot(binding: EstablishedProposalBinding, expectedSnapshotFingerprint: string): Promise<'discarded' | 'missing' | 'fenced'>;
  get(binding: EstablishedProposalBinding): Promise<EstablishedProposalRecord | undefined>;
  find(scope: EstablishedProposalScope, proposalIds: readonly string[]): Promise<EstablishedProposalRecord[]>;
  findSubmittedTask(scope: EstablishedProposalTaskScope, sellerTaskId: string): Promise<EstablishedProposalSubmittedOperation | undefined>;
  /** Any retained tombstone with this operationKey returns conflict, even if claim or binding evidence differs. */
  reserveMutation(request: EstablishedProposalReserveRequest): Promise<EstablishedProposalReserveResult>;
  completeMutation(request: EstablishedProposalReserveRequest, disposition: 'accepted', terminalResultFingerprint: string): Promise<EstablishedProposalTransitionResult>;
  completeRefinement(request: EstablishedProposalReserveRequest, replacements: readonly ProposalSnapshotEntry[], retainedBindings?: readonly EstablishedProposalMutationBinding[]): Promise<EstablishedProposalTransitionResult>;
  completeDecline(request: EstablishedProposalReserveRequest, retainedBindings?: readonly EstablishedProposalMutationBinding[]): Promise<EstablishedProposalTransitionResult>;
  pruneCompletionTombstones?(limit?: number): Promise<number>;
  releaseMutation(request: EstablishedProposalReserveRequest): Promise<EstablishedProposalTransitionResult>;
  recordSubmittedTask(request: EstablishedProposalReserveRequest, sellerTaskId: string): Promise<EstablishedProposalTransitionResult>;
  markAmbiguous(request: EstablishedProposalReserveRequest, ambiguity: 'paused' | 'commit-uncertain'): Promise<EstablishedProposalTransitionResult>;
}

// After restart: lifecycle.reconcileEstablishedProposalTask({ account, sellerTaskId })
```

## Production Webhook Tenant Binding

An unbound production `WebhookEmitter` is safe to construct with a stable `publisherScope`, durable delivery store, and durable recovery outbox. It refuses direct emission until trusted tenant scope is bound:

```typescript
interface WebhookEmitter {
  emit(params: WebhookEmitParams): Promise<WebhookEmitResult>;
  forTenantScope(tenantScope: string): WebhookEmitter;
}
interface RecoverableWebhookEmitter extends WebhookEmitter {
  emitRecovered(delivery: WebhookRecoveredDelivery): Promise<WebhookEmitResult>;
  forTenantScope(tenantScope: string): RecoverableWebhookEmitter;
}

// Relevant WebhooksConfig fields (other signing and delivery fields omitted):
interface WebhooksConfig {
  publisherScope?: string; // defaults to the trusted server name
  tenantScope?: string;    // explicit trusted single-tenant fallback only
}

const publisher = createWebhookEmitter({ publisherScope: 'publisher', deliveryStore, deliveryRecovery, signerKey });
await publisher.forTenantScope(authenticatedTenant).emit(params);

createAdcpServer({
  name: 'publisher',
  version: '1.0.0',
  // Multi-tenant: omit tenantScope; trusted request context is required.
  webhooks: { signerKey, deliveryStore, deliveryRecovery },
});
createAdcpServer({
  name: 'publisher',
  version: '1.0.0',
  // Genuinely single-tenant: configure the trusted fallback explicitly.
  webhooks: { signerKey, deliveryStore, deliveryRecovery, tenantScope: 'tenant-a' },
});
```

## Trusted Match 3.1.10 Types

```typescript
interface TMPXChunk {
  slot_id: string; // provider-local, never a publisher macro name
  value: string;   // opaque URL-safe value
}

interface IdentityMatchResponseProviderRouter {
  type: 'identity_match_response';
  request_id: string;
  eligible_package_ids: string[];
  serve_window_sec: number;
  tmpx_chunks?: TMPXChunk[]; // 1-2 entries when present
}

interface IdentityMatchResponseRouterPublisher {
  type: 'identity_match_response';
  request_id: string;
  eligible_package_ids: string[];
  serve_window_sec: number;
  tmpx?: string; // deprecated single-token compatibility field
  tmpx_providers?: Record<string, { chunks: TMPXChunk[] }>;
}

interface PublisherTMPXMacroMapping {
  tmpx_macro_mapping: Record<string, Record<string, string>>;
}
```

The two response hops are mutually exclusive privacy boundaries: neither carries `context` or `ext`, providers emit only `tmpx_chunks`, and publisher-facing responses emit only attributed `tmpx_providers`. See `docs/migration-adcp-3.1.8-to-3.1.10.md`.

## Tool Request/Response Shapes

Each tool is called as `agent.<methodName>(params)` and returns `TaskResult<ResponseType>`. Below are the key fields for each tool's request. Fields marked with `*` are required.

### Protocol

**`get_adcp_capabilities`** — Request parameters for cross-protocol capability discovery.

_Request:_
```
{
  protocols: ('media_buy' | 'signals' | 'governance' | 'sponsored_intelligence' | 'creative')[]
  context: Context
}
```

_Response (success branch):_
```
{
  adcp: object  // required
  supported_protocols: ('media_buy' | 'signals' | 'governance' | 'sponsored_intelligence' | 'creative' | 'brand' | 'measurement')[]  // required
  account: object
  media_buy: object
  signals: object
  governance: object
  sponsored_intelligence: object
  brand: object
  creative: object
  oauth: object
  request_signing: object
  webhook_signing: object
  identity: object
  measurement_gateway: object
  measurement: object
  compliance_testing: object
  specialisms: Specialism[]
  extensions_supported: string[]
  experimental_features: string[]
  wholesale_feed_versioning: object
  last_updated: string
  errors: Error[]
  context: Context
  wholesale_feed_webhooks: object
}
```

**`get_task_status`** — Request parameters for get_task_status, the 3.

_Request:_
```
{
  task_id: string  // required
  account: Account Ref
  include_history: boolean
  include_result: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  task_id: string  // required
  task_type: Task Type  // required
  protocol: Adcp Protocol  // required
  status: Task Status  // required
  created_at: string  // required
  updated_at: string  // required
  completed_at: string
  has_webhook: boolean
  progress: object
  error: object
  history: object[]
  result: object
  context: Context
}
```

**`list_tasks`** — Request parameters for list_tasks, the 3.

_Request:_
```
{
  account: Account Ref
  filters: object
  sort: object
  pagination: Pagination Request
  include_history: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  query_summary: object  // required
  tasks: object[]  // required
  pagination: Pagination Response  // required
  context: Context
}
```

**`sync_agent_notification_configs`** — Register, replace, pause, or clear agent-level webhook subscribers such as capabilities.

_Request:_
```
{
  idempotency_key: string  // required
  notification_configs: object[]  // required
  dry_run: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  action: 'updated' | 'unchanged' | 'cleared' | 'failed'  // required
  dry_run: boolean
  notification_configs: Agent Notification Config[]
  errors: Error[]
  context: Context
}
```

### Account Management

**`list_accounts`** — Request parameters for listing accounts accessible to the authenticated agent.

_Request:_
```
{
  account: Account Ref
  status: 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed'
  pagination: Pagination Request
  sandbox: boolean
  include_webhook_activity: boolean
  webhook_activity_limit: integer
  context: Context
}
```

_Response (success branch):_
```
{
  accounts: Account With Authorization[]  // required
  errors: Error[]
  pagination: Pagination Response
  context: Context
}
```

**`sync_accounts`** — Request parameters for syncing advertiser accounts with a seller.

_Request:_
```
{
  idempotency_key: string  // required
  accounts: (ProvisioningMode | SettingsUpdateMode)[]  // required
  delete_missing: boolean
  dry_run: boolean
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  accounts: object[]  // required
  dry_run: boolean
  context: Context
}
```

**`sync_governance`** — Request parameters for registering governance agent endpoints on accounts.

_Request:_
```
{
  idempotency_key: string  // required
  accounts: object[]  // required
  context: Context
}
```

_Response (success branch):_
```
{
  accounts: object[]  // required
  context: Context
}
```

**`report_usage`** — Request parameters for reporting vendor service consumption after delivery.

_Request:_
```
{
  idempotency_key: string  // required
  reporting_period: Datetime Range  // required
  usage: object[]  // required
  context: Context
}
```

_Response (success branch):_
```
{
  accepted: integer  // required
  errors: Error[]
  sandbox: boolean
  context: Context
}
```

**`get_account_financials`** — Request parameters for querying financial status of an operator-billed account.

_Request:_
```
{
  account: Account Ref  // required
  period: Date Range
  context: Context
}
```

_Response (success branch):_
```
{
  account: Account Ref  // required
  currency: string  // required
  period: Date Range  // required
  timezone: string  // required
  spend: object
  credit: object
  balance: object
  payment_status: 'current' | 'past_due' | 'suspended'
  payment_terms: Payment Terms
  invoices: object[]
  context: Context
}
```

### Media Buying

**`get_products`** — AdCP 3.

_Request:_
```
{
  buying_mode: 'brief' | 'wholesale' | 'refine'  // required
  idempotency_key: string
  brief: string
  refine: object[]
  brand: Brand Ref
  catalog: Catalog
  account: Account Ref
  preferred_delivery_types: Delivery Type[]
  filters: Product Filters
  targeting_overlay: Targeting
  required_overlay_support: Targeting Overlay Requirements
  property_list: Property List Ref
  fields: ('product_id' | 'name' | 'description' | 'publisher_properties' | 'channels' | 'video_placement_types' | 'audio_distribution_types' | 'sponsored_placement_types' | 'social_placement_surfaces' | 'format_ids' | 'format_options' | 'placements' | 'delivery_type' | 'exclusivity' | 'pricing_options' | 'forecast' | 'outcome_measurement' | 'delivery_measurement' | 'reporting_capabilities' | 'creative_policy' | 'catalog_types' | 'metric_optimization' | 'conversion_tracking' | 'data_provider_signals' | 'included_signals' | 'signal_targeting_allowed' | 'signal_targeting_options' | 'signal_targeting_rules' | 'demographic_targeting' | 'overlay_support' | 'targeting_resolution' | 'audience_evidence' | 'audience_evidence_selections' | 'max_optimization_goals' | 'catalog_match' | 'collections' | 'collection_targeting_allowed' | 'installments' | 'brief_relevance' | 'is_custom' | 'expires_at' | 'product_card' | 'product_card_detailed' | 'enforced_policies' | 'trusted_match')[]
  time_budget
  push_notification_config: Push Notification Config
  pagination: Pagination Request
  if_wholesale_feed_version: string
  if_pricing_version: string
  context: Context
  required_policies: string[]
}
```

_Response (success branch):_
```
{
  products: Product[]
  targeting_resolution: Get Products Targeting Resolution
  extensions: object
  proposals: Proposal[]
  errors: Error[]
  reason: string
  suggestions: string[]
  property_list_applied: boolean
  catalog_applied: boolean
  refinement_applied: object[]
  incomplete: object[]
  filter_diagnostics: object
  pagination: Pagination Response
  wholesale_feed_version: string
  pricing_version: string
  cache_scope: 'public' | 'account'
  unchanged: 'true'
  sandbox: boolean
  context: Context
}
```

_Watch out:_
- `cache_scope` is required whenever the response includes `products` or `unchanged: true`. Use `public` for the universal rate card and `account` for account-specific rate cards or pricing overlays.
- SDK server handlers may omit `cache_scope` only for no-account product feeds; the framework can safely infer `public` only when there is no inline account and no auth-derived/resolved account.

**`list_products`** — Request parameters for synchronous product-offer reads.

_Request:_
```
{
  adcp_version: Adcp_version
  idempotency_key: string
  context_id: string
  context
  governance_context: string
  push_notification_config
  account
  brand: Brand Key
  criteria: Product Discovery Criteria
  fields: Product Fields
  cursor: string
  max_results: integer
  if_feed_version: string
  if_pricing_version: string
}
```

_Response (success branch):_
```
{
  outcome: 'listed'  // required
}
```

**`request_proposals`** — Request parameters for creating actionable seller proposals.

_Request:_
```
{
  idempotency_key: string  // required
  brief: string  // required
  adcp_version: Adcp_version
  context_id: string
  context
  governance_context: string
  push_notification_config
  account
  brand: Brand Key
  criteria: Product Discovery Criteria
  opportunity
}
```

_Response (success branch):_
```
{
  outcome: 'proposed'  // required
  status: 'completed'
}
```

**`refine_proposals`** — Request parameters for creating one or more proposal revisions.

_Request:_
```
{
  idempotency_key: string  // required
  refinements: Proposal Refinement[]  // required
  adcp_version: Adcp_version
  context_id: string
  context
  governance_context: string
  push_notification_config
}
```

_Response (success branch):_
```
{
  status: 'completed'
}
```

**`decline_proposals`** — Request parameters for terminally declining one or more proposals.

_Request:_
```
{
  idempotency_key: string  // required
  declines: Proposal Decline[]  // required
  adcp_version: Adcp_version
  context_id: string
  context
  governance_context: string
  push_notification_config
  opportunity: Opportunity Context
}
```


**`buy_products`** — Create a MediaBuy directly from canonical published product offers.

_Request:_
```
{
  idempotency_key: string  // required
  account  // required
  feed_version: string  // required
  purchases: Product Purchase[]  // required
  start_time: Start Timing  // required
  end_time: string  // required
  adcp_version: Adcp_version
  brand: Brand Key
  advertiser_industry: Advertiser Industry
  pricing_version: string
  total_budget: object
  daily_budget_cap: number
  budget_cap_timezone: string
  budget_allocation: Canonical Budget Allocation
  pacing: Pacing
  bidding: Bidding Policy
  paused: boolean
  purchase_order_ref: string
  agency_estimate_number: string
  invoice_recipient: Business Entity
  governance_context: string
  push_notification_config: Push Notification Config
  reporting_webhook: Reporting Webhook
  opportunity
  context: Context
}
```


**`accept_proposal`** — Accept a committed new-buy, amendment, or cancellation proposal.

_Request:_
```
{
  idempotency_key: string  // required
  account: Canonical Account Ref  // required
  proposal_id: string  // required
  proposal_terms_digest: string  // required
  adcp_version: Adcp_version
  total_budget: object
  daily_budget_cap: number
  budget_cap_timezone: string
  io_acceptance: object
  purchase_order_ref: string
  governance_context: string
  push_notification_config: Push Notification Config
  reporting_webhook: Reporting Webhook
  opportunity
  context: Context
}
```


**`control_media_buy`** — Apply operational controls inside accepted commercial terms.

_Request:_
```
{
  idempotency_key: string  // required
  account: Canonical Account Ref  // required
  media_buy_id: string  // required
  revision: integer  // required
  adcp_version: Adcp_version
  name: string
  paused: boolean
  canceled: 'true'
  cancellation_reason: string
  total_budget: object
  daily_budget_cap: number,null
  budget_cap_timezone: string,null
  budget_allocation: Canonical Budget Allocation
  pacing: Pacing
  bidding: Bidding Policy | null
  packages: Package Control[]
  reporting_webhook: Reporting Webhook
  governance_context: string
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  status: 'completed'  // required
  media_buy_id: string  // required
  revision: integer  // required
  media_buy_status: Media Buy Status
  implementation_date: string,null
  affected_package_ids: string[]
  available_actions: Canonical Media Buy Action[]
  warnings: object[]
  context: Context
  replayed: 'true'
}
```

**`list_creative_formats`** — Deprecated 3.

_Request:_
```
{
  format_ids: Format Id[]
  asset_types: Asset Content Type[]
  max_width: integer
  max_height: integer
  min_width: integer
  min_height: integer
  is_responsive: boolean
  name_search: string
  publisher_domain: string
  property_id: Property Id
  wcag_level: Wcag Level
  disclosure_positions: Disclosure Position[]
  disclosure_persistence: Disclosure Persistence[]
  output_format_ids: Format Id[]
  input_format_ids: Format Id[]
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  formats: Format[]  // required
  source: 'publisher' | 'aao_mirror' | 'agent_derived'
  creative_agents: object[]
  errors: Error[]
  pagination: Pagination Response
  sandbox: boolean
  context: Context
}
```

_Watch out:_
- Each `renders[]` entry satisfies a `oneOf` — exactly one of `dimensions` (object) OR `parameters_from_format_id: true`. A render with only `{ role }` (or `{ role, duration_seconds }`) fails validation.
- Use the typed factories from `@adcp/sdk`: `displayRender({ role, dimensions })` for display/video; `parameterizedRender({ role })` for audio and template formats (auto-injects `parameters_from_format_id: true`).
- Audio formats (`type: "audio"`) have no width/height — declare `renders: [parameterizedRender({ role: "primary" })]` and encode duration/codec in `format_id.parameters` (declared via `accepts_parameters`).

**`create_media_buy`** — AdCP 3.

_Request:_
```
{
  idempotency_key: string  // required
  account: Account Ref  // required
  brand: Brand Ref  // required
  start_time: Start Timing  // required
  end_time: string  // required
  governance_context: string
  plan_id: string
  proposal_id: string
  opportunity
  total_budget: object
  daily_budget_cap: number
  budget_cap_timezone: string
  budget_allocation
  packages: Package Request[]
  advertiser_industry: Advertiser Industry
  invoice_recipient: Business Entity
  io_acceptance: object
  po_number: string
  name: string
  agency_estimate_number: string
  pacing: Pacing
  bidding
  paused: boolean
  push_notification_config: Push Notification Config
  reporting_webhook: Reporting Webhook
  artifact_webhook: object
  context: Context
}
```

_Response (success branch):_
```
{
  media_buy_id: string  // required
  confirmed_at: string,null  // required
  revision: integer  // required
  packages: Package[]  // required
  proposal_id: string
  name: string
  account: Account
  invoice_recipient: Business Entity
  media_buy_status: Media Buy Status
  creative_deadline: string
  currency: string
  total_budget: number
  daily_budget_cap: number
  budget_cap_timezone: string
  budget_allocation
  pacing: Pacing
  bidding
  valid_actions: Media Buy Valid Action[]
  available_actions: Media Buy Available Action[]
  planned_delivery: Planned Delivery
  warnings: Warning[]
  sandbox: boolean
  context: Context
}
```

_Watch out:_
- Server handlers should return business lifecycle state as `media_buy_status`. The framework owns the task envelope `status`; do not return top-level `status` as the media-buy state.

**`update_media_buy`** — AdCP 3.

_Request:_
```
{
  account: Account Ref  // required
  media_buy_id: string  // required
  idempotency_key: string  // required
  governance_context: string
  name: string
  revision: integer
  paused: boolean
  canceled: 'true'
  cancellation_reason: string
  start_time: Start Timing
  end_time: string
  total_budget: object
  daily_budget_cap: number,null
  budget_cap_timezone: string,null
  budget_allocation
  pacing: Pacing
  bidding: Bidding Policy | null
  packages: Package Update[]
  invoice_recipient: Business Entity
  new_packages: Package Request[]
  reporting_webhook: Reporting Webhook
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  media_buy_id: string  // required
  revision: integer  // required
  name: string
  media_buy_status: Media Buy Status
  currency: string
  total_budget: number
  daily_budget_cap: number
  budget_cap_timezone: string
  budget_allocation
  pacing: Pacing
  bidding
  implementation_date: string,null
  invoice_recipient: Business Entity
  affected_packages: Package[]
  valid_actions: Media Buy Valid Action[]
  available_actions: Media Buy Available Action[]
  warnings: Warning[]
  sandbox: boolean
  context: Context
}
```

_Watch out:_
- Server handlers should return business lifecycle state as `media_buy_status`. The framework owns the task envelope `status`; do not return top-level `status` as the media-buy state.

**`get_media_buys`** — Request parameters for retrieving media buy status, creative approvals, and delivery snapshots.

_Request:_
```
{
  account: Account Ref
  media_buy_ids: string[]
  status_filter: Media Buy Status | Media Buy Status[]
  indicator_types: Indicator Type[]
  include_snapshot: boolean
  include_history: integer
  include_webhook_activity: boolean
  webhook_activity_limit: integer
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  media_buys: object[]  // required
  errors: Error[]
  pagination: Pagination Response
  sandbox: boolean
  context: Context
}
```

**`get_media_buy_delivery`** — Request parameters for retrieving comprehensive delivery metrics.

_Request:_
```
{
  account: Account Ref
  media_buy_ids: string[]
  status_filter: Media Buy Status | Media Buy Status[]
  start_date: string
  end_date: string
  include_package_daily_breakdown: boolean
  requested_metrics: Available Metric[]
  time_granularity: Reporting Frequency
  include_window_breakdown: boolean
  attribution_window: object
  reporting_dimensions: object
  context: Context
}
```

_Response (success branch):_
```
{
  reporting_period: object  // required
  currency: string  // required
  media_buy_deliveries: object[]  // required
  notification_type: 'scheduled' | 'final' | 'delayed' | 'adjusted' | 'window_update'
  partial_data: boolean
  unavailable_count: integer
  sequence_number: integer
  next_expected_at: string
  attribution_window: Attribution Window
  aggregated_totals: object
  errors: Error[]
  sandbox: boolean
  context: Context
}
```

**`provide_performance_feedback`** — Request parameters for sharing performance outcomes with publishers.

_Request:_
```
{
  idempotency_key: string  // required
  context: Context
}
```

_Response (success branch):_
```
{
  success: 'true'  // required
  feedback_id: string
  application_status: 'accepted' | 'applied' | 'not_applied'
  status_reason: string
  received_at: string
  applied_at: string
  sandbox: boolean
  context: Context
}
```

**`sync_event_sources`** — Request parameters for configuring event sources on an account.

_Request:_
```
{
  idempotency_key: string  // required
  account: Account Ref  // required
  event_sources: object[]
  delete_missing: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  event_sources: object[]  // required
  sandbox: boolean
  context: Context
}
```

**`log_event`** — Request parameters for logging conversion or marketing events.

_Request:_
```
{
  event_source_id: string  // required
  events: Event[]  // required
  idempotency_key: string  // required
  test_event_code: string
  context: Context
}
```

_Response (success branch):_
```
{
  events_received: integer  // required
  events_processed: integer  // required
  partial_failures: object[]
  warnings: string[]
  match_quality: number
  sandbox: boolean
  context: Context
}
```

**`sync_audiences`** — Request parameters for managing CRM-based audiences on an account.

_Request:_
```
{
  idempotency_key: string  // required
  account: Account Ref  // required
  audiences: object[]
  delete_missing: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  audiences: object[]  // required
  sandbox: boolean
  context: Context
}
```

**`sync_catalogs`** — Request parameters for syncing catalog feeds (products, inventory, stores, promotions, offerings) with approval workflow.

_Request:_
```
{
  idempotency_key: string  // required
  account: Account Ref  // required
  catalogs: Catalog[]
  item_availability_updates: Catalog Item Availability Update[]
  item_availability_queries: Catalog Item Availability Ref[]
  catalog_ids: string[]
  delete_missing: boolean
  dry_run: boolean
  validation_mode: Validation Mode
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  catalogs: object[]  // required
  status: 'completed'
  dry_run: boolean
  item_availability_updates: Catalog Item Availability Update Result[]
  item_availability_states: Catalog Item Availability State[]
  sandbox: boolean
  context: Context
}
```

### Creative

**`build_creative`** — Request parameters for AI-powered creative generation.

_Request:_
```
{
  idempotency_key: string  // required
  governance_context: string
  message: string
  creative_manifest: Creative Manifest
  creative_id: string
  concept_id: string
  media_buy_id: string
  package_id: string
  target_format_id: Format Id
  target_format_ids: Format Id[]
  target_capability_id: string
  target_capability_ids: string[]
  transformer_id: string
  config: object
  refine_from_build_variant_id: string
  mode: 'execute' | 'estimate'
  max_spend: object
  max_creatives: integer
  signal_conditions: object[]
  max_variants: integer
  variant_axis: object
  keep_mode: 'keep_all' | 'keep_one' | 'keep_some'
  selection_strategy: Creative Selection Strategy
  account: Account Ref
  brand: Brand Ref
  quality: Creative Quality
  evaluator: Evaluator Spec
  item_limit: integer
  include_preview: boolean
  preview_inputs: object[]
  preview_quality: Creative Quality
  preview_output_format: Preview Output Format
  macro_values: object
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  creative_manifest: Creative Manifest  // required
  build_variant_id: string
  recipe_hash: string
  sandbox: boolean
  expires_at: string
  preview: object
  preview_error: Error
  pricing_option_id: string
  vendor_cost: number
  currency: string
  consumption: Creative Consumption
  context: Context
}
```

_Watch out:_
- Response is ALWAYS `{ creative_manifest }` (single) or `{ creative_manifests }` (multi). Platform-native fields at the top level (`tag_url`, `creative_id`, `media_type`) are invalid.
- Use `buildCreativeResponse({ creative_manifest })` / `buildCreativeMultiResponse({ creative_manifests })` from `@adcp/sdk/server` to enforce the shape at compile time.
- Each asset under `creative_manifest.assets` needs an `asset_type` discriminator — use the factories: `imageAsset`, `videoAsset`, `audioAsset`, `htmlAsset`, `urlAsset`, `textAsset` (or `Asset.image(...)`).

**`preview_creative`** — Request parameters for generating creative previews.

_Request:_
```
{
  request_type: 'single' | 'batch' | 'variant'  // required
  creative_manifest: Creative Manifest
  target_capability_id: string
  format_id: Format Id
  inputs: object[]
  template_id: string
  quality: Creative Quality
  output_format: Preview Output Format
  item_limit: integer
  requests: object[]
  variant_id: string
  creative_id: string
  allow_async: boolean
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  response_type: 'single'  // required
  previews: object[]  // required
  quality_used: Creative Quality
  interactive_url: string
  expires_at: string
  context: Context
}
```

_Watch out:_
- Each `renders[]` entry is a oneOf on `output_format` — use `urlRender({...})`, `htmlRender({...})`, or `bothRender({...})` to inject the discriminator and require the matching `preview_url`/`preview_html` field.

**`list_creative_formats`** — Deprecated 3.

_Request:_
```
{
  format_ids: Format Id[]
  type: 'audio' | 'video' | 'display' | 'dooh'
  asset_types: Asset Content Type[]
  max_width: integer
  max_height: integer
  min_width: integer
  min_height: integer
  is_responsive: boolean
  name_search: string
  wcag_level: Wcag Level
  disclosure_positions: Disclosure Position[]
  disclosure_persistence: Disclosure Persistence[]
  output_format_ids: Format Id[]
  input_format_ids: Format Id[]
  include_pricing: boolean
  account: Account Ref
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  formats: Format[]  // required
  creative_agents: object[]
  errors: Error[]
  pagination: Pagination Response
  context: Context
}
```

_Watch out:_
- Each `renders[]` entry satisfies a `oneOf` — exactly one of `dimensions` (object) OR `parameters_from_format_id: true`. A render with only `{ role }` (or `{ role, duration_seconds }`) fails validation.
- Use the typed factories from `@adcp/sdk`: `displayRender({ role, dimensions })` for display/video; `parameterizedRender({ role })` for audio and template formats (auto-injects `parameters_from_format_id: true`).
- Audio formats (`type: "audio"`) have no width/height — declare `renders: [parameterizedRender({ role: "primary" })]` and encode duration/codec in `format_id.parameters` (declared via `accepts_parameters`).

**`list_transformers`** — Request parameters for discovering account-scoped creative transformers (the creative analog of products), with optional brief filtering, per-param option expansion, and pricing.

_Request:_
```
{
  transformer_ids: string[]
  input_format_ids: Format Id[]
  output_format_ids: Format Id[]
  input_format_kinds: Canonical Format Kind[]
  output_capability_ids: string[]
  name_search: string
  brief: string
  expand_params: string[]
  expand_pagination: object[]
  include_pricing: boolean
  account: Account Ref
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  transformers: Transformer[]  // required
  errors: Error[]
  pagination: Pagination Response
  context: Context
}
```

**`get_creative_delivery`** — Request parameters for retrieving creative delivery data with variant-level breakdowns.

_Request:_
```
{
  account: Account Ref
  media_buy_ids: string[]
  creative_ids: string[]
  start_date: string
  end_date: string
  max_variants: integer
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  currency: string  // required
  reporting_period: object  // required
  creatives: object[]  // required
  account_id: string
  media_buy_id: string
  pagination: object
  errors: Error[]
  context: Context
}
```

**`list_creatives`** — Request parameters for querying creative library with filtering and pagination.

_Request:_
```
{
  filters: Creative Filters
  sort: object
  pagination: Pagination Request
  include_assignments: boolean
  assignment_projection: 'all' | 'matching'
  assignment_limit: integer
  include_snapshot: boolean
  include_items: boolean
  include_variables: boolean
  include_pricing: boolean
  include_purged: boolean
  include_webhook_activity: boolean
  webhook_activity_limit: integer
  account: Account Ref
  fields: ('creative_id' | 'name' | 'format_id' | 'format_kind' | 'format_option_ref' | 'assets' | 'status' | 'created_date' | 'updated_date' | 'tags' | 'rights' | 'rights_attestation_evaluations' | 'localization' | 'localization_unavailable' | 'assignments' | 'snapshot' | 'items' | 'variables' | 'concept' | 'pricing_options')[]
  context: Context
}
```

_Response (success branch):_
```
{
  query_summary: object  // required
  pagination: Pagination Response  // required
  creatives: (Listed creative (named-format reference) | Listed creative (canonical format kind))[]  // required
  format_summary: object
  status_summary: object
  errors: Error[]
  sandbox: boolean
  context: Context
}
```

**`sync_creatives`** — Request parameters for syncing creative assets with upsert semantics.

_Request:_
```
{
  account: Account Ref  // required
  idempotency_key: string  // required
  creatives: object[]
  creative_ids: string[]
  assignments: object[]
  assignment_operations: (Assign or update | Unassign | Replace assignment)[]
  delete_missing: boolean
  dry_run: boolean
  validation_mode: Validation Mode
  push_notification_config: Push Notification Config
  context: Context
}
```

_Response (success branch):_
```
{
  creatives: object[]  // required
  dry_run: boolean
  sandbox: boolean
  context: Context
}
```

**`validate_input`** — Request parameters for validating a creative manifest against canonical formats and/or specific products without committing to a render.

_Request:_
```
{
  manifest: Creative Manifest  // required
  account: Account Ref
  brand: Brand Ref
  targets: union[]
}
```

_Response (success branch):_
```
{
  results: Validate Input Result[]  // required
}
```

### Signals

**`get_signals`** — Request parameters for discovering signals based on description.

_Request:_
```
{
  discovery_mode: 'brief' | 'wholesale'
  account: Account Ref
  signal_spec: string
  signal_refs: Signal Ref[]
  signal_ids: Signal Id[]
  destinations: Destination[]
  countries: string[]
  filters: Signal Filters
  fields: ('signal_ref' | 'signal_id' | 'signal_agent_segment_id' | 'name' | 'description' | 'value_type' | 'categories' | 'range' | 'demographic_predicate' | 'signal_type' | 'data_provider' | 'coverage_percentage' | 'deployments' | 'pricing_options' | 'taxonomy' | 'data_sources' | 'methodology' | 'segmentation_criteria' | 'criteria_url' | 'refresh_cadence' | 'lookback_window' | 'onboarder' | 'modeling' | 'audience_expansion' | 'device_expansion' | 'countries' | 'consent_basis' | 'restricted_attributes' | 'policy_categories' | 'art9_basis' | 'data_subject_rights' | 'last_updated')[]
  max_results: integer
  pagination: Pagination Request
  push_notification_config: Push Notification Config
  if_wholesale_feed_version: string
  if_pricing_version: string
  context: Context
}
```

_Response (success branch):_
```
{
  signals: object[]
  errors: Error[]
  incomplete: object[]
  wholesale_feed_version: string
  pricing_version: string
  cache_scope: 'public' | 'account'
  unchanged: 'true'
  pagination: Pagination Response
  sandbox: boolean
  context: Context
}
```

**`activate_signal`** — Request parameters for activating a signal on a specific platform/account.

_Request:_
```
{
  signal_agent_segment_id: string  // required
  destinations: Destination[]  // required
  idempotency_key: string  // required
  action: 'activate' | 'deactivate'
  pricing_option_id: string
  governance_context: string
  account: Account Ref
  context: Context
}
```

_Response (success branch):_
```
{
  deployments: Deployment[]  // required
  sandbox: boolean
  context: Context
}
```

### Governance

**`create_property_list`** — Request parameters for creating a new property list.

_Request:_
```
{
  name: string  // required
  idempotency_key: string  // required
  account: Account Ref
  description: string
  base_properties: Base Property Source[]
  filters: Property List Filters
  brand: Brand Ref
  context: Context
}
```

_Response (success branch):_
```
{
  list: Property List  // required
  auth_token: string  // required
  replayed: boolean
  context: Context
}
```

**`update_property_list`** — Request parameters for updating an existing property list.

_Request:_
```
{
  list_id: string  // required
  idempotency_key: string  // required
  account: Account Ref
  name: string
  description: string
  base_properties: Base Property Source[]
  filters: Property List Filters
  brand: Brand Ref
  webhook_url: string
  context: Context
}
```

_Response (success branch):_
```
{
  list: Property List  // required
  replayed: boolean
  context: Context
}
```

**`get_property_list`** — Request parameters for retrieving a property list with resolved properties.

_Request:_
```
{
  list_id: string  // required
  account: Account Ref
  resolve: boolean
  pagination: object
  context: Context
}
```

_Response (success branch):_
```
{
  list: Property List  // required
  identifiers: Identifier[]
  pagination: Pagination Response
  resolved_at: string
  cache_valid_until: string
  coverage_gaps: object
  context: Context
}
```

**`list_property_lists`** — Request parameters for listing property lists.

_Request:_
```
{
  account: Account Ref
  name_contains: string
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  lists: Property List[]  // required
  pagination: Pagination Response
  context: Context
}
```

**`delete_property_list`** — Request parameters for deleting a property list.

_Request:_
```
{
  list_id: string  // required
  idempotency_key: string  // required
  account: Account Ref
  context: Context
}
```

_Response (success branch):_
```
{
  deleted: boolean  // required
  list_id: string  // required
  replayed: boolean
  context: Context
}
```

**`create_collection_list`** — Request parameters for creating a new collection list.

_Request:_
```
{
  name: string  // required
  idempotency_key: string  // required
  account: Account Ref
  description: string
  base_collections: Base Collection Source[]
  filters: Collection List Filters
  brand: Brand Ref
  context: Context
}
```

_Response (success branch):_
```
{
  list: Collection List  // required
  auth_token: string  // required
  replayed: boolean
  context: Context
}
```

**`update_collection_list`** — Request parameters for updating an existing collection list.

_Request:_
```
{
  list_id: string  // required
  idempotency_key: string  // required
  account: Account Ref
  name: string
  description: string
  base_collections: Base Collection Source[]
  filters: Collection List Filters
  brand: Brand Ref
  webhook_url: string
  context: Context
}
```

_Response (success branch):_
```
{
  list: Collection List  // required
  replayed: boolean
  context: Context
}
```

**`get_collection_list`** — Request parameters for retrieving a collection list with resolved collections.

_Request:_
```
{
  list_id: string  // required
  account: Account Ref
  resolve: boolean
  pagination: object
  context: Context
}
```

_Response (success branch):_
```
{
  list: Collection List  // required
  collections: object[]
  pagination: Pagination Response
  resolved_at: string
  cache_valid_until: string
  coverage_gaps: object
  context: Context
}
```

**`list_collection_lists`** — Request parameters for listing collection lists.

_Request:_
```
{
  account: Account Ref
  name_contains: string
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  lists: Collection List[]  // required
  pagination: Pagination Response
  context: Context
}
```

**`delete_collection_list`** — Request parameters for deleting a collection list.

_Request:_
```
{
  list_id: string  // required
  idempotency_key: string  // required
  account: Account Ref
  context: Context
}
```

_Response (success branch):_
```
{
  deleted: boolean  // required
  list_id: string  // required
  replayed: boolean
  context: Context
}
```

**`list_content_standards`** — Request parameters for listing content standards configurations.

_Request:_
```
{
  channels: Channels[]
  languages: string[]
  countries: string[]
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  standards: Content Standards[]  // required
  pagination: Pagination Response
  context: Context
}
```

**`get_content_standards`** — Request parameters for retrieving a specific standards configuration.

_Request:_
```
{
  standards_id: string  // required
  context: Context
}
```

_Response (success branch):_
```
{
  context: Context
}
```

**`create_content_standards`** — Request parameters for creating a new content standards configuration.

_Request:_
```
{
  scope: object  // required
  idempotency_key: string  // required
  registry_policy_ids: string[]
  policies: Policy Entry[]
  calibration_exemplars: object
  context: Context
}
```

_Response (success branch):_
```
{
  standards_id: string  // required
  context: Context
}
```

**`update_content_standards`** — Request parameters for updating an existing content standards configuration.

_Request:_
```
{
  standards_id: string  // required
  idempotency_key: string  // required
  scope: object
  registry_policy_ids: string[]
  policies: Policy Entry[]
  calibration_exemplars: object
  context: Context
}
```

_Response (success branch):_
```
{
  success: 'true'  // required
  standards_id: string  // required
  context: Context
}
```

**`calibrate_content`** — Request parameters for collaborative calibration dialogue.

_Request:_
```
{
  standards_id: string  // required
  artifact: Artifact  // required
  idempotency_key: string  // required
  context: Context
}
```

_Response (success branch):_
```
{
  verdict: Binary Verdict  // required
  confidence: number
  explanation: string
  features: object[]
  context: Context
}
```

**`validate_content_delivery`** — Request parameters for batch validating delivery records.

_Request:_
```
{
  standards_id: string  // required
  records: object[]  // required
  feature_ids: string[]
  include_passed: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  summary: object  // required
  results: object[]  // required
  context: Context
}
```

**`get_media_buy_artifacts`** — Request parameters for retrieving content artifacts from a media buy.

_Request:_
```
{
  media_buy_id: string  // required
  account: Account Ref
  package_ids: string[]
  failures_only: boolean
  time_range: object
  pagination: object
  context: Context
}
```

_Response (success branch):_
```
{
  media_buy_id: string  // required
  artifacts: object[]  // required
  collection_info: object
  pagination: Pagination Response
  context: Context
}
```

**`get_creative_features`** — Request parameters for evaluating creative features from a governance agent.

_Request:_
```
{
  creative_manifest: Creative Manifest  // required
  feature_ids: string[]
  account: Account Ref
  context: Context
}
```

_Response (success branch):_
```
{
  results: Creative Feature Result[]  // required
  detail_url: string
  audit_observations: Audit Observation[]
  pricing_option_id: string
  vendor_cost: number
  currency: string
  consumption: Creative Consumption
  context: Context
}
```

**`sync_plans`** — Push campaign plans to the governance agent.

_Request:_
```
{
  idempotency_key: string  // required
  plans: object[]  // required
  context: Context
}
```

_Response (success branch):_
```
{
  plans: object[]  // required
  replayed: boolean
  context: Context
}
```

**`report_plan_outcome`** — Report the outcome of an action to the governance agent.

_Request:_
```
{
  plan_id: string  // required
  idempotency_key: string  // required
  outcome: Outcome Type  // required
  check_id: string
  purchase_type: Purchase Type
  seller_response: object
  delivery: object
  error: object
  governance_context: string
  context: Context
}
```

_Response (success branch):_
```
{
  outcome_id: string  // required
  outcome_state: 'accepted' | 'findings'  // required
  committed_budget: number
  delivery_reconciliation_status: 'consistent' | 'measurement_variance' | 'disputed' | 'unmatched' | 'closed_unresolved'
  delivery_period_state: 'open' | 'closed'
  findings: object[]
  plan_summary: object
  replayed: boolean
  context: Context
}
```

**`report_plan_adjustment`** — Seller-authenticated append-only commitment adjustment report.

_Request:_
```
{
  action: 'report' | 'review'  // required
  plan_id: string  // required
  idempotency_key: string  // required
  outcome_id: string
  adjustment_id: string
  decision: 'accept' | 'dispute'
  seller_reference: string
  seller_adjustment_id: string
  adjustment_type: 'decommitment' | 'refund' | 'credit' | 'makegood'
  amount: object
  reason: string
  effective_at: string
  evidence: object
  context: Context
}
```

_Response (success branch):_
```
{
  adjustment_id: string  // required
  adjustment_state: 'reported' | 'verified' | 'disputed'  // required
  adjustment_type: 'decommitment' | 'refund' | 'credit' | 'makegood'  // required
  amount: object  // required
  headroom_restored: number  // required
  plan_summary: object  // required
  replayed: boolean
  context: Context
}
```

**`get_plan_audit_logs`** — Retrieve governance state and audit trail for a plan.

_Request:_
```
{
  plan_ids: string[]
  portfolio_plan_ids: string[]
  governance_contexts: string[]
  purchase_types: Purchase Type[]
  include_entries: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  plans: object[]  // required
  context: Context
}
```

**`check_governance`** — Orchestrator or seller calls the governance agent to validate an action against the campaign plan.

_Request:_
```
{
  caller: string  // required
  plan_id: string
  purchase_type: Purchase Type
  target_agent: string
  proposed_commitment: object
  execution_commitment: object
  tool: string
  payload: object
  proposal: Canonical Proposal
  governance_context: string
  consultation_context: string
  phase: Governance Phase
  planned_delivery: Planned Delivery
  delivery_metrics: object
  modification_summary: string
  runtime_attestations: object[]
  invoice_recipient: Business Entity
  context: Context
}
```

_Response (success branch):_
```
{
  check_id: string  // required
  verdict: Governance Decision  // required
  explanation: string  // required
  check_type: 'intent' | 'execution'
  plan_id: string
  findings: object[]
  conditions: object[]
  consultation_context: string
  expires_at: string
  next_check: string
  delivery_statement: object
  categories_evaluated: string[]
  policies_evaluated: string[]
  mode: Governance Mode
  runtime_attestation_evaluations: object[]
  runtime_attestation_binding_digest: string
  governance_context: string
  context: Context
}
```

### Sponsored Intelligence

**`si_get_offering`** — Get offering details, availability, and optionally matching products before session handoff.

_Request:_
```
{
  offering_id: string  // required
  intent: string
  context: Context
  include_products: boolean
  product_limit: integer
}
```

_Response (success branch):_
```
{
  available: boolean  // required
  offering_token: string
  ttl_seconds: integer
  checked_at: string
  offering: object
  matching_products: object[]
  sponsored_context: Si Sponsored Context
  total_matching: integer
  unavailable_reason: string
  alternative_offering_ids: string[]
  errors: Error[]
  context: Context
}
```

**`si_initiate_session`** — Host initiates SI session with brand agent - includes context, identity, and capability negotiation.

_Request:_
```
{
  intent: string  // required
  identity: Si Identity  // required
  idempotency_key: string  // required
  context: Context
  media_buy_id: string
  placement: string
  offering_id: string
  supported_capabilities: Si Capabilities
  offering_token: string
  sponsored_context_receipt: Si Sponsored Context Receipt
}
```

_Response (success branch):_
```
{
  session_id: string  // required
  session_status: Si Session Status  // required
  response: object
  negotiated_capabilities: Si Capabilities
  sponsored_context: Si Sponsored Context
  session_ttl_seconds: integer
  errors: Error[]
  context: Context
}
```

**`si_send_message`** — Send a message within an active SI session.

_Request:_
```
{
  idempotency_key: string  // required
  session_id: string  // required
  message: string
  action_response: object
  sponsored_context_receipt: Si Sponsored Context Receipt
  context: Context
}
```

_Response (success branch):_
```
{
  session_id: string  // required
  session_status: Si Session Status  // required
  response: object
  mcp_resource_uri: string
  sponsored_context: Si Sponsored Context
  handoff: object
  errors: Error[]
  context: Context
}
```

**`si_terminate_session`** — Terminate an SI session with reason (handoff_transaction, handoff_complete, user_exit, session_timeout, host_terminated).

_Request:_
```
{
  session_id: string  // required
  reason: 'handoff_transaction' | 'handoff_complete' | 'user_exit' | 'session_timeout' | 'host_terminated'  // required
  termination_context: object
  context: Context
}
```

_Response (success branch):_
```
{
  session_id: string  // required
  terminated: boolean  // required
  session_status: Si Session Status
  acp_handoff: object
  follow_up: object
  errors: Error[]
  context: Context
}
```

## Core Data Types

These are the main domain objects returned in tool responses. Defined in `src/lib/types/core.generated.ts`.

| Type | Key Fields |
|------|-----------|
| `Product` | Advertising inventory item — has product_id, name, format_ids, pricing_options, delivery_type, publisher_properties |
| `MediaBuy` | Purchased campaign — has media_buy_id, status, packages, total_budget, start_time, end_time |
| `Package` | Line item within a media buy — has package_id, product_id, budget, pricing_option_id, targeting |
| `CreativeAsset` | Creative with assets — has creative_id, name, type, format_id, status, manifest |
| `Targeting` | Audience criteria — geographic, demographic, behavioral, contextual, device, daypart, signals |
| `PricingOption` | Discriminated union by pricing_model — see variant details below |
| `Format` | Creative format specification — has format_id, name, channel, requirements (typed asset constraints) |
| `Proposal` | Suggested media plan — has proposal_id, status (draft|committed), allocations, delivery_forecast, insertion_order |
| `SignalDefinition` | Data signal — has signal_id, name, description, value_type, targeting constraints, pricing |
| `PropertyList` | Managed allow/block list — has list_id, name, list_type (allow|block), sources, filters |
| `ContentStandards` | Brand safety config — has standards_id, name, scope, policy entries, calibration exemplars |
| `Catalog` | Data feed — typed (offering, product, store, etc.) with items, URL, or inline data |
| `Offering` | Promotable item with asset groups — used in sponsored intelligence and catalog creatives |

## PricingOption Variants

All variants share these common fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pricing_option_id` | string | yes | Unique identifier within a product |
| `pricing_model` | string | yes | Discriminant — determines which variant |
| `currency` | string | yes | ISO 4217 currency code |
| `fixed_price` | number | no | Fixed price (mutually exclusive with floor_price for auction) |
| `floor_price` | number | no | Minimum acceptable bid (auction pricing) |
| `max_bid` | boolean | no | Whether fixed_price is a ceiling vs exact price |
| `price_guidance` | PriceGuidance | no | Percentile guidance (p25, p50, p75, p90) |
| `min_spend_per_package` | number | no | Minimum spend requirement |

Variant-specific fields:

| Variant | pricing_model | Extra Required Fields |
|---------|--------------|----------------------|
| `CPMPricingOption` | `'cpm'` | — (common fields only) |
| `VCPMPricingOption` | `'vcpm'` | — |
| `CPCPricingOption` | `'cpc'` | — |
| `CPCVPricingOption` | `'cpcv'` | — |
| `CPVPricingOption` | `'cpv'` | `parameters: { view_threshold: number \| { duration_seconds: number } }` |
| `CPPPricingOption` | `'cpp'` | — |
| `CPAPricingOption` | `'cpa'` | — |
| `FlatRatePricingOption` | `'flat_rate'` | — |
| `TimeBasedPricingOption` | `'time'` | — |

**CPV note**: The `parameters.view_threshold` is required and defines what counts as a "view". Use a number for percentage-based thresholds or `{ duration_seconds }` for time-based thresholds.

## Well-Known Files

Inferred types and Zod schemas for the AdCP well-known JSON files. Use these when ingesting `.well-known/brand.json` or `.well-known/adagents.json` instead of hand-rolling interfaces (which drift when the spec bumps).

```typescript
import { BrandJsonSchema, type BrandJson, type AdagentsJson } from '@adcp/sdk';

// brand.json is a union: redirect | house-redirect | portfolio
// Narrow with Extract to get just the portfolio shape:
type BrandPortfolio = Extract<BrandJson, { brands: unknown[] }>;
type BrandDefinition = BrandPortfolio['brands'][number];

// Parse at the boundary with the Zod schema:
const brand = BrandJsonSchema.parse(await res.json());
```

Source of truth: `schemas/cache/{version}/brand.json` and `adagents.json` — regenerate with `npm run generate-wellknown-schemas` when the spec bumps.

## Key Enums

| Enum | Values |
|------|--------|
| `buying_mode` | 'brief' | 'wholesale' | 'refine' |
| `delivery_type` | 'guaranteed' | 'non_guaranteed' |
| `pricing_model` | 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time' |
| `media_buy_status` | 'draft' | 'pending_review' | 'active' | 'paused' | 'completed' | 'cancelled' |
| `creative_status` | 'draft' | 'pending_review' | 'approved' | 'rejected' | 'active' | 'archived' |
| `channels (MediaChannel)` | 'display' | 'olv' | 'social' | 'search' | 'ctv' | 'linear_tv' | 'radio' | 'streaming_audio' | 'podcast' | 'dooh' | 'ooh' | 'print' | 'cinema' | 'email' | 'gaming' | 'retail_media' | 'influencer' | 'affiliate' | 'product_placement' | 'sponsored_intelligence' |
| `task_status` | 'completed' | 'working' | 'submitted' | 'input_required' | 'deferred' |
| `pacing` | 'even' | 'asap' | 'front_loaded' |
