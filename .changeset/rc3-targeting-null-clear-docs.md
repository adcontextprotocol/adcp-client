---
'@adcp/sdk': patch
---

Document the AdCP 3.2 request-only Targeting Input three-state semantics for seller adopters.

`docs/guides/MEDIA-BUY-3.2-COMPATIBILITY.md` gains a section with the omitted / `null` / value table for
both create and update, worked `resolveTargetingInput` / `applyTargetingInput` / `hasTargetingClears`
snippets, and the two silent failure modes — persisting a request overlay verbatim writes a clear
command into durable state, and echoing it back emits `null` on a response shape whose schema forbids
it. `skills/build-seller-agent/` gets the short form under its shape-gotchas section, since a seller
agent generated from that skill is exactly the code that gets this wrong.

The helpers shipped without a doc or skill entry, so the only worked example was in a starter that is
being reworked to reject supplied overlays outright.
