---
'@adcp/sdk': minor
---

Add `creative-ad-server` upstream-shape mock-server. Closes #1459 (sub-issue of #1381 hello-adapter-family completion).

Pattern: GAM-creative / Innovid / Flashtalking / CM360 model — stateful creative library, format auto-detection, tag generation with macro substitution, real `/serve/{id}` HTML preview, synth delivery reporting with format-specific CTR baselines.

Routes:

- `GET /_lookup/network` — operator-from-domain routing (auth-free).
- `GET /_debug/traffic` — façade-detection counters (auth-free).
- `GET /v1/formats` — per-network format catalog.
- `POST /v1/creatives` — write to library; format auto-detected from `upload_mime` + dimensions when `format_id` omitted; `client_request_id` idempotency with conflict-on-body-mismatch.
- `GET /v1/creatives` — list with filters (`advertiser_id`, `format_id`, `status`, `created_after`, `creative_ids`); cursor pagination.
- `GET /v1/creatives/{id}` — single fetch.
- `PATCH /v1/creatives/{id}` — update snippet/status/click_url/name.
- `POST /v1/creatives/{id}/render` — tag generation; substitutes `{click_url}`, `{impression_pixel}`, `{cb}`, `{advertiser_id}`, `{creative_id}`, `{asset_url}`, `{width}`, `{height}`, `{duration_seconds}` macros into the stored or format-template snippet; returns `tag_html` + `tag_url`.
- `GET /serve/{id}?ctx=<json>` — real iframe-embeddable HTML response (no bearer auth — capability-by-id, mirrors how real ad servers expose serve URLs to publisher iframes).
- `GET /v1/creatives/{id}/delivery?start=&end=` — synth impressions/clicks scaled by days-active; deterministic-seeded `(creative_id, date)`; CTR baselines per channel (display ~0.10%, video ~1.5%, ctv ~3%, audio ~0.5%).

Auth: static Bearer + `X-Network-Code` header on every `/v1` route. Multi-tenancy by network header (mirrors `sales-guaranteed`). Three networks seeded (US, ACME outdoor, Pinnacle agency) with replicated 6-format catalog and 3 seed library entries.

Wired into `src/lib/mock-server/index.ts` dispatcher with `formatCreativeAdServerSummary` for boot-log printing. Worked adapter (sub-issue #1460) lands in a follow-up PR.
