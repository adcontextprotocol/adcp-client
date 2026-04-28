---
"@adcp/client": minor
---

feat(server): `dispatchSeed` emits `SeedSuccess` (3.0.1's seed-specific arm)

AdCP 3.0.1 added a dedicated `SeedSuccess` arm to `comply-test-controller-response.json` for `seed_*` scenarios:

```json
{ "success": true, "message": "Fixture seeded" }
```

The schema's `oneOf` excludes `previous_state`/`current_state` from this branch via `not.anyOf` — seeds are pre-population, not entity transitions. The SDK previously borrowed `StateTransitionSuccess`'s shape (`{ success: true, previous_state: 'none' | 'existing', current_state: 'seeded' | 'existing' }`) which wire-validated as the transition arm under the open `oneOf` but didn't realize the storyboard ergonomics 3.0.1 designed for.

`createComplyController` / `handleTestControllerRequest` now return `SeedSuccess` from every `seed_*` scenario:

- Fresh seed → `{ success: true, message: 'Fixture seeded' }`
- Idempotent replay (same id + equivalent fixture) → `{ success: true, message: 'Fixture re-seeded (equivalent)' }`
- Divergent fixture → unchanged (`INVALID_PARAMS`)

Affects all six seed scenarios: `seed_product`, `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`, `seed_creative_format`. `force_*` scenarios continue to return `StateTransitionSuccess`.

### Migration

- Callers narrowing seed responses with `expectControllerSuccess(result, 'transition')` switch to `expectControllerSuccess(result, 'seed')`. The narrowing falls through to the new arm via the existing `'seed'` overload.
- Idempotent-replay detection moves from `previous_state === 'existing'` to a stable `message` token (`'Fixture re-seeded (equivalent)'`).
- Adopters consuming raw `comply_test_controller` responses for seed scenarios stop reading `previous_state`/`current_state` on those responses (the spec's `not.anyOf` forbids them on `SeedSuccess`).
