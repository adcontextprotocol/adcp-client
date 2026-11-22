---
'@adcp/sdk': patch
---

Storyboard strict response check: validate the seller's payload as sent against the served release's schema (adcp-client#3751). The check prepared the payload for the SDK pin's generated Zod schemas, so for a seller serving AdCP 3.2.x it added `status: "completed"` to a synchronous `decline_proposals` answer and then validated that against the 3.2.x JSON Schema, which forbids `status` on that arm. Every conforming 3.2.x `decline_proposals` answer failed, and storyboards `media_buy_seller/declined_proposal_execution` and `declined_proposal_refinement` could not pass for a 3.2.x seller under a 17.x runner. `prepareResponseForSchemaValidation` now takes the version whose schema judges the payload (defaulting to the SDK pin, so the Zod call sites are unchanged), and the strict check passes the served release.
