// AdCP SDK — compliance harness
//
// Umbrella entry that re-exports the four compliance-related modules:
//
//   - `testing`: pre-configured test agents, agent-tester scenarios,
//     storyboard runner + parser, controller assertions, comply-controller
//     scaffold, seed-merge helpers, brief library. Largest surface; about
//     60 symbols.
//   - `conformance`: property-based fuzzer driven by published JSON schemas
//     (`runConformance`, `seedFixtures`, tier constants).
//   - `compliance-fixtures`: canonical storyboard fixtures keyed by ID
//     (`COMPLIANCE_FIXTURES`, `seedComplianceFixtures`,
//     `COMPLIANCE_COLLECTIONS`).
//   - `signing/testing`: in-memory signing provider for conformance runs
//     (`InMemorySigningProvider`, `ALLOW_IN_MEMORY_SIGNER_ENV`).
//
// Why an umbrella: a compliance harness usually wants all four. Keeping
// each subpath separately importable — `@adcp/sdk/testing`,
// `@adcp/sdk/conformance`, etc. — preserves the bundle-cost escape hatch
// for callers who only need one piece (so `fast-check` and the schema
// bundle don't load when you just want test agents).
//
// **Collision safety.** `export *` lets TypeScript enforce TS2308 at
// compile time if two sources ever try to re-export the same name. A
// future PR that adds (e.g.) `seedFixtures` to `testing` would fail the
// build until either the `testing` export is renamed or one source
// drops it — there's no silent shadowing path. The `compliance-umbrella`
// smoke test (test/lib/compliance-umbrella.test.js) additionally asserts
// a representative set of symbols stay visible across the four sources,
// so an accidental removal from one of them surfaces as a test failure
// rather than as a missing import in a downstream consumer.

export * from '../testing';
export * from '../conformance';
export * from '../compliance-fixtures';
export * from '../signing/testing';
