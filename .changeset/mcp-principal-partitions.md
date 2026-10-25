---
'@adcp/sdk': minor
---

Add `transport.connectionPartition` to isolate MCP session reuse by a caller-owned principal without sending that value to the seller. The partition separates modern, legacy, and OAuth sessions, endpoint discovery, shared discovery, and signing-policy evidence. It also separates principals inside a workflow connection scope.

Unscoped MCP calls now own and close one-shot sessions by default, restoring isolation when callers share a seller credential and identify their customer only in tool arguments. To keep process-wide reuse, configure a stable nonempty partition or explicitly set `transport.connectionReuse: 'process'` for a single-principal caller. Explicit connection scopes retain workflow reuse. Injected fetch implementations remain one-shot outside a scope. Repeat the partition when replacing a constructor's transport with per-call options.

The public low-level MCP tool and native task helpers also detach from any enclosing caller policy and accept explicit partition/reuse settings. Calls such as unscoped seller-side `checkGovernance()` now own one-shot sessions. Product-cache reads and writes are bypassed when a per-call transport changes the configured principal.

Native task follow-ups accept explicit routing headers and signing context, detach inherited signing identities, and supply the official MCP SDK result schema when reading task results.
