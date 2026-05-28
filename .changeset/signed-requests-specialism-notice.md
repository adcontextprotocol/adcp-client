---
'@adcp/sdk': minor
---

Emit the canonical `signed_requests_specialism_deprecated` runner notice when
agents still advertise the deprecated `signed-requests` specialism on the
signed-requests storyboard.

The notice is a counter-neutral deprecation advisory with
`capability_path: "specialisms"` and `effective_version: "4.0"`. This widens
the public `NoticeCode` union so dashboards and CI gates can handle the new
canonical code explicitly.
