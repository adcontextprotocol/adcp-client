---
'@adcp/sdk': minor
---

storyboard runner: add `field_greater_than` / `field_at_most` / `field_at_least` check kinds, completing the numeric-comparison quadrant (#1839)

Cap and floor scenarios can now assert "value at most N" / "value at least
N" directly, with non-strict (`<=` / `>=`) semantics:

```yaml
- check: field_at_most
  path: media_buy_deliveries[0].totals.frequency
  value: 3
  description: Observed frequency stays at or below the requested cap

- check: field_at_least
  path: media_buy_deliveries[0].totals.reach
  context_key: promised_reach
  description: Delivered reach meets or exceeds the promised floor
```

The three new checks plus the existing strict `field_less_than` cover the
four-quadrant numeric comparison vocabulary (`<`, `>`, `<=`, `>=`). All
four share the same comparand-resolution semantics: either a literal
`value` or a runtime-captured `context_key`, with absent context keys
passing the check with a `context_key_absent` observation (the prior step
may have been legitimately skipped on a branch-set path). Non-numeric
operands fail with a type error.

`field_greater_than` is included to close the quadrant — without it,
storyboards reaching for strict-`>` would hit the runner's forward-compat
`not_applicable` default and silently grade as passing, which is
semantically wrong for assertions that should fail at the boundary.

The previous workaround for cap assertions
(`field_less_than: 3.01` — literal-plus-epsilon) was semantically wrong
(assumed a rounding convention) and brittle when sellers reported the cap
value exactly. `field_at_most: 3` is the right primitive.

Concrete consumer: the `media_buy_seller/frequency_cap_enforcement`
storyboard (adcontextprotocol/adcp#4727) will swap its
`field_less_than: 3.01` epsilon workaround for `field_at_most: 3` once
this ships.
