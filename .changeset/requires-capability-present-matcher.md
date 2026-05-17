---
'@adcp/sdk': minor
---

feat(storyboard): add `present:` matcher to `requires_capability` gates

Extends the storyboard runner's `requires_capability` predicate with a
presence-only matcher for spec capabilities whose contract is "presence
of this object indicates support" — adcp-client#1811.

The motivating case is `media_buy.conversion_tracking`, which the spec
defines as:

> Seller-level conversion tracking capabilities. Presence of this object
> indicates the seller supports sync_event_sources and log_event for
> conversion event tracking.

There is no boolean to test with `equals`. Sub-properties like
`multi_source_event_dedup` or `supported_event_types` are not faithful
proxies for the presence signal. The same shape will appear for future
capability surfaces that the spec defines as "presence means support."

New form (mutually exclusive with `equals:` on a single gate):

```yaml
requires_capability:
  path: media_buy.conversion_tracking
  present: true
```

Semantics:

- `present: true` — the value at `path` MUST exist (non-null,
  non-undefined). Empty object `{}` counts as present (the spec's
  presence-is-the-signal contract). Absent fields skip the storyboard
  with `skip_reason: 'capability_unsupported'`. This DIFFERS from
  `equals:` absence semantics — for presence matchers, silence IS the
  spec-defined opt-out, so a missing field is not_applicable rather
  than a coverage gap.
- `present: false` — the value at `path` MUST NOT exist. Useful for
  scenarios that only apply to agents that explicitly do NOT advertise
  a capability.

Existing `equals:` scenarios are unchanged; the discriminator is the
presence of `equals` vs `present` on the gate object. TypeScript
authors get a discriminated union that enforces mutual exclusion at
type level.

The predicate logic is factored into a new exported helper
`evaluateCapabilityPredicate(predicate, actual): string | null` so the
matcher semantics can be unit-tested directly without a full
`runStoryboard()` roundtrip.

Concrete consumer (filed under adcp#4569): a
`media_buy_seller/performance_buy_flow` scenario that gates on
`media_buy.conversion_tracking` and exercises the end-to-end
event-source → buy → log → attributed delivery flow.
