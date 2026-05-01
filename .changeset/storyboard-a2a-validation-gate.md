---
"@adcp/sdk": patch
---

Two fixes for A2A storyboard regression-adapter tests that were silently skipping validators:

1. **Validation gate** (`executeStep`): the gate condition `(taskResult || httpResult)` is expanded to `(taskResult || httpResult || a2aEnvelope)`, so validators that only need the raw wire-shape envelope (e.g., `a2a_submitted_artifact`, `a2a_context_continuity`) run correctly even when the A2A SDK throws on a forbidden state (e.g., `status.state: 'submitted'` per A2A 0.3.0).

2. **Synthetic capture** (`callA2AToolImpl`): after `client.sendMessage()` returns, a synthetic POST capture is injected directly into the active `rawResponseCaptureStorage` slot. This guarantees `parseLastA2aMessageSendCapture` always finds a capturable envelope regardless of whether the A2A SDK version routes `sendMessage` through an internal transport that bypasses the provided `fetchImpl`. Without this, `priorA2aEnvelopes` would never be populated and `a2a_context_continuity` would silently skip on step 2 with reason `first_a2a_step`.
