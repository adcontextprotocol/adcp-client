---
'@adcp/client': minor
---

Add `resolvePerStoryboard` callback to `runAgainstLocalAgent`

`runAgainstLocalAgent` now accepts a `resolvePerStoryboard(storyboard, defaultAgentUrl)` callback that returns optional per-storyboard overrides. Callers can redirect a single storyboard to a different URL (e.g. route `signed_requests` at `/mcp-strict` while the rest stay on `/mcp`) and shallow-merge `StoryboardRunOptions` fields like `test_kit`, `brand`, `contracts`, or `auth` per storyboard without giving up the helper's single-serve / single-seed lifecycle. The override shape is flat — `{ agentUrl?, ...StoryboardRunOptions }` — and `webhook_receiver` stays helper-owned (typed out of the shape; re-applied after the merge). The callback may return a `Promise` for async work such as loading a test-kit YAML or minting a scoped token. Returning `undefined` keeps the run-level defaults, so existing callers are unaffected. Resolves #810.
