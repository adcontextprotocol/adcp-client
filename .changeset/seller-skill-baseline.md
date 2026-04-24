---
'@adcp/client': patch
---

docs(seller-skill): define the baseline explicitly

Follow-up to #843. The seller-agent skill referenced "the baseline" 25+ times without enumerating it. A reader (or a coding agent like Claude) hitting the skill could not find an authoritative list of tools every `sales-*` agent must implement, which is the gap that let an adapter update remove `get_products` and `create_media_buy` on the read that `sales-social` is "walled-garden-only."

Adds a new top-level "The baseline: what every sales-\* agent MUST implement" section to `skills/build-seller-agent/SKILL.md` with the full 11-tool table (`get_adcp_capabilities`, `sync_accounts`, `list_accounts`, `get_products`, `list_creative_formats`, `create_media_buy`, `update_media_buy`, `get_media_buys`, `sync_creatives`, `list_creatives`, `get_media_buy_delivery`), the `createAdcpServer` handler group each belongs to, a minimum handler skeleton, and an explicit "if a specialism's storyboard doesn't exercise a baseline tool, the tool is not optional" note.

Also anchors the section and wires cross-refs from the "Specialisms are additive" intro paragraph and the `sales-social` "Baseline tools still apply" block so readers have a single source of truth for the baseline surface.

No code changes; skill is shipped under `files[]` so a patch bump surfaces the doc update to downstream consumers who ship CLAUDE.md-linked skill packs.
