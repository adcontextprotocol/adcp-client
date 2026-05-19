---
"@adcp/sdk": patch
---

fix(cli): storyboard run banner shows 'basic' instead of 'bearer' when --auth-scheme basic is used

The chained ternary that builds the `Auth:` label in the `adcp storyboard run` run-header had no `'basic'` branch. When `buildResolvedAuthOption` returned `{ type: 'basic', … }`, the chain fell through to the `'bearer'` default, printing `Auth: bearer` even though the correct Basic header was sent on the wire. Fixed by adding an explicit `authOption.type === 'basic' ? 'basic' :` branch before the `'bearer'` fallback.
