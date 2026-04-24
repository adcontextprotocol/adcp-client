---
"@adcp/client": patch
---

Runner `context_value_rejected` hint closing sentence now cites the two tool names involved in the catalog drift (e.g. "Check that the seller's `get_signals` and `activate_signal` catalogs agree.") instead of deriving an identifier fragment from the context key. The previous phrasing ("Check that the seller's catalogs agree on the id for this `first_signal_pricing_option` across steps.") read awkwardly when the key was multi-word — surfaced during dogfood. Falls back to the single-task form when only the source tool is known, and to a generic closing when neither is known. The detector now accepts an optional `currentTask` argument; existing callers keep working unchanged (generic closing).
