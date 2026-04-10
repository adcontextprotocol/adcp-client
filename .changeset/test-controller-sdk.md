---
"@adcp/client": minor
---

Added registerTestController(server, store) and TestControllerStore for server-side comply_test_controller implementation. Sellers can add deterministic compliance testing support with one function call instead of implementing the tool from scratch. Also adds skip_reason field to StoryboardStepResult to distinguish "not testable" (agent lacks tool) from "dependency failed" (prior step failed).
