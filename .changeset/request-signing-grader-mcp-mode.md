---
'@adcp/client': minor
---

Request-signing grader — MCP transport mode (closes #612).

The conformance grader shipped in #600 targets raw-HTTP AdCP endpoints
(`/adcp/create_media_buy`), matching the spec vectors' URL shape. MCP
agents expose a single JSON-RPC endpoint with the operation named in the
body — different URL shape, different framing. This change adds a
transport-aware grading mode so the same grader works against both.

**New `GradeOptions.transport: 'raw' | 'mcp'`** (default `'raw'`).

In `'mcp'` mode, for every vector:

- The URL becomes `baseUrl` as-is (no path-join) — MCP agents have one
  endpoint; the operation is in the body, not the path.
- The body is wrapped in a JSON-RPC `tools/call` envelope:
  ```json
  { "jsonrpc": "2.0", "id": N, "method": "tools/call",
    "params": { "name": "<operation>", "arguments": <vector.body> } }
  ```
  `operation` is extracted from the vector URL's last path segment
  (`/adcp/create_media_buy` → `create_media_buy`).
- `Accept: application/json, text/event-stream` is added so MCP Streamable
  HTTP servers don't 406 the probe. Not a signed component, so adding it
  doesn't affect signatures.

The signature covers the envelope body (including `content-digest` when
the verifier capability requires it). The verifier's `resolveOperation`
reads the JSON-RPC `params.name`; this pattern is already the canonical
one for MCP-hosted verifiers.

**CLI flag `--transport <mode>`** on `adcp grade request-signing`.
Validated against `raw | mcp`; any other value exits 2 with a clear
error.

**New test agent `test-agents/seller-agent-signed-mcp.ts`** — uses
`createAdcpServer` (with `request_signing` + `specialisms` advertised via
the #600 framework wiring) + `serve({ preTransport })` (the pre-MCP
middleware hook from #600). The verifier fires before MCP dispatch; valid
requests flow into `createMediaBuy` / etc., invalid requests get 401 +
WWW-Authenticate.

**End-to-end test** at `test/request-signing-grader-mcp.test.js` —
spawns the MCP agent on a dedicated port, grades it in MCP mode, asserts
25/25 non-profile vectors pass + structural invariants on the envelope
shape (method, params.name, URL = baseUrl, Accept header present).

Raw-HTTP grading (default) is unchanged. Canonicalization-edge vectors
(005–008) bake their edges into the vector URL path/query — MCP mode
folds them into plain POSTs against the MCP endpoint, which is a
documented trade-off, not a regression. Operators who want those edges
tested should use `--transport raw` against a per-operation agent.

Dependency graph is now complete for the live-agent smoke test tracked
at adcontextprotocol/adcp#2368: with #600 (grader) + this PR
(MCP-aware) + #2368 (test-agent deploys the verifier + advertises the
specialism), `adcp grade request-signing https://test-agent.adcontextprotocol.org/mcp --transport mcp`
produces a meaningful conformance grade.
