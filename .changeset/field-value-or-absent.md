---
"@adcp/client": minor
---

Added `field_value_or_absent` storyboard check matcher. Passes when the field is absent OR present with a value in `allowed_values` / matching `value`; fails only when present with a disallowed value. Use it for envelope-tolerant assertions (e.g. fresh-path `replayed`) where the spec allows omission but forbids a wrong value. Closes #873.
