---
'@adcp/sdk': minor
---

Automatically sign JSON-RPC protocol methods according to the seller's separate `protocol_methods_required_for`, `protocol_methods_warn_for`, and (with `sign_supported`) `protocol_methods_supported_for` lists. Add `always_sign_protocol_methods` for exact slash-path/PascalCase pilot overrides with inline or provider-backed keys, including before discovery. Preserve the separate AdCP-operation namespace and reject ambiguous method bodies before dispatch when protocol-method policy applies.

Sign compatibility `tasks_get` MCP and `tasks/get` A2A skill polls when the seller declares support for the buyer's signing profile, with fresh nonces, existing transport authentication, and version-appropriate body binding. A configured but invalid signing identity can now fail these polls instead of relying on unsigned bearer fallback. Best-effort A2A cancellation uses the shared signer, active AdCP wire pin, and Web Bot Auth advertisement gate. A Web Bot Auth cancellation is abandoned when cached profile support is unavailable.

Native SDK task listing now primes signing capabilities and retains configured authentication/routing headers. Partition transport, discovery, and testing-client reuse by signing overrides so cached wrappers retain the correct policy. Preserve unsigned functional-compliance bootstrap discovery by refusing A2A invocation-method overrides that would sign it.

Reject malformed signing flags before dispatch instead of silently downgrading to unsigned requests. Preserve the functional runner's unsigned capability-bootstrap policy even when cached protocol-method coverage includes all A2A messages.
