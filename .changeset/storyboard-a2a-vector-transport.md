---
'@adcp/sdk': minor
---

Send an A2A request when the storyboard protocol under test is A2A.

`signed_requests` vectors were dispatched as MCP on every run: `resolveVectorTransport` returned `'mcp'` without reading `options.protocol`, so an A2A run POSTed an MCP `initialize` at the A2A endpoint and every vector errored in the precondition before one was graded.

Adds an `'a2a'` vector transport. The RPC endpoint is resolved from the agent card's `supportedInterfaces` (`JSONRPC` binding) rather than derived from the agent URL, the envelope is a native `SendMessage` built as a typed `SendMessageRequest` and serialized by `@a2a-js/sdk`'s own `toJSON`, and `A2A-Version` is merged before the signature is computed. `@a2a-js/sdk` is imported dynamically inside the A2A branch, so grading MCP never loads it.
