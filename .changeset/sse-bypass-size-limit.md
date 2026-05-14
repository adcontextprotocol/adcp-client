---
'@adcp/sdk': patch
---

fix(client): pass `text/event-stream` responses through `enforceSizeLimit` (#1176)

The response-body byte cap was designed for one-shot JSON discovery responses
(`get_adcp_capabilities`, agent-card lookup). SSE responses legitimately stream
N status frames + a final result frame whose cumulative bytes can exceed any
reasonable cap, but each frame is bounded by protocol-level framing. Bypass the
cap for `text/event-stream` (case-insensitive prefix match, covers `; charset=utf-8`
variants). Adopters can now safely set `maxResponseBytes` on long-lived buyer
sessions without tearing down legitimate streams.
