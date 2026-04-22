---
'@adcp/client': patch
---

Storyboard runner: honor `step.sample_request` in
`list_creative_formats` request builder.

Prior behavior hardcoded `list_creative_formats() { return {}; }`, so
any storyboard step declaring `format_ids: ["..."]` (or any other
query param) in its sample_request hit the wire as an empty request.
The agent returned unfiltered results and downstream round-trip /
substitution-observer assertions failed silently (the agent looked
non-conformant, but the filter had never been sent).

Mirrors the pattern used by peer builders (`build_creative`,
`sync_creatives`, etc.). No other API change.

Closes #780.
