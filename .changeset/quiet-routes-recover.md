---
'@adcp/sdk': minor
---

Add owner-bound, operation-routed crash recovery for direct A2A mutation continuations. Custom deferred stores must round-trip the new route-kind and ownership digest fields, implement all operation-route methods, and preserve the atomic route when deleting a superseded generation. Deploy updated readers across a shared store before enabling the opt-in on writers. The route covers pause generations only: persist the initial recovery pair before relying on restart recovery, and reconcile terminal or submitted uncertainty through the host operation record without redispatching the mutation.
