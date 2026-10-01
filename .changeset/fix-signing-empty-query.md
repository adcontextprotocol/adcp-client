---
'@adcp/sdk': patch
---

Preserve a trailing empty query delimiter in default request target URI canonicalization and authorized-agent URL matching, so signatures and URL checks distinguish `/p?` from `/p`. Older SDK verifiers that collapse the marker will reject signatures over `/p?`; update both peers for these URLs. Signing fetch wrappers now reject signed URLs with a terminal empty query marker because Fetch implementations disagree on whether they transmit it.
