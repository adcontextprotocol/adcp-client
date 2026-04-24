---
'@adcp/client': patch
---

Align `replayed` envelope semantics with `protocol-envelope.json`: the field is now **omitted on fresh execution** and stamped only on replay. The envelope spec permits the field to be "omitted when the request was executed fresh", and absence-as-fresh is cleaner than emitting a pro-forma `false` on every mutating response.

- Internal: renamed `injectReplayed` to `stampReplayed` and dropped the fresh-path call site in `create-adcp-server.ts`. The replay path still stamps `replayed: true` on cached copies so buyers can distinguish cached replays from new executions.
- Public API (`wrapEnvelope`) unchanged: sellers can still pass `replayed: false` explicitly and the helper round-trips it. Sellers that want an explicit marker in-band are free to emit one.
- Documentation updated: `wrapEnvelope` JSDoc no longer claims conformance storyboards require `replayed: false` on fresh-path mutations.

Upstream: filed [`adcp-client#857`](https://github.com/adcontextprotocol/adcp-client/issues/857) against the `idempotency.yaml` storyboard's `field_value allowed_values: [false]` assertion, which conflicts with the envelope spec's explicit allowance for omission. Until that storyboard assertion lands as `any_of` or `field_absent_or_value`, the `replay_same_payload` phase will fail on the fresh-path step — this is the storyboard being the bug, not the SDK.
