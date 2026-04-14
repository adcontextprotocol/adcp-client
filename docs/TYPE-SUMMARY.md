# AdCP Type Summary

> Generated at: 2026-04-14
> @adcp/client v4.29.0

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
  headers?: Record<string, string>;
}

interface TaskResult<T = any> {
  success: boolean;
  status: 'completed' | 'deferred' | 'submitted' | 'input-required'
        | 'working' | 'governance-denied' | 'governance-escalated';
  data?: T;
  error?: string;
  deferred?: DeferredContinuation<T>;
  submitted?: SubmittedContinuation<T>;
  governance?: GovernanceCheckResult;
  metadata: {
    taskId: string;
    taskName: string;
    agent: { id: string; name: string; protocol: string };
    responseTimeMs: number;
    timestamp: string;
    clarificationRounds: number;
  };
  conversation?: Message[];
}

type InputHandler = (context: ConversationContext) => InputHandlerResponse;

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
```

## Tool Request/Response Shapes

Each tool is called as `agent.<methodName>(params)` and returns `TaskResult<ResponseType>`. Below are the key fields for each tool's request. Fields marked with `*` are required.

### Protocol

**`get_adcp_capabilities`** — Request parameters for cross-protocol capability discovery.

```
{
  protocols: string[]
  context: Context
}
```

### Account Management

**`list_accounts`** — Request parameters for listing accounts accessible to the authenticated agent.

```
{
  status: 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed'
  pagination: Pagination Request
  sandbox: boolean
  context: Context
}
```

**`sync_accounts`** — Request parameters for syncing advertiser accounts with a seller.

```
{
  accounts: object[]  // required
  delete_missing: boolean
  dry_run: boolean
  push_notification_config: Push Notification Config
  context: Context
}
```

**`sync_governance`** — Request parameters for registering governance agent endpoints on accounts.

```
{
  accounts: object[]  // required
  context: Context
}
```

**`report_usage`** — Request parameters for reporting vendor service consumption after delivery.

```
{
  reporting_period: Datetime Range  // required
  usage: object[]  // required
  idempotency_key: string
  context: Context
}
```

**`get_account_financials`** — Request parameters for querying financial status of an operator-billed account.

```
{
  account: Account Ref  // required
  period: Date Range
  context: Context
}
```

### Media Buying

**`get_products`** — Request parameters for discovering available advertising products.

```
{
  buying_mode: 'brief' | 'wholesale' | 'refine'  // required
  brief: string
  refine: object[]
  brand: Brand Ref
  catalog: Catalog
  account: Account Ref
  preferred_delivery_types: object[]
  filters: Product Filters
  property_list: Property List Ref
  fields: string[]
  time_budget
  pagination: Pagination Request
  context: Context
  required_policies: string[]
}
```

**`list_creative_formats`** — Request parameters for discovering format IDs and creative agents supported by this sales agent.

```
{
  format_ids: object[]
  asset_types: object[]
  max_width: integer
  max_height: integer
  min_width: integer
  min_height: integer
  is_responsive: boolean
  name_search: string
  wcag_level: Wcag Level
  disclosure_positions: object[]
  disclosure_persistence: object[]
  output_format_ids: object[]
  input_format_ids: object[]
  pagination: Pagination Request
  context: Context
}
```

**`create_media_buy`** — Request parameters for creating a media buy.

```
{
  account: Account Ref  // required
  brand: Brand Ref  // required
  start_time: Start Timing  // required
  end_time: string  // required
  idempotency_key: string
  plan_id: string
  proposal_id: string
  total_budget: object
  packages: object[]
  advertiser_industry: Advertiser Industry
  invoice_recipient: Business Entity
  io_acceptance: object
  po_number: string
  push_notification_config: Push Notification Config
  reporting_webhook: Reporting Webhook
  artifact_webhook: object
  context: Context
}
```

**`update_media_buy`** — Request parameters for updating campaign and package settings.

```
{
  media_buy_id: string  // required
  revision: integer
  paused: boolean
  canceled: 'true'
  cancellation_reason: string
  start_time: Start Timing
  end_time: string
  packages: object[]
  invoice_recipient: Business Entity
  new_packages: object[]
  reporting_webhook: Reporting Webhook
  push_notification_config: Push Notification Config
  idempotency_key: string
  context: Context
}
```

**`get_media_buys`** — Request parameters for retrieving media buy status, creative approvals, and delivery snapshots.

```
{
  account: Account Ref
  media_buy_ids: string[]
  status_filter: Media Buy Status | object[]
  include_snapshot: boolean
  include_history: integer
  pagination: Pagination Request
  context: Context
}
```

**`get_media_buy_delivery`** — Request parameters for retrieving comprehensive delivery metrics.

```
{
  account: Account Ref
  media_buy_ids: string[]
  status_filter: Media Buy Status | object[]
  start_date: string
  end_date: string
  include_package_daily_breakdown: boolean
  attribution_window: object
  reporting_dimensions: object
  context: Context
}
```

**`provide_performance_feedback`** — Request parameters for sharing performance outcomes with publishers.

```
{
  media_buy_id: string  // required
  measurement_period: Datetime Range  // required
  performance_index: number  // required
  idempotency_key: string
  package_id: string
  creative_id: string
  metric_type: Metric Type
  feedback_source: Feedback Source
  context: Context
}
```

**`sync_event_sources`** — Request parameters for configuring event sources on an account.

```
{
  account: Account Ref  // required
  event_sources: object[]
  delete_missing: boolean
  context: Context
}
```

**`log_event`** — Request parameters for logging conversion or marketing events.

```
{
  event_source_id: string  // required
  events: object[]  // required
  test_event_code: string
  idempotency_key: string
  context: Context
}
```

**`sync_audiences`** — Request parameters for managing CRM-based audiences on an account.

```
{
  account: Account Ref  // required
  audiences: object[]
  delete_missing: boolean
  context: Context
}
```

**`sync_catalogs`** — Request parameters for syncing catalog feeds (products, inventory, stores, promotions, offerings) with approval workflow.

```
{
  account: Account Ref  // required
  catalogs: object[]
  catalog_ids: string[]
  delete_missing: boolean
  dry_run: boolean
  validation_mode: Validation Mode
  push_notification_config: Push Notification Config
  context: Context
}
```

### Creative

**`build_creative`** — Request parameters for AI-powered creative generation.

```
{
  message: string
  creative_manifest: Creative Manifest
  creative_id: string
  concept_id: string
  media_buy_id: string
  package_id: string
  target_format_id: Format Id
  target_format_ids: object[]
  account: Account Ref
  brand: Brand Ref
  quality: Creative Quality
  item_limit: integer
  include_preview: boolean
  preview_inputs: object[]
  preview_quality: Creative Quality
  preview_output_format: Preview Output Format
  macro_values: object
  idempotency_key: string
  context: Context
}
```

**`preview_creative`** — Request parameters for generating creative previews.


**`list_creative_formats`** — Request parameters for discovering creative formats from this creative agent.

```
{
  format_ids: object[]
  type: 'audio' | 'video' | 'display' | 'dooh'
  asset_types: string[]
  max_width: integer
  max_height: integer
  min_width: integer
  min_height: integer
  is_responsive: boolean
  name_search: string
  wcag_level: Wcag Level
  disclosure_positions: object[]
  disclosure_persistence: object[]
  output_format_ids: object[]
  input_format_ids: object[]
  include_pricing: boolean
  account: Account Ref
  pagination: Pagination Request
  context: Context
}
```

**`get_creative_delivery`** — Request parameters for retrieving creative delivery data with variant-level breakdowns.

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

**`list_creatives`** — Request parameters for querying creative library with filtering and pagination.

```
{
  filters: Creative Filters
  sort: object
  pagination: Pagination Request
  include_assignments: boolean
  include_snapshot: boolean
  include_items: boolean
  include_variables: boolean
  include_pricing: boolean
  account: Account Ref
  fields: string[]
  context: Context
}
```

**`sync_creatives`** — Request parameters for syncing creative assets with upsert semantics.

```
{
  account: Account Ref  // required
  creatives: object[]  // required
  creative_ids: string[]
  assignments: object[]
  idempotency_key: string
  delete_missing: boolean
  dry_run: boolean
  validation_mode: Validation Mode
  push_notification_config: Push Notification Config
  context: Context
}
```

### Signals

**`get_signals`** — Request parameters for discovering signals based on description.

```
{
  account: Account Ref
  signal_spec: string
  signal_ids: object[]
  destinations: object[]
  countries: string[]
  filters: Signal Filters
  max_results: integer
  pagination: Pagination Request
  context: Context
}
```

**`activate_signal`** — Request parameters for activating a signal on a specific platform/account.

```
{
  signal_agent_segment_id: string  // required
  destinations: object[]  // required
  action: 'activate' | 'deactivate'
  pricing_option_id: string
  account: Account Ref
  idempotency_key: string
  context: Context
}
```

### Governance

**`create_property_list`** — Request parameters for creating a new property list.

```
{
  name: string  // required
  description: string
  base_properties: object[]
  filters: Property List Filters
  brand: Brand Ref
  idempotency_key: string
  context: Context
}
```

**`update_property_list`** — Request parameters for updating an existing property list.

```
{
  list_id: string  // required
  name: string
  description: string
  base_properties: object[]
  filters: Property List Filters
  brand: Brand Ref
  webhook_url: string
  context: Context
  idempotency_key: string
}
```

**`get_property_list`** — Request parameters for retrieving a property list with resolved properties.

```
{
  list_id: string  // required
  resolve: boolean
  pagination: object
  context: Context
}
```

**`list_property_lists`** — Request parameters for listing property lists.

```
{
  principal: string
  name_contains: string
  pagination: Pagination Request
  context: Context
}
```

**`delete_property_list`** — Request parameters for deleting a property list.

```
{
  list_id: string  // required
  context: Context
  idempotency_key: string
}
```

**`list_content_standards`** — Request parameters for listing content standards configurations.

```
{
  channels: object[]
  languages: string[]
  countries: string[]
  pagination: Pagination Request
  context: Context
}
```

**`get_content_standards`** — Request parameters for retrieving a specific standards configuration.

```
{
  standards_id: string  // required
  context: Context
}
```

**`create_content_standards`** — Request parameters for creating a new content standards configuration.

```
{
  scope: object  // required
  policy: string  // required
  registry_policy_ids: string[]
  calibration_exemplars: object
  idempotency_key: string
  context: Context
}
```

**`update_content_standards`** — Request parameters for updating an existing content standards configuration.

```
{
  standards_id: string  // required
  scope: object
  registry_policy_ids: string[]
  policy: string
  calibration_exemplars: object
  context: Context
  idempotency_key: string
}
```

**`calibrate_content`** — Request parameters for collaborative calibration dialogue.

```
{
  standards_id: string  // required
  artifact: Artifact  // required
  idempotency_key: string
}
```

**`validate_content_delivery`** — Request parameters for batch validating delivery records.

```
{
  standards_id: string  // required
  records: object[]  // required
  feature_ids: string[]
  include_passed: boolean
  context: Context
}
```

**`get_media_buy_artifacts`** — Request parameters for retrieving content artifacts from a media buy.

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

**`get_creative_features`** — Request parameters for evaluating creative features from a governance agent.

```
{
  creative_manifest: Creative Manifest  // required
  feature_ids: string[]
  account: Account Ref
  context: Context
}
```

**`sync_plans`** — Push campaign plans to the governance agent.

```
{
  plans: object[]  // required
}
```

**`report_plan_outcome`** — Report the outcome of an action to the governance agent.

```
{
  plan_id: string  // required
  outcome: Outcome Type  // required
  governance_context: string  // required
  check_id: string
  idempotency_key: string
  purchase_type: Purchase Type
  seller_response: object
  delivery: object
  error: object
}
```

**`get_plan_audit_logs`** — Retrieve governance state and audit trail for a plan.

```
{
  plan_ids: string[]
  portfolio_plan_ids: string[]
  governance_contexts: string[]
  purchase_types: object[]
  include_entries: boolean
}
```

**`check_governance`** — Orchestrator or seller calls the governance agent to validate an action against the campaign plan.

```
{
  plan_id: string  // required
  caller: string  // required
  purchase_type: Purchase Type
  tool: string
  payload: object
  governance_context: string
  phase: Governance Phase
  planned_delivery: Planned Delivery
  delivery_metrics: object
  modification_summary: string
  invoice_recipient: Business Entity
}
```

### Sponsored Intelligence

**`si_get_offering`** — Get offering details, availability, and optionally matching products before session handoff.

```
{
  offering_id: string  // required
  context: string
  include_products: boolean
  product_limit: integer
}
```

**`si_initiate_session`** — Host initiates SI session with brand agent - includes context, identity, and capability negotiation.

```
{
  context: string  // required
  identity: Si Identity  // required
  media_buy_id: string
  placement: string
  offering_id: string
  supported_capabilities: Si Capabilities
  offering_token: string
  idempotency_key: string
}
```

**`si_send_message`** — Send a message within an active SI session.

```
{
  session_id: string  // required
  message: string
  action_response: object
}
```

**`si_terminate_session`** — Terminate an SI session with reason (handoff_transaction, handoff_complete, user_exit, session_timeout, host_terminated).

```
{
  session_id: string  // required
  reason: 'handoff_transaction' | 'handoff_complete' | 'user_exit' | 'session_timeout' | 'host_terminated'  // required
  termination_context: object
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
