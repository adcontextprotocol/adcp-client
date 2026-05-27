# AdCP Client Examples

This directory contains practical examples of how to use the `@adcp/sdk` library.

## Building an AdCP agent — fork-target reference adapters

Pick the example whose AdCP role and specialism most closely matches what you're building, fork it, replace the `// SWAP:` markers, and follow the `FORK CHECKLIST` block for the unmarked but load-bearing constants. The `hello_*_adapter_*` examples are paired with the three-gate CI test (strict tsc / storyboard / upstream-traffic) where a matching mock server exists; examples without one are called out below with the narrower runtime coverage they currently have. `proxy-seller-snap/` is a lighter bridge-pattern fork target: it proves seed-bridge wiring and must be paired with your live-OAuth sandbox runner for upstream health.

| If you're claiming…                                              | Fork                                     | Then…                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal-marketplace` / `signal-owned`                            | `hello_signals_adapter_marketplace.ts`   | as-is for marketplace; `signal-owned` adopters drop the marketplace-specific tax/rev-share fields                                                                                                                         |
| `creative-template`                                              | `hello_creative_adapter_template.ts`     | as-is — single-tenant; production adopters add per-tenant workspace binding (see SWAP markers)                                                                                                                            |
| `creative-generative`                                            | `hello_creative_adapter_template.ts`     | replace template-driven `buildCreative` with brief-driven generation; keep the `previewCreative` shape                                                                                                                    |
| `creative-ad-server`                                             | `hello_creative_adapter_ad_server.ts`    | as-is — covers the stateful library + tag generation + macro substitution + delivery reporting flow                                                                                                                       |
| `sales-non-guaranteed`                                           | `hello_seller_adapter_non_guaranteed.ts` | as-is — covers sync confirmation, floor pricing, spend-only forecast, pacing propagation                                                                                                                                  |
| `sales-guaranteed`                                               | `hello_seller_adapter_guaranteed.ts`     | as-is — covers the HITL flow                                                                                                                                                                                              |
| `sales-broadcast-tv`                                             | `hello_seller_adapter_guaranteed.ts`     | replace `audience_targeting` with broadcast-DMA targeting; replace `Product.channels` with `linear_tv`                                                                                                                    |
| `sales-streaming-tv`                                             | `hello_seller_adapter_guaranteed.ts`     | adjust `Product.channels` to `ctv`                                                                                                                                                                                        |
| `sales-social`                                                   | `hello_seller_adapter_social.ts`         | as-is                                                                                                                                                                                                                     |
| Proxy-shaped seller / DSP / walled garden                        | `proxy-seller-snap/`                     | start here when reads proxy an upstream platform API and storyboard seeds need `TestControllerBridge` to appear in sandbox reads                                                                                          |
| `sales-catalog-driven`                                           | `hello_seller_adapter_social.ts`         | promote `syncCatalogs` to a real catalog ingestion + `getProducts` reads from the catalog                                                                                                                                 |
| `audience-sync`                                                  | `hello_seller_adapter_social.ts`         | strip everything except `syncAudiences` + `pollAudienceStatuses`; this is the standalone audience-sync seller pattern                                                                                                     |
| `governance-spend-authority` / `property-lists` / `brand-rights` | `hello_seller_adapter_multi_tenant.ts`   | as-is — multi-specialism + multi-tenant agency / holdco shape; closes adcp-client#1332 (governance) and adcp-client#1334 (brand-rights). Single-specialism adopters fork the relevant handler block out of the same file. |

Naming convention: `hello_<role>_adapter_<specialism>.ts` where `<role>` is the AdCP protocol layer (`seller` for `media-buy`, `creative` for `creative`, `signals` for `signals`, `governance` for `governance`, `brand` for `brand`). `<specialism>` strips the role-implied prefix (so `creative-template` → `_template`, `sales-guaranteed` → `_guaranteed`). The multi-tenant holdco adapter sits outside this convention because it spans multiple roles (governance + brand-rights + property-lists) — naming follows the deployment shape rather than a single role.

## Common multi-specialism bundles

Real platforms typically claim more than one specialism. Claim a specialism only if (a) you implement its required tools **and** (b) you are prepared to receive and service requests for that flow in production. Stub-throw or empty-array implementations are a smell — drop the claim instead.

| Adopter shape                                              | Canonical specialism bundle                                                                  | Skills                                                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retail-media network (Amazon Ads, Walmart Connect, Citrus) | `sales-catalog-driven` + `audience-sync` + `creative-template`                               | [retail-media](../skills/build-retail-media-agent/SKILL.md), [seller](../skills/build-seller-agent/SKILL.md), [creative](../skills/build-creative-agent/SKILL.md) |
| Hybrid creative platform (Celtra, Bannerflow)              | `creative-template` + `creative-generative`                                                  | [creative](../skills/build-creative-agent/SKILL.md), [generative-seller](../skills/build-generative-seller-agent/SKILL.md)                                        |
| Walled-garden social network (Meta, Snap, TikTok)          | `sales-social` + `audience-sync`                                                             | [seller](../skills/build-seller-agent/SKILL.md)                                                                                                                   |
| Premium broadcaster (Paramount, Disney)                    | `sales-broadcast-tv` + `sales-streaming-tv` _(preview)_                                      | [seller](../skills/build-seller-agent/SKILL.md)                                                                                                                   |
| DSP-side seller (Scope3, Trade Desk)                       | `sales-non-guaranteed` + `signal-marketplace`                                                | [seller](../skills/build-seller-agent/SKILL.md), [signals](../skills/build-signals-agent/SKILL.md)                                                                |
| Identity provider (LiveRamp, ID5)                          | `signal-owned` + `audience-sync`                                                             | [signals](../skills/build-signals-agent/SKILL.md), [seller](../skills/build-seller-agent/SKILL.md)                                                                |
| Governance vendor (IAS, DV)                                | `governance-delivery-monitor` + `measurement-verification` _(preview)_ + `content-standards` | [governance](../skills/build-governance-agent/SKILL.md)                                                                                                           |

> Each specialism runs its own compliance storyboard independently — no joint multi-specialism storyboard exists yet. For cross-protocol bundles (e.g. DSP-side seller spans `media-buy` + `signals`), run each protocol's storyboard separately.

## AdCP 3.1 commercial-state model

Keep three axes separate when forking a Hello agent:

- `capabilities.account.supported_billing` is the seller-wide wire capability. Set `capabilities.supportedBillings` on decisioning-platform examples when the seller accepts `operator`, `agent`, or `advertiser` billing at all.
- `BuyerAgentRegistry` is the per-caller commercial relationship. `hello_signals_adapter_marketplace.ts`, `hello_seller_adapter_social.ts`, and `hello_seller_adapter_multi_tenant.ts` show the durable buyer-agent identity seam; `ctx.agent` is the trusted record for status, sandbox-only reach, tenant routing, and billing gates.
- `fixtures.buyer_agents[]` plus `seed_buyer_agent` is the compliance setup path. The signals Hello agent wires a test-only overlay so a 3.1 storyboard can vary Addie's `status`, `sandbox_only`, or `billing_capabilities` without inventing a special bearer-token prefix. Production agents should back this with their onboarding ledger and invalidate the registry cache after mutation.

The framework resolves and status-gates buyer agents. Until automatic `sync_accounts.billing` enforcement moves into the framework, media-buy adapters that accept account sync should enforce billing from the same `ctx.agent` record they use for onboarding. The social Hello agent includes this representative gate because it has a buyer-agent ledger; do not fork a separate bearer-token prefix or unscoped test-only shortcut.

## Examples

### Basic Usage

- **`basic-mcp.ts`** - Simple MCP protocol client usage
- **`basic-a2a.ts`** - Simple A2A protocol client usage with multi-agent testing
- **`env-config.ts`** - Loading agent configuration from environment variables
- **`conversation-client.ts`** - Conversation-aware client with input handlers

### Multi-specialism + multi-tenant (account-routed)

`hello_seller_adapter_multi_tenant.ts` demonstrates the **account-routed** multi-tenant model: one server hosts `governance-spend-authority`, `property-lists`, and `brand-rights` for two distinct tenants whose data never crosses. The agency / holdco hub shape. It has strict typecheck coverage plus a direct MCP runtime test for buyer-agent-derived no-account tenant routing; full storyboard/façade gates will land once governance / brand-rights mock servers exist. Two resolution paths:

- Tools that carry `account` (governance, property-lists, sync_accounts, sync_governance) → `accounts.resolve(ref)` reads `ref.operator` and routes to the matching tenant. Same buyer credential can hit different tenants by varying `account.operator`.
- Tools without `account` (`get_brand_identity`, `get_rights`) → `accounts.resolve(undefined, ctx)` reads the resolved buyer agent's home tenant from `ctx.agent`. Different credentials → different views of the catalog without any account field on the wire.

Cross-specialism dispatch: `brandRights.acquireRights` consults `campaignGovernance.checkGovernance` directly (in-process, no HTTP roundtrip) when the buyer has registered a governance binding via `sync_governance`. Returns the spec-correct `AcquireRightsRejected` arm with `reason` + `suggestions` on denial.

This is distinct from `decisioning-platform-multi-tenant.ts` which uses **host-routed** tenancy via `TenantRegistry` (different agentUrls per tenant). Both are valid; pick by deployment shape.

### Agent testing (`comply_test_controller`)

Start with `createComplyController` (`comply-controller-seller.ts`). Switch to `registerTestController` (`seller-test-controller.ts`) only when your domain state has internal structure that multiple production tools read from — i.e., when the adapter surface's one-method-per-scenario shape starts fighting the code you already have.

- **`comply-controller-seller.ts`** — `createComplyController` adapter surface. Each scenario maps cleanly to one repository method (`seed_creative` → `creativeRepo.upsert`). The default choice.
- **`seller-test-controller.ts`** — `registerTestController` with a hand-rolled `TestControllerStore`. Pick this when your media buy / creative records carry internal structure (packages, revision, history) that seed must populate AND production tools (`get_media_buy`, `sync_creatives`) must read. Flat store surface, session-scoped factory.

Both wire `comply_test_controller`, both auto-emit the `capabilities.compliance_testing.scenarios` block, both sit on the same primitives. Pick by state shape, not by perceived helper tier.

For proxy-shaped sellers where reads go to an upstream platform API, start with **`proxy-seller-snap/`**. It shows the seed bridge pattern: `comply_test_controller` writes storyboard fixtures into a session store, production read handlers call the Snap-shaped client, and `bridgeFromSessionStore` merges seeded products, creatives, and governance lists into sandbox responses after the handler succeeds.

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
