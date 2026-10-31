---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the engine writes per-offering exclusions.

When the offerings a condition covers have different period boundaries, the engine writes one `excluded[]` entry per offering, with `offering_id` and that offering's own cutover instants. This covers `capacity`, `excluded_by_buyer`, `action_required` and `overridden` across calendars, and a buy's `offering_unsupported` after a resolution change. Before, it wrote one account-wide entry cut at the latest end. One calendar, or several with the same schedule, still gets a single entry. A per-offering entry closes at its own offering's cutover. Callers served a release whose `excluded[]` has no `offering_id` get the entries folded back into one entry cut at the latest instant, as before.
