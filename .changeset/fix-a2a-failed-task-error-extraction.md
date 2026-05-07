---
"@adcp/sdk": patch
---

fix(conformance): unwrap DataPart for A2A terminal failure states

`unwrapA2AResponse` threw for any `status.state !== 'completed'`, including
the terminal `'failed'`, `'rejected'`, and `'canceled'` states. This caused
the storyboard runner's `error_code` / `field_present` / `field_value`
validators to read `taskResult.error` ("Task failed") instead of the
`adcp_error` DataPart that spec-compliant A2A sellers embed per
transport-errors.mdx §A2A Binding.

Terminal failure states now fall through to the same artifact-extraction path
as `'completed'`, restoring symmetry with successful A2A responses and fixing
8 `media_buy_seller` storyboard steps that were incorrectly failing on the A2A
transport while passing on MCP.
