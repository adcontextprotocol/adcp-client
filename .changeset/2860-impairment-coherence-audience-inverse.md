---
'@adcp/sdk': minor
---

feat(testing): impairment.coherence grades audience inverse rule + walks `creative_approvals[]` on buy snapshots

Closes two gaps in the storyboard runner's `impairment.coherence` invariant exposed by the dependency-impairment storyboard (adcp#2860 / adcp#4677):

**1. Audience leg of the inverse rule is now graded.**

The buy-side reference for audiences lives at `packages[*].targeting_overlay.audience_include[]` — a stable, spec-defined field that lets the runner traverse buy → audience the same way it traverses buy → creative. The earlier deferral lived in `INVERSE_DEFERRED_FAMILIES` and emitted a `not_applicable` hint on every audience offline transition.

- `readBuySnapshot` extracts `referencedAudienceIds` from `packages[*].targeting_overlay.audience_include[]`. `audience_exclude` is intentionally omitted on **serviceability** grounds — suspending an exclude-audience doesn't prevent the buy from serving, so it isn't a "buy can't function" signal that the inverse rule should fire on. This is not a **safety** judgement: an offline exclude can still silently break the suppression promise, which the runner treats as a separate (forward-looking) signal class.
- The inverse check is parameterised over both reference sets (creative + audience). A suspended audience referenced by a non-terminal buy that doesn't list it in `impairments[]` now produces a `violation: 'inverse'` failing result, mirroring the existing creative inverse coverage.
- `audience` is removed from `INVERSE_DEFERRED_FAMILIES`. The `not_applicable` hint that used to fire on audience offline transitions stops firing — audience observations now flow into the graded path. The onEnd partial-coverage summary still flags `catalog_item` and `event_source` (their per-buy reference shapes remain unstable).

**2. `creative_approvals[]` is now walked on buy snapshots.**

The `get-media-buys-response.json` package shape uses `creative_approvals[]` (per spec) — different from `core/package.json`'s `creative_assignments[]` (the request-side shape). `readBuySnapshot` now walks both, so the inverse rule for creative grades correctly regardless of which shape the seller surfaces.

**Test coverage:** 6 new tests — 5 audience inverse coverage tests (graded propagation, exclude-doesn't-count, terminal carve-out, recovery clears, paired with health-iff) + 1 creative_approvals extraction test. The existing deferred-family test loop moves audience out and asserts the graded behaviour.

**No behaviour change for storyboards that already propagate impairments correctly** — they previously graded `not_applicable` for audience offline observations and now grade `pass` instead. Storyboards that observed an audience transition without propagating it to a buy snapshot previously graded silent (with an `not_applicable` notice) and now FAIL with a structured `impairment_coherence_violation` hint pointing at the offline audience.
