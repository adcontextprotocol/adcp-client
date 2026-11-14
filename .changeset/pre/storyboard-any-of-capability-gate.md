---
'@adcp/sdk': minor
---

Storyboard capability gates accept `any_of`, and `contains` matches an object by a subset of its keys (adcontextprotocol/adcp#8998).

- `requires_capability`, `phases[].requires_capability` and each `requires_all_capabilities` entry may be an `any_of` group of two or more predicates, which passes when one of them passes. Groups nest, and each entry keeps its own schema-default and no-raw-capabilities rules. The loader validates every `any_of` group.
- `contains` and `not_contains` with an object value now match an array entry that carries every key of the value with an equal value; the entry may carry other keys. Scalars and arrays still match by structural equality, and governance task-mode matching is unchanged.
- New exports: `evaluateCapabilityPredicateAgainstCapabilities`, `isAnyOfCapabilityPredicate` and `capabilityPathPredicates`. `evaluateCapabilityPredicate` throws a `TypeError` for an `any_of` predicate.

An older runner reading an `any_of` gate throws while resolving its missing `path` when raw capabilities are available, and treats the gate as satisfied when they are not. Bundles that use either form need this release or later. See `docs/guides/STORYBOARD-CAPABILITY-GATES.md`.
