# AAO-SECRETARIAT

AdCP's PR reviewer, as a set of GitHub Actions: `setup` → `reviewer` → `arbiter`,
orchestrated by `review`. The reviewer emits schema-validated findings; the
arbiter decides an outcome (`approve` / `request-changes` / `comment` /
`escalate`) via a constrained tool call and posts a single review.

## Provenance

Forked from Scope3's **Argus** review action (`scope3data/actions/argus-v2` @
`5524fdc4b5998374640f0e16003e29e6d38c8aa2`) and adapted from the Argus review
workflow in `adcontextprotocol/adcp` (PR #4816). Renamed **AAO-SECRETARIAT** for
AdCP; AdCP-specific deltas (auth via the AAO IPR Bot App, `pull_request_target`
head-read handling, repo rules in `AAO-SECRETARIAT.md`) are tracked in this fork.

## Layout

Phase-1: the action tree lives here under `.secretariat/ai-review/`. Phase-2:
it moves to a central AdCP repo and every AdCP repo consumes it from there.
