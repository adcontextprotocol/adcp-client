---
'@adcp/sdk': patch
---

Convert repeatable pixel-tracker arrays when an explicit legacy format requires a URL tracker slot, including already named slots. Preserve every tracker and report lossy conversion diagnostics at each array index. Keep mixed roles and partially convertible arrays unchanged rather than forcing them into one slot.
