---
'@adcp/client': patch
---

Re-export the storyboard assertion registry (`registerAssertion`,
`getAssertion`, `listAssertions`, `clearAssertionRegistry`,
`resolveAssertions`, and types `AssertionSpec`, `AssertionContext`,
`AssertionResult`) from `@adcp/client/testing` so authors of invariant
modules can import them from the documented package entry point. The
underlying module (`./storyboard/assertions`) already exported these;
only the parent `./testing` index was missing the re-exports. Closes
the gap introduced by #692.
