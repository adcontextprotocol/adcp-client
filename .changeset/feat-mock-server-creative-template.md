---
'@adcp/sdk': minor
---

feat(cli): `adcp mock-server creative-template` — second specialism in the matrix v2 family

Adds a Celtra/Innovid/AudioStack-shaped creative platform mock alongside the existing `signal-marketplace` mock. Different multi-tenant pattern (URL-path workspace scoping vs the signals mock's `X-Operator-Id` header), different gotcha (async render lifecycle: `queued → running → complete` via polling).

Headline characteristics:

- **Workspace-scoped paths**: `/v3/workspaces/{workspace_id}/...`. Two seeded workspaces (`ws_acme_studio` for `acmeoutdoor.example`, `ws_summit_studio` for `summit-media.example`) with overlapping template visibility — Acme has 4 templates including video preroll; Summit has 3 display-only templates.
- **Async render pipeline**: `POST /renders` returns 202 with `status: queued`; subsequent GETs progress through `running` → `complete` (or `failed`). Adapters have to poll, not assume sync. Idempotent on `client_request_id` per workspace, with 409 on body mismatch.
- **Templates as upstream-flavored format catalog**: 4 seeded templates (300x250 medrec, 728x90 leaderboard, 320x50 mobile banner, 15s video preroll). Slot definitions use upstream vocabulary (`slot_id`) rather than AdCP's `asset_role` so the adapter does the projection.
- **Synthetic output**: rendered HTML / JavaScript / VAST XML by `output_kind`. Plausible-looking but not real — the matrix tests adapter projection, not actual creative rendering.

Refactors `MockServerHandle` to expose a unified `principalMapping` + `principalScope` shape so the matrix harness can build prompts for either specialism without specialism-specific seed-data introspection. Both signals (`account.operator` → `X-Operator-Id`) and creative-template (`account.advertiser` → `path /v3/workspaces/...`) flow through the same adapter prompt template.

The matrix harness's `bootUpstreamForHarness` now consumes the unified handle shape; `skill-matrix.json` adds `upstream: "creative-template"` to the build-creative-agent × creative_template pair.

Run with:

```bash
npx @adcp/sdk mock-server creative-template --port 4501
# or as part of the skill-matrix:
npm run compliance:skill-matrix -- --filter creative_template
```

12 new smoke tests in `test/lib/mock-server/creative-template.test.js` cover auth gating, workspace scoping, channel filtering, render lifecycle, idempotency replay, 409 on body mismatch, cross-workspace isolation, malformed JSON / unknown template error paths, VAST output for video templates, and the unified principal-mapping handle shape.

Refs adcontextprotocol/adcp-client#1155.
