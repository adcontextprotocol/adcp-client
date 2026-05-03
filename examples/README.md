# AdCP Client Examples

This directory contains practical examples of how to use the `@adcp/sdk` library.

## Building an AdCP agent — fork-target reference adapters

Pick the example whose AdCP role and specialism most closely match what you're building, fork the file, replace the `// SWAP:` markers, and follow the `FORK CHECKLIST` block at the top of each adapter for the unmarked but load-bearing constants. Each adapter is paired with a three-gate CI test (strict tsc / storyboard / upstream-traffic) so a regression in your fork fails CI before it ships.

| If you're claiming…                | Fork                                              | Then…                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal-marketplace` / `signal-owned` | `hello_signals_adapter_marketplace.ts`         | as-is for marketplace; `signal-owned` adopters drop the marketplace-specific tax/rev-share fields                                              |
| `creative-template`                | `hello_creative_adapter_template.ts`              | as-is — single-tenant; production adopters add per-tenant workspace binding (see SWAP markers)                                                 |
| `creative-generative`              | `hello_creative_adapter_template.ts`              | replace template-driven `buildCreative` with brief-driven generation; keep the `previewCreative` shape                                         |
| `creative-ad-server`               | `hello_creative_adapter_template.ts`              | promote to `CreativeAdServerPlatform`, add `syncCreatives` library + `listCreatives` query + tag-rendering on `buildCreative`                  |
| `sales-non-guaranteed`             | `hello_seller_adapter_social.ts`                  | drop OAuth (use static Bearer or your auth), add `getProducts` + `createMediaBuy` + `updateMediaBuy` + `getMediaBuyDelivery` + `getMediaBuys`  |
| `sales-guaranteed`                 | `hello_seller_adapter_guaranteed.ts`              | as-is — covers the HITL flow                                                                                                                   |
| `sales-broadcast-tv`               | `hello_seller_adapter_guaranteed.ts`              | replace `audience_targeting` with broadcast-DMA targeting; replace `Product.channels` with `linear_tv`                                         |
| `sales-streaming-tv`               | `hello_seller_adapter_guaranteed.ts`              | adjust `Product.channels` to `ctv`                                                                                                             |
| `sales-social`                     | `hello_seller_adapter_social.ts`                  | as-is                                                                                                                                          |
| `sales-catalog-driven`             | `hello_seller_adapter_social.ts`                  | promote `syncCatalogs` to a real catalog ingestion + `getProducts` reads from the catalog                                                      |
| `audience-sync`                    | `hello_seller_adapter_social.ts`                  | strip everything except `syncAudiences` + `pollAudienceStatuses`; this is the standalone audience-sync seller pattern                          |
| `governance-spend-authority` / `property-lists` / `brand-rights` | `hello_seller_adapter_multi_tenant.ts` | as-is — multi-specialism + multi-tenant agency / holdco shape; closes adcp-client#1332 (governance) and adcp-client#1334 (brand-rights). Single-specialism adopters fork the relevant handler block out of the same file. |

Naming convention: `hello_<role>_adapter_<specialism>.ts` where `<role>` is the AdCP protocol layer (`seller` for `media-buy`, `creative` for `creative`, `signals` for `signals`, `governance` for `governance`, `brand` for `brand`). `<specialism>` strips the role-implied prefix (so `creative-template` → `_template`, `sales-guaranteed` → `_guaranteed`). The multi-tenant holdco adapter sits outside this convention because it spans multiple roles (governance + brand-rights + property-lists) — naming follows the deployment shape rather than a single role.

## Examples

### Basic Usage

- **`basic-mcp.ts`** - Simple MCP protocol client usage
- **`basic-a2a.ts`** - Simple A2A protocol client usage with multi-agent testing
- **`env-config.ts`** - Loading agent configuration from environment variables
- **`conversation-client.ts`** - Conversation-aware client with input handlers

### Multi-specialism + multi-tenant (account-routed)

`hello_seller_adapter_multi_tenant.ts` demonstrates the **account-routed** multi-tenant model: one server hosts `governance-spend-authority`, `property-lists`, and `brand-rights` for two distinct tenants whose data never crosses. The agency / holdco hub shape. Two resolution paths:

- Tools that carry `account` (governance, property-lists, sync_accounts, sync_governance) → `accounts.resolve(ref)` reads `ref.operator` and routes to the matching tenant. Same buyer credential can hit different tenants by varying `account.operator`.
- Tools without `account` (`get_brand_identity`, `get_rights`) → `accounts.resolve(undefined, ctx)` reads the resolved buyer agent's home tenant from `ctx.agent`. Different credentials → different views of the catalog without any account field on the wire.

Cross-specialism dispatch: `brandRights.acquireRights` consults `campaignGovernance.checkGovernance` directly (in-process, no HTTP roundtrip) when the buyer has registered a governance binding via `sync_governance`. Returns the spec-correct `AcquireRightsRejected` arm with `reason` + `suggestions` on denial.

This is distinct from `decisioning-platform-multi-tenant.ts` which uses **host-routed** tenancy via `TenantRegistry` (different agentUrls per tenant). Both are valid; pick by deployment shape.

### Agent testing (`comply_test_controller`)

Start with `createComplyController` (`comply-controller-seller.ts`). Switch to `registerTestController` (`seller-test-controller.ts`) only when your domain state has internal structure that multiple production tools read from — i.e., when the adapter surface's one-method-per-scenario shape starts fighting the code you already have.

- **`comply-controller-seller.ts`** — `createComplyController` adapter surface. Each scenario maps cleanly to one repository method (`seed_creative` → `creativeRepo.upsert`). The default choice.
- **`seller-test-controller.ts`** — `registerTestController` with a hand-rolled `TestControllerStore`. Pick this when your media buy / creative records carry internal structure (packages, revision, history) that seed must populate AND production tools (`get_media_buy`, `sync_creatives`) must read. Flat store surface, session-scoped factory.

Both wire `comply_test_controller`, both auto-emit the `capabilities.compliance_testing.scenarios` block, both sit on the same primitives. Pick by state shape, not by perceived helper tier.

Run `npm run typecheck:examples` to validate both examples against the built `dist/`.

### Running Examples

```bash
# Install dependencies
npm install

# Set up environment variables
export A2A_AUTH_TOKEN=your-token
export MCP_AUTH_TOKEN=your-token

# Run TypeScript examples directly
npx tsx examples/basic-mcp.ts
npx tsx examples/basic-a2a.ts
npx tsx examples/env-config.ts
npx tsx examples/conversation-client.ts
```

## Environment Configuration

The library supports loading agent configurations from environment variables. Set `ADCP_AGENTS_CONFIG` (or `SALES_AGENTS_CONFIG`):

```bash
ADCP_AGENTS_CONFIG='[{"id":"test-agent","name":"Test Agent","agent_uri":"https://test-agent.example.com","protocol":"mcp","auth_token":"your-token"}]'
```

## Library Usage Patterns

### 1. Multi-Agent Client

```typescript
import { ADCPMultiAgentClient, type AgentConfig } from '@adcp/sdk';

const agents: AgentConfig[] = [
  /* your agents */
];
const client = new ADCPMultiAgentClient(agents);

// Single agent operation
const agent = client.agent('agent-id');
const result = await agent.getProducts({ brief: '...' });

// Multi-agent parallel operation
const results = await client.agents(['id1', 'id2']).getProducts({ brief: '...' });
```

### 2. Environment-based Configuration

```typescript
import { ADCPMultiAgentClient } from '@adcp/sdk';

// Auto-discover from env vars and config files
const client = ADCPMultiAgentClient.fromConfig();

// Or from environment only
const client = ADCPMultiAgentClient.fromEnv();
```

## Available Tools

AdCP tools available on `AgentClient`:

- `getProducts()` - Discover advertising products
- `listCreativeFormats()` - Get supported creative formats
- `createMediaBuy()` - Create a media buy
- `updateMediaBuy()` - Update a media buy
- `syncCreatives()` - Sync creative assets
- `listCreatives()` - List creative assets
- `getMediaBuyDelivery()` - Get delivery performance
- `getSignals()` - Get audience signals
- `activateSignal()` - Activate audience signals
- `providePerformanceFeedback()` - Send performance feedback
- `getAdcpCapabilities()` - Get agent capabilities (v3)

## Error Handling

```typescript
const result = await agent.getProducts({ brief: 'test' });

if (result.success && result.status === 'completed') {
  console.log('Data:', result.data);
} else {
  console.log('Error:', result.error);
}
```

## Testing Framework

This package also includes a complete testing framework. To run the testing UI:

```bash
npm run dev
# Open http://localhost:8080
```

See the main README for full testing framework documentation.
