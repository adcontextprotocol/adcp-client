---
"@adcp/sdk": patch
---

fix(comply): thread AbortSignal through the storyboard run loop so comply()'s timeout actually bounds wall-clock (#1612, MCP side)

Before this change, `complyImpl`'s combined `timeout_ms` / external-signal
`AbortController` only fired between storyboards (`signal.throwIfAborted()` at
the top of each `for (const sb of applicableStoryboards)` iteration). Inside a
single storyboard, `executeStoryboardPass` had no signal awareness — so a
storyboard with many sequential per-step calls would burn the full comply()
budget regardless of when the abort fired.

Three changes:

1. `StoryboardRunOptions.signal?: AbortSignal` (new optional field).
2. `complyImpl` forwards its combined signal into `runOptions`.
3. `executeStoryboardPass` calls `options.signal?.throwIfAborted()` at the
   start of every phase iteration AND every step iteration, so the abort
   fires between any two steps — not only between storyboards.

Empirical verification against `wonderstruck.sales-agent.scope3.com/mcp` with
a 60s timeout: wall-clock went from **150s → 60.8s** (timeout + 0.8s tail).

Note: the A2A path against the same agent still leaks ~250s past the abort.
That's a separate root cause (A2A discovery / probe loop with no signal
awareness) tracked under the same issue and not addressed here.
