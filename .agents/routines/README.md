# Claude Code Routines

Routines put Claude Code on autopilot against this repo, running on
Anthropic-managed cloud infrastructure at
[claude.ai/code/routines](https://claude.ai/code/routines).

This directory holds the committed half of each routine: prompt and
setup script. The saved configuration at claude.ai is kept thin and
points back at these files, so iteration happens in the repo.

## Identity — read this first

Routines are owned by whichever claude.ai account **created** them.
That account's subscription burns tokens on every run, and its linked
GitHub identity is what commits appear as. For AdCP we want
`brian@agenticadvertising.org`.

1. In your Claude Code CLI, run `/status`. If not on that account,
   `/login`. Then `/web-setup` to sync GitHub auth.
2. Install the [Claude GitHub App](https://github.com/apps/claude) on
   `adcontextprotocol/adcp-client` under the GitHub identity you want
   commits to appear as.

## Setup

1. **Create the routine** at
   [claude.ai/code/routines](https://claude.ai/code/routines) or via
   `/schedule` in the CLI:
   - **Name:** `adcp-client — issue triage`
   - **Prompt:** the minimal launcher below
   - **Repository:** `adcontextprotocol/adcp-client`; leave branch
     pushes restricted to `claude/*`
   - **Environment:** new env, paste `environment-setup.sh`; Trusted
     network access
   - **Schedule trigger:** every 6 hours

   Launcher prompt:

   ```
   You are the adcp-client issue-triage agent. Read these in order,
   then act:

     1. CLAUDE.md          — entry-point for agents
     2. AGENTS.md          — coding rules for this repo
     3. .agents/routines/triage-prompt.md  — triage behavior

   If a user message below contains issue context, act on that
   issue. Otherwise walk the open-issue queue.
   ```

2. **Add an API trigger** → copy URL, generate token (shown once).
3. **Repo secrets:** `CLAUDE_ROUTINE_TRIAGE_URL`,
   `CLAUDE_ROUTINE_TRIAGE_TOKEN`.
4. Bridge workflow at `.github/workflows/claude-issue-triage.yml`
   fires `/fire` on `issues.opened`/`reopened`.

## Auto-fix

For Claude-opened PRs, enable auto-fix via the CI status bar on the
PR (or `/autofix-pr` locally while on the branch). Requires the
Claude GitHub App.


## Triage Routine — Manual Nudge

The triage routine fires on issue open/reopen, on `/triage`
slash-commands (via `slash-command-dispatch.yml`), or on plain
non-bot, non-self, non-`/triage`, non-PR-conversation comments
landing on open issues.

| What you want | How |
|---|---|
| Re-trigger triage on a missed issue | Comment `/triage` |
| Bias toward Execute on a borderline issue | Comment `/triage execute` |
| Force a clarifying-question comment | Comment `/triage clarify` |
| Force defer | Comment `/triage defer` |
| Add new info to a stuck Clarify | Plain comment with the new info |

**What does NOT trigger triage:** prose like "Pinging triage" or
"@claude please look at this" without the literal `/triage` token
(the slash-command-dispatch only matches the exact token); comments
on PR conversations (auto-fix's job, not triage); bot authors;
self-loops (filtered via the `Triaged by Claude Code` footer).

**How to know if triage is on it:**

- Label `claude-triaging` → routine is actively working (1-3 min).
  Don't start a parallel PR.
- Label `claude-triaged` (without `claude-triaging`) → routine
  finished. Triage comment / draft PR / silent-defer is the outcome.
- Neither label, no `## Triage` comment, issue >a few minutes old
  → triage didn't fire. Webhook miss likely. Comment `/triage` to
  recover, or run `.agents/scripts/triage-local.sh <issue#>`.

The `Clear stuck claude-triaging labels` workflow clears the label
automatically every 30 min; the `Triage webhook-miss sweep` catches
silent webhook misses hourly.
