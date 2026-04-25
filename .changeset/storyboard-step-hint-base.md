---
"@adcp/client": patch
---

Add `StoryboardStepHintBase<K extends string>` interface that every `StoryboardStepHint` union member extends, enforcing the `kind` discriminator and `message` fallback contract at compile time. Non-breaking — existing fields are unchanged; the interface is additive.
