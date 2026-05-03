---
"@adcp/sdk": patch
---

fix(server): echo input.context into comply_test_controller response envelopes

`handleTestControllerRequest` and `createComplyController.handleRaw` now propagate `input.context` into every response branch (`ListScenariosSuccess`, `StateTransitionSuccess`, `SimulationSuccess`, `ForcedDirectiveSuccess`, `SeedSuccess`, `ControllerError`), matching the `comply-test-controller-response.json` schema. Previously, storyboards asserting `context` echo (e.g. `deterministic_testing`'s correlation_id round-trip) failed with "Field not found at path: context". Fixes #1455.
