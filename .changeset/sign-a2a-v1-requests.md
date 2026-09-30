---
'@adcp/sdk': patch
---

Request signing now signs A2A 1.0 requests. `extractAdcpOperation` recognised only A2A 0.3 bodies (`message/send` with `kind: "data"` parts), so the `SendMessage` bodies the A2A client sends to A2A 1.0 agents yielded no operation and went out unsigned, even when the seller listed the operation in `request_signing.required_for`. It now also reads `SendMessage` / `SendStreamingMessage` and data parts without `kind`. Fixes #3081.
