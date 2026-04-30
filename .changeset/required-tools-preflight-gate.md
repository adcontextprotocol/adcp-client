---
"@adcp/client": patch
---

fix(conformance): enforce storyboard required_tools pre-flight gate in runner

The `required_tools` field on `Storyboard` was declared and typed but never
enforced on the normal execution path — only consulted in the degraded-auth
bailout in `comply.ts`. This meant storyboards targeting media-buy tools (e.g.
`past_start_enforcement`) ran against signals-only, creative, or governance
agents that advertise none of those tools, producing misleading per-step
failures instead of a clean skip.

`executeStoryboardPass` now checks `storyboard.required_tools` immediately
after profile discovery. If the storyboard declares required tools and the
agent advertises none of them, the runner returns a synthetic
`overall_passed: true` / `skip_reason: 'missing_tool'` result. Agents that
advertise at least one required tool proceed normally.
