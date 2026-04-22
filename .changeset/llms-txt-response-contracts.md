---
'@adcp/client': patch
---

`docs/llms.txt` now includes per-tool response contracts. Each tool section gets a `**Response (success branch):**` block listing the required + optional fields drawn from the bundled JSON schemas — same format the existing request block uses.

Closes the drift path we kept seeing in matrix runs: agents dropped required response fields (missing `format_id` on `creative_manifest`, plural-variant hallucinations like `creative_deliveries` for `creatives`, missing top-level `currency`) because the skill examples documented the intent but the full per-field contract lived in the generated schemas and was never surfaced in the llms.txt index Claude actually reads when building. The contract is now one anchored section away: `docs/llms.txt#build_creative`, `docs/llms.txt#get_creative_delivery`, etc. — same convention as the llms.txt pattern other projects use.

No SDK code change; llms.txt is regenerated via `npm run generate-agent-docs`.
