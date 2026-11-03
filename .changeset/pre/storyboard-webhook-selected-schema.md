---
'@adcp/sdk': patch
---

Validate storyboard webhook payloads against the run's selected AdCP release and report the exact resolved schema version. A 3.0 run now grades its webhook result against the 3.0 contract, while incoming webhook version claims cannot change the selected validator. Runs without a version pin keep the SDK default.
