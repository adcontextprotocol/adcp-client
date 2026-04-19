---
'@adcp/client': patch
---

Idempotency middleware now stamps `replayed: false` on fresh executions (not
just `replayed: true` on replays). Caught by running the universal
`idempotency` compliance storyboard against a retail-media agent built from
the updated skill — the `replay_same_payload/create_media_buy_initial` step
expects `replayed: false` on the envelope, and the previous implementation
omitted the field entirely. The cache still stores the envelope WITHOUT the
`replayed` field; it's stamped after the save so a subsequent replay cleanly
overwrites it with `true`. Existing test asserting `replayed !== true` on
fresh executions tightened to `replayed === false`.

Skills: wire `createIdempotencyStore` into the main Implementation code block
for `build-creative-agent`, `build-signals-agent`, `build-brand-rights-agent`,
`build-retail-media-agent`, and `build-generative-seller-agent`. Each skill
already documented idempotency but the copy-paste-complete Implementation
example was missing the wiring, so a fresh agent built from the skill would
log the "v3 non-compliance" error at startup. Seller, SI, and governance
skills were already complete. Also extends `test-agents/test-agent-build.sh`
to cover all 8 agent types, adds the universal `idempotency` storyboard as
a second check on every run, and passes `--allow-http` so local storyboard
runs actually execute.
