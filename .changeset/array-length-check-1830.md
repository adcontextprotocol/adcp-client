---
'@adcp/sdk': minor
---

storyboard runner: add `array_length` check kind for cardinality assertions (#1830)

Cardinality scenarios can now assert "exactly N entries" directly:

```yaml
- check: array_length
  path: media_buys[0].impairments
  value: 2
  description: Exactly two impairments — one per rejected creative
```

Range form is also supported (`min` / `max`, either or both, both inclusive):

```yaml
- check: array_length
  path: media_buys[0].impairments
  min: 1
  max: 1
  description: Exactly one impairment
```

The previous workaround (`field_present arr[N-1]` paired with
`field_value_or_absent arr[N] value: null`) is unsound for cardinality: the
`field_value_or_absent` clause passes when a seller emits a literal `null`
pad at `arr[N]`. `array_length` reads `array.length` directly and rejects
non-array resolutions, so a `null` pad fails the check as it should.

Specifying both `value` and `min`/`max` is rejected as a misconfigured
check. Specifying none of the three is also rejected. Resolved-path-is-not-an-array
fails with a type error rather than passing silently.

Follow-up to adcontextprotocol/adcp#4685 protocol review; spec-side YAML
schema addition tracked separately.
