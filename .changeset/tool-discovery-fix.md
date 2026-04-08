---
"@adcp/client": patch
---

Fix skipped-step counting in storyboard runner and add tool_discovery diagnostic observations to comply(). Steps skipped due to requires_tool are now correctly counted as skipped instead of passed, and comply() emits observations showing discovered tools and expected-vs-actual tools when tracks are skipped.
