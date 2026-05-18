---
'@adcp/sdk': minor
---

storyboard runner: add `field_at_most` / `field_at_least` check kinds for non-strict numeric thresholds (#1839)

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

The two new checks are symmetric with each other and with the existing
strict `field_less_than`. They share the same comparand-resolution
semantics: either a literal `value` or a runtime-captured `context_key`,
with absent context keys passing the check with a `context_key_absent`
observation (the prior step may have been legitimately skipped on a
branch-set path). Non-numeric operands fail with a type error.

The previous workaround for cap assertions
(`field_less_than: 3.01` — literal-plus-epsilon) was semantically wrong
(assumed a rounding convention) and brittle when sellers reported the cap
value exactly. `field_at_most: 3` is the right primitive.

Concrete consumer: the `media_buy_seller/frequency_cap_enforcement`
storyboard (adcontextprotocol/adcp#4727) will swap its
`field_less_than: 3.01` epsilon workaround for `field_at_most: 3` once
this ships.
