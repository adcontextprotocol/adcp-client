---
'@adcp/sdk': minor
---

feat(cli): `adcp mock-server <specialism>` boots a fake upstream platform fixture for skill-matrix testing

Adds `npx @adcp/sdk mock-server signal-marketplace` (currently the only specialism), which boots a CDP/DMP-shaped HTTP server modeled on LiveRamp / Lotame / Oracle Data Cloud. The mock represents the *upstream platform an adopter wraps*, not an AdCP-shaped agent — it has its own native API (cohorts/destinations/activations rather than signals/deployments) so skill-matrix runs test whether Claude can map an unfamiliar upstream to AdCP using the SDK + skill, not whether Claude can invent a decisioning platform from scratch.

Headline characteristics of the `signal-marketplace` mock:

- **Multi-operator API key pattern** — single `Authorization: Bearer <api_key>` shared across operator seats; per-request `X-Operator-Id` header determines cohort visibility, pricing, and activation scope. Real signal marketplaces all work this way; the mock surfaces the question "where does the SDK want me to put the principal-to-operator mapping?" as a real adopter would surface it.
- **Two seeded operators** with overlapping cohort visibility — `op_pinnacle` (4 cohorts, all data providers) vs `op_summit` (2 Trident cohorts, +$1 CPM premium rate card). Forces the adapter to genuinely thread the operator from the AdCP `account.operator` field through to the upstream API or fail with empty/wrong data.
- **Activation lifecycle state machine** — DSP/CTV destinations start `pending`, advance through `in_progress` → `active` on poll; agent destinations are synchronously `active` on create. Idempotent on `client_request_id` per operator (different operators using the same key are independent).
- **Cross-operator isolation** — fetching another operator's activation returns 403 instead of 404 to prevent existence-oracle probing.

The matrix harness (`scripts/manual-testing/agent-skill-storyboard.ts`, `run-skill-matrix.ts`) now accepts an optional `upstream` field per pair in `skill-matrix.json`. When set, it boots the mock-server before handing the workspace to Claude and surfaces the OpenAPI spec path + operator mapping table to Claude in the build prompt.

Run with:

```bash
npx @adcp/sdk mock-server signal-marketplace --port 4500
# or as part of the skill-matrix:
npm run compliance:skill-matrix -- --filter signal-marketplace
```

Files added:
- `src/lib/mock-server/index.ts` — specialism dispatcher
- `src/lib/mock-server/signal-marketplace/openapi.yaml` — upstream API spec
- `src/lib/mock-server/signal-marketplace/seed-data.ts` — operators, cohorts, destinations
- `src/lib/mock-server/signal-marketplace/server.ts` — HTTP handlers
- `test/lib/mock-server/signal-marketplace.test.js` — 8 smoke tests covering auth, operator scoping, pricing overrides, activation lifecycle, cross-operator isolation
- `bin/adcp.js` — `mock-server` subcommand routing

Background and design rationale: adcontextprotocol/adcp-client#1155.
