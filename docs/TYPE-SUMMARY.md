# AdCP Type Summary

> Generated at: 2026-04-21
> @adcp/client v5.8.0

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
        | 'working' | 'governance-denied';
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

_Request:_
```
{
  protocols: string[]
  context: Context
}
```

_Response (success branch):_
```
{
  adcp: object  // required
  supported_protocols: string[]  // required
  account: object
  media_buy: object
  signals: object
  governance: object
  sponsored_intelligence: object
  brand: object
  creative: object
  request_signing: object
  webhook_signing: object
  identity: object
  compliance_testing: object
  specialisms: object[]
  extensions_supported: string[]
  experimental_features: string[]
  last_updated: string
  errors: object[]
  context: Context
}
```

### Account Management

**`list_accounts`** — Request parameters for listing accounts accessible to the authenticated agent.

_Request:_
```
{
  status: 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed'
  pagination: Pagination Request
  sandbox: boolean
  context: Context
}
```

_Response (success branch):_
```
{
  accounts: object[]  // required
  errors: object[]
  pagination: Pagination Response
  context: Context
}
```

**`sync_accounts`** — Request parameters for syncing advertiser accounts with a seller.

_Request:_
```
{
  idempotency_key: string  // required
  accounts: object[]  // required
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
  errors: object[]
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
  payment_terms: 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'net_90' | 'prepay'
  invoices: object[]
  context: Context
}
```

### Media Buying

**`get_products`** — Request parameters for discovering available advertising products.

_Request:_
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

_Response (success branch):_
```
{
  products: object[]  // required
  proposals: object[]
  errors: object[]
  property_list_applied: boolean
  catalog_applied: boolean
  refinement_applied: object[]
  incomplete: object[]
  pagination: Pagination Response
  sandbox: boolean
  context: Context
}
```

**`list_creative_formats`** — Request parameters for discovering format IDs and creative agents supported by this sales agent.

_Request:_
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

_Response (success branch):_
```
{
  formats: object[]  // required
  creative_agents: object[]
  errors: object[]
  pagination: Pagination Response
  sandbox: boolean
  context: Context
}
```

**`create_media_buy`** — Request parameters for creating a media buy.

_Request:_
```
{
  idempotency_key: string  // required
  account: Account Ref  // required
  brand: Brand Ref  // required
  start_time: Start Timing  // required
  end_time: string  // required
  plan_id: string
  proposal_id: string
  total_budget: object
  packages: object[]
  advertiser_industry: Advertiser Industry
  invoice_recipient: Business Entity
  io_acceptance: object
  po_number: string
  agency_estimate_number: string
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
  packages: object[]  // required
  account: Account
  invoice_recipient: Business Entity
  status: Media Buy Status
  confirmed_at: string
  creative_deadline: string
  revision: integer
  valid_actions: string[]
  planned_delivery: Planned Delivery
  sandbox: boolean
  context: Context
}
```

**`update_media_buy`** — Request parameters for updating campaign and package settings.

_Request:_
```
{
  account: Account Ref  // required
  media_buy_id: string  // required
  idempotency_key: string  // required
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
  context: Context
}
```

_Response (success branch):_
```
{
  media_buy_id: string  // required
  status: Media Buy Status
  revision: integer
  implementation_date: string,null
  invoice_recipient: Business Entity
  affected_packages: object[]
  valid_actions: string[]
  sandbox: boolean
  context: Context
}
```

**`get_media_buys`** — Request parameters for retrieving media buy status, creative approvals, and delivery snapshots.

_Request:_
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

_Response (success branch):_
```
{
  media_buys: object[]  // required
  errors: object[]
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
  status_filter: Media Buy Status | object[]
  start_date: string
  end_date: string
  include_package_daily_breakdown: boolean
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
  errors: object[]
  sandbox: boolean
  context: Context
}
```

**`provide_performance_feedback`** — Request parameters for sharing performance outcomes with publishers.

_Request:_
```
{
  media_buy_id: string  // required
  idempotency_key: string  // required
  measurement_period: Datetime Range  // required
  performance_index: number  // required
  package_id: string
  creative_id: string
  metric_type: Metric Type
  feedback_source: Feedback Source
  context: Context
}
```

_Response (success branch):_
```
{
  success: 'true'  // required
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
  events: object[]  // required
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
  catalogs: object[]
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
  dry_run: boolean
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
  context: Context
}
```

_Response (success branch):_
```
{
  creative_manifest: Creative Manifest  // required
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

**`preview_creative`** — Request parameters for generating creative previews.

_Request:_
```
{
  request_type: 'single' | 'batch' | 'variant'  // required
  creative_manifest: Creative Manifest
  format_id: Format Id
  inputs: object[]
  template_id: string
  quality: Creative Quality
  output_format: Preview Output Format
  item_limit: integer
  requests: object[]
  variant_id: string
  creative_id: string
  context: Context
}
```

_Response (success branch):_
```
{
  response_type: 'single'  // required
  previews: object[]  // required
  expires_at: string  // required
  interactive_url: string
  context: Context
}
```

**`list_creative_formats`** — Request parameters for discovering creative formats from this creative agent.

_Request:_
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

_Response (success branch):_
```
{
  formats: object[]  // required
  creative_agents: object[]
  errors: object[]
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
  errors: object[]
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
  include_snapshot: boolean
  include_items: boolean
  include_variables: boolean
  include_pricing: boolean
  account: Account Ref
  fields: string[]
  context: Context
}
```

_Response (success branch):_
```
{
  query_summary: object  // required
  pagination: Pagination Response  // required
  creatives: object[]  // required
  format_summary: object
  status_summary: object
  errors: object[]
  sandbox: boolean
  context: Context
}
```

**`sync_creatives`** — Request parameters for syncing creative assets with upsert semantics.

_Request:_
```
{
  account: Account Ref  // required
  creatives: object[]  // required
  idempotency_key: string  // required
  creative_ids: string[]
  assignments: object[]
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

### Signals

**`get_signals`** — Request parameters for discovering signals based on description.

_Request:_
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

_Response (success branch):_
```
{
  signals: object[]  // required
  errors: object[]
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
  destinations: object[]  // required
  idempotency_key: string  // required
  action: 'activate' | 'deactivate'
  pricing_option_id: string
  account: Account Ref
  context: Context
}
```

_Response (success branch):_
```
{
  deployments: object[]  // required
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
  base_properties: object[]
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
  base_properties: object[]
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
  identifiers: object[]
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
  lists: object[]  // required
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
  base_collections: object[]
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
  base_collections: object[]
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
  lists: object[]  // required
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
  context: Context
}
```

**`list_content_standards`** — Request parameters for listing content standards configurations.

_Request:_
```
{
  channels: object[]
  languages: string[]
  countries: string[]
  pagination: Pagination Request
  context: Context
}
```

_Response (success branch):_
```
{
  standards: object[]  // required
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
  policies: object[]
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
  policies: object[]
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
  verdict: 'pass' | 'fail'  // required
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
  results: object[]  // required
  detail_url: string
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
  governance_context: string  // required
  check_id: string
  purchase_type: Purchase Type
  seller_response: object
  delivery: object
  error: object
  context: Context
}
```

_Response (success branch):_
```
{
  outcome_id: string  // required
  status: 'accepted' | 'findings'  // required
  committed_budget: number
  findings: object[]
  plan_summary: object
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
  purchase_types: object[]
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
  context: Context
}
```

_Response (success branch):_
```
{
  check_id: string  // required
  status: 'approved' | 'denied' | 'conditions'  // required
  plan_id: string  // required
  explanation: string  // required
  findings: object[]
  conditions: object[]
  expires_at: string
  next_check: string
  categories_evaluated: string[]
  policies_evaluated: string[]
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
  context: string
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
  total_matching: integer
  unavailable_reason: string
  alternative_offering_ids: string[]
  errors: object[]
  context: Context
}
```

**`si_initiate_session`** — Host initiates SI session with brand agent - includes context, identity, and capability negotiation.

_Request:_
```
{
  context: string  // required
  identity: Si Identity  // required
  idempotency_key: string  // required
  media_buy_id: string
  placement: string
  offering_id: string
  supported_capabilities: Si Capabilities
  offering_token: string
}
```

_Response (success branch):_
```
{
  session_id: string  // required
  session_status: Si Session Status  // required
  response: object
  negotiated_capabilities: Si Capabilities
  session_ttl_seconds: integer
  errors: object[]
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
  handoff: object
  errors: object[]
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
  errors: object[]
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
