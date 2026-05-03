---
"@adcp/sdk": patch
---

Two follow-ups from the PR #1515 expert review:

**SHAPE-GOTCHAS §7 — `signal_type: marketplace` vs `owned` vs `custom`** (`skills/SHAPE-GOTCHAS.md`)

dx-expert + docs-expert both flagged that the `signal_type` discrimination clarification appeared twice in `skills/build-signals-agent/SKILL.md` (~30 lines apart) and was a known footgun better captured as a SHAPE-GOTCHAS entry than skill-prose repetition. Added entry §7 with a decision table covering the three values, the spec definitions (per `schemas/cache/3.0.5/enums/signal-catalog-type.json`), and the most common adopter mistake — first-party data agents mis-classifying their segments as `custom` when they have a standing data asset behind them (it's `owned`). Replaced both inline clarifications in the signals SKILL with pointers to §7.

**Build-* skills deep-link cross-cutting.md anchors** (`skills/build-*-agent/SKILL.md`)

docs-expert deferred from #1515: build-* skills had bare `[../cross-cutting.md](../cross-cutting.md)` references with no per-rule deep-links, so adopters fetching the file pulled the whole 73-line file even when only one rule was relevant. Each build-* skill's "Cross-cutting rules" section now lists the high-traffic rules for that skill domain with anchor links to the specific rule (e.g., the seller skill links `[idempotency_key](../cross-cutting.md#idempotency_key-is-required-on-every-mutating-call)` directly). Adopters can land on a 5-line block instead of the full file.

Eight skills updated: seller, creative, signals, governance, brand-rights, generative-seller, retail-media, si, holdco. Each surfaces the 3-5 rules most relevant to that adopter persona; the bare cross-cutting.md link is preserved as the "read it once cold" pointer.

Validated: fork-matrix 23/23, typecheck + format clean.
