---
'@adcp/sdk': minor
---

Add a durable server-side principal lifecycle with atomic section replacement, reporting-destination generations, declaration negotiation, and recoverable `principal.changed` delivery.

Principal handlers now require the dedicated authenticated `protocol.resolvePrincipalScope` resolver. Adopters already exposing `getPrincipal` or `syncPrincipal` must rename their principal resolver from `resolveScope` to `resolvePrincipalScope`; `resolveScope` remains the notification-only resolver for `syncAgentNotificationConfigs`.
