---
'@adcp/sdk': patch
---

Skip dependent storyboard observations when a stateful test-controller force scenario is unsupported, including when forcing is the only stateful step in its phase. Preserve a not-applicable coverage result without dispatching unforced observations or awarding passing-step credit; independent phases and genuine failures retain their normal grading.
