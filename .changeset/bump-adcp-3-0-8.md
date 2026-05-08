---
'@adcp/sdk': patch
---

Bump `ADCP_VERSION` to 3.0.8. Patch release that extends the [adcp#4218](https://github.com/adcontextprotocol/adcp/pull/4218) storyboard idempotency-key precedent to the rest of the suite (adcp#4230). Fifteen storyboard steps across nine media-buy scenarios still shipped hardcoded `idempotency_key` literals on state-mutating tasks (`create_media_buy`, `sync_creatives`, `sync_plans`, `update_media_buy`); against a long-running seller the runner's dynamic `start_time` substitution shifted the canonical body forward while the static key replayed, arming the spec-mandated `IDEMPOTENCY_CONFLICT` (or, when the seller's emit shape changed between runs, replaying a now-spec-non-compliant cached payload). Every remaining literal is now `$generate:uuid_v4#<scenario>_<step>` so each storyboard run mints fresh keys.

Affected scenarios: `creative_fate_after_cancellation` (5), `governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery` (3), `invalid_transitions`, `inventory_list_no_match`, `inventory_list_targeting`, `pending_creatives_to_start`.

`COMPATIBLE_ADCP_VERSIONS` extended with `'3.0.8'` for editor autocomplete on the `adcpVersion` constructor option. Generated types regenerated; functional schema content is identical to 3.0.7 (this release was a storyboard-only fix — no wire-format or schema change).
