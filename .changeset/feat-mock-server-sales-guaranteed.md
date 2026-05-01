---
'@adcp/sdk': minor
---

feat(cli+harness): `adcp mock-server sales-guaranteed` — fourth specialism (GAM-flavored, IO approval state machine + CAPI for delivery validation)

Adds the fourth and final mock-server in the matrix v2 family. Stresses two SDK surfaces the existing mocks don't cover:

1. **Multi-step approval state machine.** Orders progress through `draft → pending_approval → approved → delivering → completed` via an async IO-signing task (`POST /orders` returns `pending_approval` + `approval_task_id`; buyer polls `/tasks/{id}` or `/orders/{id}` until human review completes). The mock auto-promotes `submitted → working → completed` over two polls so adapters exercise the polling pattern without dragging the matrix run. State transitions are monotonic — invalid transitions return `422 invalid_state_transition`.

2. **CAPI for delivery validation, not audience activation.** Distinct from sales-social's CAPI which ingests conversion events for targeting. Here CAPI ingests delivery measurements (impressions, clicks, viewable %, video completions, conversions) that the publisher uses to validate billing. Different flow, different semantics. Conversions are deduped by `dedup_key` per order.

Plus: **inventory-list targeting** (publisher-defined ad units the buyer can target by id), **delivery reporting** (synthesized totals from order state), **line-item lifecycle** (pending_creatives → ready → delivering on creative attach + order approval).

Multi-tenancy via header (`X-Network-Code`) — matches GAM's network-id pattern. Distinct from sales-social's path-based scoping.

The fixture covers most of what the `sales_guaranteed` storyboard exercises: products, orders, line items, creatives, delivery reporting, conversions, async approval tasks. Out-of-scope (handled adapter-side, not in upstream): measurement_terms_rejected, inventory_list_no_match (those are AdCP error-shape tests, not upstream API tests).

Run with:

```bash
npx @adcp/sdk mock-server sales-guaranteed --port 4503
# or as part of the skill-matrix:
npm run compliance:skill-matrix -- --filter sales_guaranteed
```

**12 new smoke tests** in `test/lib/mock-server/sales-guaranteed.test.js` cover Bearer + X-Network-Code gating, inventory + product listing with filtering, full order approval flow (create → poll task → state transitions), line item creation, idempotency conflict on body mismatch, delivery report synthesis, CAPI conversion ingestion + dedup_key dedup.

After this lands, matrix v2 has full coverage of the major upstream-shape patterns:

| Pattern                                | Tested by                                                  |
| -------------------------------------- | ---------------------------------------------------------- |
| API key Bearer                         | signals, creative-template, sales-guaranteed               |
| OAuth 2.0 client_credentials + refresh | sales-social                                               |
| Multi-tenant via header                | signals (X-Operator-Id), sales-guaranteed (X-Network-Code) |
| Multi-tenant via path                  | creative-template, sales-social                            |
| Sync API                               | signals                                                    |
| Async polling lifecycle                | creative-template (renders), sales-guaranteed (orders)     |
| Hashed-PII upload (sync_audiences)     | sales-social                                               |
| CAPI for audience activation           | sales-social                                               |
| CAPI for delivery validation           | sales-guaranteed                                           |
| Catalog sync (sync_catalogs)           | sales-social                                               |
| Multi-step approval state machine      | sales-guaranteed                                           |
| Inventory-list targeting               | sales-guaranteed                                           |

Refs adcontextprotocol/adcp-client#1155.
