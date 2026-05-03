---
"@adcp/sdk": patch
---

Pivot from skill-matrix to fork-matrix; collapse `build-*-agent/SKILL.md` files.

The skill-matrix harness (`scripts/manual-testing/run-skill-matrix.ts` + `agent-skill-storyboard.ts` + `skill-matrix.json`) graded "can a fresh Claude session build an AdCP server from prose in SKILL.md." That's not the workflow real adopters use now that every production specialism has a worked, CI-tested fork target in `examples/hello_*_adapter_*.ts`.

The fork-matrix is the canonical compliance gate going forward. Each `test/examples/hello-*.test.js` boots the matching reference adapter against a mock-server upstream, runs the storyboard grader, and verifies upstream traffic — the three-gate contract from `docs/guides/EXAMPLE-TEST-CONTRACT.md`. Empirical comparison: skill-matrix v18 ran 1/8 in ~50min with 6 timeouts; fork-matrix runs 22/22 in ~12s.

**Changes:**

- New: `npm run compliance:fork-matrix` — runs every `test/examples/hello-*.test.js` gate.
- New: `skills/cross-cutting.md` — shared rules every `build-*` skill points at (idempotency, resolve-then-authorize, auth, signed-requests, ctx_metadata safety, account-resolution presets, webhook operation_id stability).
- Collapsed all 8 `build-*-agent/SKILL.md` to fork-target pointers + cross-cutting reference. Net: 6,916 lines deleted across `seller` (1835→83), `creative` (798→80), `signals` (578→70), `governance` (1006→84), `brand-rights` (640→83), `generative-seller` (621→78), `retail-media` (515→78), `si` (410→86); `holdco` light-touched.
- Removed: `npm run compliance:skill-matrix`, `npm run compliance:agent-skill`, plus `scripts/manual-testing/run-skill-matrix.ts`, `agent-skill-storyboard.ts`, `skill-matrix.json`.
- Updated: `docs/guides/VALIDATE-YOUR-AGENT.md` and `CLAUDE.md` reference fork-matrix.

**Adopter impact:** If you were running `npm run compliance:skill-matrix`, switch to `npm run compliance:fork-matrix`. The fork-matrix is faster, deterministic, and tests the same compliance question against the workflow adopters actually use (fork → swap upstream → ship).

Tracked at adcp-client#595 (closed by this change). The original "full vs reference-linked vs rules-only" experiment was the right question for the world where Claude built from scratch; in a fork-target world it's measuring noise.
