---
"@adcp/client": minor
---

Add comply_test_controller support for deterministic lifecycle compliance testing. When a seller exposes the optional `comply_test_controller` tool in sandbox mode, comply walks full state machines by forcing seller-side transitions instead of just observing. Includes 7 new scenarios: creative state machine, media buy state machine, account state machine, SI session state machine, delivery simulation, budget simulation, and controller self-validation.
