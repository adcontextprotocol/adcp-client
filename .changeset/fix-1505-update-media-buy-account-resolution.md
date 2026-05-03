---
'@adcp/sdk': patch
---

fix(testing/storyboard): symmetric account resolution on `update_media_buy` enricher (closes #1505)

The storyboard runner's `update_media_buy` enricher was not in
`FIXTURE_AWARE_ENRICHERS`, so the generic `{ ...enriched, ...fixture }`
merge let storyboard `sample_request.account` override the harness-
resolved account. When create_media_buy used a runner-synthesized
sandbox account (e.g. `{ brand: 'test.example', operator: 'test.example', sandbox: true }`)
and the storyboard's update step authored `account: { brand: 'real.example', operator: '...' }`,
the update wrote to the prod partition while create wrote to the
sandbox partition. A subsequent `get_media_buys` reading from the
sandbox partition (via `context.account`) saw stale create-time
targeting_overlay — exactly the failure surfaced by the
`media_buy_seller/inventory_list_targeting/get_after_update` cascade
step.

This change adds `update_media_buy` to `FIXTURE_AWARE_ENRICHERS` and
rewrites the enricher to spread fixture fields first then force-override
`account` to `context.account ?? resolveAccount(options)` — symmetric
with the `get_media_buys` / `get_media_buy_delivery` fix in #1487.

Legacy storyboards without a `sample_request` still fall back to the
keyword-based pause / resume / cancel inference; only the fixture-
authored path changes.
