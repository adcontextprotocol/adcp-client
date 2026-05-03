---
"@adcp/sdk": minor
---

Extend `ComplyControllerConfig.force` with `create_media_buy_arm` and `task_completion` slots, closing the gap between the low-level dispatcher and the structured-config façade.

**What was missing.** `ComplyControllerConfig.force` (the typed config surface for `createComplyController` and `createAdcpServerFromPlatform({ complyTest })`) previously only exposed four slots — `creative_status`, `account_status`, `media_buy_status`, `session_status`. The dispatcher in `test-controller.ts` already handled `force_create_media_buy_arm` and `force_task_completion` (they are in `CONTROLLER_SCENARIOS`, `SCENARIO_MAP`, and the `switch` dispatch), but `buildStore` and `advertisedScenarios` had no bridge from the typed config to those store methods. Adopters on the structured config who implemented the underlying logic still hit `UNKNOWN_SCENARIO` every time.

**What's new.**

- `ForceCreateMediaBuyArmParams` — `{ arm: 'submitted' | 'input-required'; task_id?: string; message?: string }`
- `ForceTaskCompletionParams` — `{ task_id: string; result: Record<string, unknown> }`
- `DirectiveAdapter<P>` — adapter type returning `ForcedDirectiveSuccess` (distinct from `ForceAdapter<P>` which returns `StateTransitionSuccess`; `create_media_buy_arm` registers a pre-call directive, not a state transition)
- `ComplyControllerConfig.force.create_media_buy_arm?: DirectiveAdapter<ForceCreateMediaBuyArmParams>`
- `ComplyControllerConfig.force.task_completion?: ForceAdapter<ForceTaskCompletionParams>`
- `buildStore` wires both adapters to `store.forceCreateMediaBuyArm` / `store.forceTaskCompletion`
- `advertisedScenarios` pushes `FORCE_CREATE_MEDIA_BUY_ARM` / `FORCE_TASK_COMPLETION` when the corresponding adapter is present
- `testing/test-controller.ts` client-side `ControllerScenario` union extended with `'force_create_media_buy_arm'` and `'force_task_completion'`

All changes are additive (new optional slots, new exported types). No existing API is modified.

Fixes #1472. Unblocks the `media_buy_seller/create_media_buy_async` storyboard and any other storyboard that drives `force_create_media_buy_arm` or `force_task_completion` through `createComplyController`.
