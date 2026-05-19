# Review stacks: Claude experts + codex (dual-model second opinion)

Safety-critical PRs in this repo run **two parallel review stacks** — one through Claude expert agents, one through `codex`. Convergence between the two is the confidence signal; divergence is where the real review happens.

## When to use which

| PR class | Review path |
|---|---|
| Routine (docs, refactor, small features) | Claude experts via the Agent tool, single-stack. |
| Cross-cutting (touches multiple subsystems) | Claude experts, parallel — fire DX + protocol + code-review + security in one message. |
| **Safety-critical** (auth, signing, replay, idempotency, governance, tenancy) | Claude experts **plus** `npm run review:codex -- --all`. Treat convergence as ship-confidence; divergence is the actual review. |
| Anthropic outage / 529 storm | `npm run review:codex -- --all` carries the load until capacity returns. |

"Safety-critical" is anything where a subtle bug becomes a financial-fraud risk, a multi-tenant cross-poisoning risk, or a replay-protection bypass. Examples in this repo:

- `src/lib/signing/*` (RFC 9421 verifiers, nonce stores)
- `src/lib/server/idempotency/*` (replay cache)
- `src/lib/server/ctx-metadata/*` (publisher-attached opaque blobs, tenant-scoped)
- `src/lib/server/auth*` (bearer / API-key / signature verification)
- Anything that introduces a new substrate-specific backend (the kind of bug that lives in subtle SQL or Lua boundary conditions).

## Why dual

One real data point from PR #1858 (Redis backends for ctx-metadata + ReplayStore): the Anthropic API was overloaded for the full afternoon. Three of four Claude experts hit sustained 529s across three retry windows. The codex pass returned cleanly and **caught a code-level replay-protection bypass** in the Lua script that nobody else flagged (PEXPIREAT was overwriting forward expiry instead of extending it).

The lesson isn't "switch to codex" — it's "use both."

- **Claude experts have curated, codebase-specific personas** (`ad-tech-protocol-expert`, `security-reviewer`, `dx-expert`, `code-reviewer`). They have pre-loaded knowledge of repo conventions, rubrics, prior incidents stored in `~/.claude/projects/.../memory/`. DX-expert in particular catches adopter-shape parity bugs that a general-purpose agent won't.
- **Codex runs a different model family.** Different blind spots. The PR #1858 bug — a single-line Lua expiry semantic — is the kind of subtle multi-step reasoning where a second perspective matters even when the first one is healthy.

## How

### Codex side

```bash
# Single persona — pipe PR context via stdin:
echo "PR #1858: adds Redis ReplayStore. Focus on Lua atomicity at redis-replay-store.ts:124-150." \
  | npm run review:codex -- --persona protocol

# Or auto-build context from the diff vs base:
npm run review:codex -- --persona security --base main

# All three (protocol + code + security) in parallel, scoped to the diff:
npm run review:codex -- --all --base main
```

> **Staleness note:** bare branch names like `main` are automatically resolved
> to `origin/main` (the script fetches the remote branch before diffing). If
> the fetch fails (network outage, CI runner without remote access), a warning
> is printed and the diff falls back to whatever `origin/main` was last
> fetched. Pass `--base origin/main` explicitly to skip the automatic fetch.

Persona prompts live in `scripts/codex-review-prompts/{dx,protocol,code,security}.md`. Output goes to `$TMPDIR/codex-review-<persona>.txt`. `--all` skips `dx` because the Claude DX-expert has codebase-specific rubric knowledge that's hard to replicate in a general-purpose agent — if you want a codex DX second opinion, run `--persona dx` explicitly.

### Claude side

Use the `Agent` tool with four parallel calls — DX, protocol, code-reviewer, security — in a single message. Pattern documented in `~/.claude/projects/.../memory/feedback_parallel_expert_review.md` (see also `feedback_codex_dual_stack.md` for when to add codex).

### Synthesizing

After both stacks return:

1. List findings by file:line.
2. **Convergence** (both stacks flag the same thing) → high-confidence fix, address.
3. **Divergence** (only one flags) → that's the review. Read the rationale carefully — the diverging review either caught something the other missed, or is wrong about the context. The decision is the value-add.
4. **No findings from either** → high-confidence ship.

## Cost

- Codex CLI runs read-only locally. Three parallel `codex exec` calls take ~3 minutes wall time and don't consume Anthropic API budget.
- The pattern doubles review cost on safety-critical PRs. Worth it for the class of bug that lives in subtle race conditions or substrate-specific semantics — those find their way into production at high cost. For routine PRs, single-stack is fine.

## Reference

- The PEXPIREAT bug from PR #1858: `src/lib/signing/redis-replay-store.ts` (now fixed via forward-only TTL extension).
- Helper script: `scripts/codex-review.sh`.
- Persona prompts: `scripts/codex-review-prompts/`.
