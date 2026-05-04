---
'@adcp/sdk': patch
---

Fix `WIRE_SPEC_FIELDS` entry objects not being frozen, and harden `pickWireSpecFields` against `Array.prototype[Symbol.iterator]` poisoning. `Object.freeze(WIRE_SPEC_FIELDS)` froze the outer map's slots and the inner `fields` arrays, but the entry objects themselves were mutable — so `.fields` could be silently reassigned, defeating the L2 allowlist. Additionally, the `for-of` loop in `pickWireSpecFields` dispatched through `Array.prototype[Symbol.iterator]`, which a supply-chain dep could poison to inject extra field names at call time. Fixed by wrapping every entry in `Object.freeze({...})` (codegen script + generated file) and replacing the `for-of` with an indexed loop. Adds two new test assertions (entry-freeze + iterator-poisoning). Also corrects contradictory JSDoc on `ScrubExtensionsOptions.inject`.
