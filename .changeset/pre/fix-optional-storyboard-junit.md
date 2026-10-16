---
'@adcp/sdk': patch
---

Keep optional storyboard probe failures visible in JUnit diagnostics without failing CI when the runner excludes them from the verdict. Required failures, including checks on advertised OAuth metadata, still fail CI. JUnit suite and aggregate counts now match the emitted test cases.
