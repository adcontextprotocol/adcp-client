---
'@adcp/client': patch
---

Skill files now reference `docs/llms.txt#<tool>` for per-tool field contracts instead of duplicating them inline. Each skill's "Tools and Required Response Shapes" section opens with a canonical-contracts callout pointing Claude at the anchored llms.txt section — same content, one source of truth.

The build-creative-agent skill gets a surgical slim: verbose response-shape blocks (which duplicate llms.txt verbatim) collapsed into a compact handler-binding table. Gotchas and anti-patterns stay; the field enumerations move to llms.txt. ~94 lines smaller, same signal.

Other skills get the pointer line without content removal — follow-up passes can do surgical slims once the pattern is validated. With strict response validation enabled by default in dev (#727), any drift between a skill example and the schema now fails at call site with the exact field path.
