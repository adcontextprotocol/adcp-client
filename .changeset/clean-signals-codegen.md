---
'@adcp/sdk': patch
---

Fix generated `SignalTargetingExpression` types and validators so categorical values remain non-empty, numeric bounds remain required and ordered, and unrelated objects cannot satisfy the union.
