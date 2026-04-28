---
"@adcp/client": minor
---

feat(cli): `adcp storyboard run --no-sandbox` forces production routing on every request

Adds an opt-in `--no-sandbox` flag to `adcp storyboard run` (single-storyboard, multi-instance, full-assessment, and `--local-agent` paths). When set, every request the runner builds carries `account.sandbox: false` explicitly, signaling to the agent: "route to the production code path, not the sandbox stub."

The default behavior is unchanged — `account.sandbox` stays unset (spec-equivalent to `false`), so existing storyboard runs keep working without modification. The flag is for adopters whose agents have BOTH a real adapter and a sandbox handler and where the sandbox heuristic (env var, brand domain) might otherwise mask non-conformance in the real path. Spec-compliant agents key sandbox routing on the `account.sandbox` field; this flag makes the production intent explicit on the wire so well-behaved agents are forced to exercise their real handler.

The `comply_test_controller` scenario continues to force `account.sandbox: true` regardless of the flag — that's the spec contract for the test controller and the runner's seeding works against sandbox accounts only.

The dry-run header and live-run header now show "Run mode: production accounts (--no-sandbox: account.sandbox=false)" when the flag is set, so operators have a visible signal that production routing was requested.

Skill docs in `skills/build-*-agent/` will be updated in a follow-up to recommend that adopters key their real-vs-sandbox routing on `ctx.account.sandbox` rather than env vars or brand-domain heuristics.

Filed against #841.
