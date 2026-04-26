---
"@adcp/client": patch
---

docs(testing): add @provenance annotations to StoryboardStepHint fields

Each field on the five hint kinds (ContextValueRejectedHint, ShapeDriftHint,
MissingRequiredFieldHint, FormatMismatchHint, MonotonicViolationHint) now
carries a @provenance seller|storyboard|runner tag so downstream renderers
(Addie, CLI, JUnit) can identify which fields contain seller-controlled bytes
that must be sanitized before reaching prompt-injection-vulnerable surfaces.

Also annotates StoryboardStepHintBase.message with an explicit warning that
the pre-formatted string embeds seller bytes for context_value_rejected and
monotonic_violation kinds; and adds @provenance to typedoc.json blockTags so
the TypeDoc build recognises the new tag.

Motivated by adcp#3084 and adcp#3220, where undocumented seller provenance on
request_field and from_status produced prompt-injection vectors in downstream
renderers.
