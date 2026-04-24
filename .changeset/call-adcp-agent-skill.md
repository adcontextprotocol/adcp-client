---
'@adcp/client': patch
---

New skill: `skills/call-adcp-agent/SKILL.md` — buyer-side playbook for LLM clients calling an AdCP agent. Covers the wire contract, the `oneOf` account variants, idempotency invariants, async flow (`status:'submitted'` + `task_id`), error recovery from `adcp_error.issues[]`, and minimal payload examples for the top five tools (`get_products`, `create_media_buy`, `sync_creatives`, `get_signals`, `activate_signal`).

**Motivation**: [#915](https://github.com/adcontextprotocol/adcp-client/pull/915) made MCP `tools/list` schema-free (the trade-off for cross-transport validation symmetry). Empirical three-way comparison showed a naive LLM gets stuck on 5/5 common tools without priors; with this skill loaded, Claude-class clients land their first successful call in 1 hop on all five. Upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057) (`get_schema`) remains the longer-term spec path for programmatic schema discovery; this skill unblocks LLMs today.

Referenced from `CLAUDE.md`; ships alongside the existing `skills/build-*-agent/` set.
