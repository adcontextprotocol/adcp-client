---
'@adcp/sdk': patch
---

**Fix: storyboard runner now fails loudly on discovery errors** (`runStoryboard`).

When agent capability discovery (`get_agent_info` / MCP `tools/list`) failed — typically due to MCP transport setup / auth misconfiguration / network policy issues against localhost agents — the runner used to silently emit `agentTools: []` and let every step skip with `skip_reason: 'missing_tool'`. The result was an "X/X clean" CI summary with 100% skipped: indistinguishable from "agent legitimately doesn't claim those tools" and **invisible in pipelines**.

The v6 training-agent migration spike surfaced this when storyboards reported "4/4 clean" with 20 skipped steps because `connectMCPWithFallback`'s StreamableHTTP attempt was failing and the SSE fallback got 405 — discovery threw, was caught silently, every subsequent step skipped.

Fixed at the runner layer (which is also Layer 1 of the [upstream draft's two-layer recommendation](#)):

- `runStoryboard` now checks `discovered.step.passed` after `getOrDiscoverProfile` and returns a hard-failure `StoryboardResult` (`overall_passed: false`, `failed_count: 1`, no skipped-step masquerade) when discovery failed.
- New exported helper `buildDiscoveryFailedResult(agentUrls, storyboard, discoveryStep)` constructs the synthetic phase + step. The underlying transport error is preserved verbatim in `step.error` so operator triage sees the original cause (e.g. `SSE error: Non-200 status code (405)`).

This catches the failure mode immediately in CI rather than after someone notices "everything is skipped" weeks later. Layer 2 (the StreamableHTTP-vs-SSE transport-selection bug under non-`{test,development}` `NODE_ENV`) is a separate investigation; this fix ensures whatever discovery error surfaces, it surfaces loudly.

2 unit tests pin the result shape: full transport-error preservation, plus the no-error-string fallback.
