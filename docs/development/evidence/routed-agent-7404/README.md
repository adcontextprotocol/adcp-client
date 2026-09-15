# Routed-agent applicability audit

Reproduction/initial base: `39b07141d3bdf6ba650f3625db471ab017b89a33` (2026-09-14).
Current integration base: `a4a269cc48f38a7d7ca9da2998b0b36cac2dfb0c` (2026-09-15,
#2917 media-buy action assessment). Reviewed historical head:
`85f95020967ddedc0ece03e5de43e728e1d7e284`, based on
`ecf1c74535fb184a91c5b4279b40e8f38f4558e9` (#2907, AdCP rc.3 adoption).
That head is preserved in local branch `backup/pr2920-reviewed-85f95020` and a
verified git bundle before rebasing the existing PR branch.

All nine historical commits rebase patch-identically. The 136 files changed on
main since the historical base have zero path overlap with this patch's 26 files.
In particular, main has not changed the five implementation files carrying the
routed applicability fix, so the dispatch/gate mismatch remains applicable.
New reporting consumer-status hardening, canonical offline validators, targeting
migration adapter, and negotiated media-buy action assessment remain inherited
unchanged from current main. No composition overlay or sibling branch edits are
included.

Qualification and independent review must run again at the final rebased head.
Exact base/head/tree, binary-diff SHA-256, local results, review adjudications, and
terminal CI are recorded in PR #2920's current evidence. Earlier ecf1c745- and
55829081-based results are historical evidence, not current-head qualification.
The pinned `fc488660` rc.4 workflow replay is historical too: protocol main had
diverged from that source. Neither replay nor SDK tests establish hosted adoption.

## Reproduction before SDK edits

Exact npm tarballs were downloaded with `npm pack`:

| SDK | npm SHA-1 |
| --- | --- |
| 13.0.2 | `a335a2e7963134f45bf6677aaee6f6c6bcd65cef` |
| 13.0.4 | `5f28b155b619c4ea7cc5e6d3c49109747a681a20` |

The two packaged `compliance/cache/3.1.20` trees compare byte-for-byte equal
with `diff -rq`. Exact protocol bundle digests are in
`test/fixtures/routed-applicability/README.md`.

The public seller guide documents `demo-*` bearer principals and reserved-domain
sandbox traffic: https://nofluffadvisory.com/adcp-buyers-guide/ . The commands in
`reproduction.json` used `demo-routed-7404` and the SDK's default sandbox mode.
Anonymous discovery omits `comply_test_controller` and does not reproduce the
operator's principal; its 171→278 step result is not substituted for the report.

| SDK / exact cache | Total steps | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| 13.0.2 / 3.1.20 | 306 | 232 | 1 | 73 |
| 13.0.4 / 3.1.20 | 349 | 241 | 5 | 103 |
| 13.0.4 / 3.1.23 | 331 | 239 | 5 | 87 |

The **+43 total, +9 passed, +4 failed, +30 skipped** delta reproduces before
editing. Absolute totals differ by one passing step from the reporter's
305/348 runs. Failure identity also changed on the live seller: the four new
failures here are billing-finality `create_media_buy` and three provenance
discovery responses missing `format_ids`; the reporter named governance buys
instead of billing finality. These are not claimed to be the same frozen agent
deployment. The common failure is `provenance_truth_of_claim/sync_creatives_contradicted`.

The compressed JSON files preserve the complete, unmodified CLI output for all
three runs. `reproduction.json` records raw/archived SHA-256, exact selected and
missing storyboard lists, failure identities/messages, and timestamps. For example:

```sh
gzip -dc docs/development/evidence/routed-agent-7404/13.0.4-3.1.20.json.gz
```

## Authority and fix

`required_tools` is an **any-of storyboard applicability predicate**. A union of
routed tool lists is valid for that question; it cannot establish an individual
step's task contract. `runStoryboard({ agents })` selects a route using explicit
`step.agent`, unique protocol ownership, then `default_agent`; ambiguity and
missing routes remain failures.

Before the patch, the dispatcher selected agent A but passed the run-level
unioned tools, primary profile, and transport to `executeStep`. A deterministic
two-agent MCP run demonstrated a call to A authorized solely by B's
`sync_governance`. The patch binds the existing execution gates and observations
to the same selected agent as the transport client. It also makes routed discovery
authoritative over stale caller `agentTools` and shares the any-of predicate
between suite selection and standalone execution. Single-agent overrides retain
their previous precedence. No response validator or protocol declaration is weakened.

Root and phase capability predicates apply to each selected agent's steps, not
an insertion-order primary profile. A whole-storyboard/phase capability skip is
retained only when every selected route is known and inapplicable. Predicates
for a particular role should be scoped to that role's phase. Cascade tool checks,
creative-asset preflight, account checks, controller scenario declarations,
authentication, OAuth metadata applicability, and transport observations use the selected profile/options.
Validation-only coverage does not require a transport route. Phase-local repeated
step IDs cannot share capability decisions. Fixture resolution binds each seed or
discovery operation to that operation's selected agent toolset, only when its
strategy is reached. An unused fallback cannot require another route. Failed
stateful routes preserve the dependency cascade.
Dynamic task references resolve before protocol routing and ambiguity checks, so a
conflicting dynamic step cannot be discovered only after earlier calls have run. Tool-family applicability and fixture-availability skips cannot conceal an
unresolved route or failed discovery. Missing runtime adapters remain explicit requirement skips before wire execution;
known routing failures are retained alongside those skips. Phase skips cannot
erase a previously established routing failure.
Runtime tool-family/controller availability remains a topology-level prerequisite;
it cannot authorize a step that its selected agent does not advertise.

`comply()` is a single-agent suite API; its public `ComplyOptions` does not declare
`agents`, and the routed runner requires an empty positional URL. Tests exercise
both existing selection seams without inventing a new routed `comply()` API.

## Protocol declaration work still required

The seven exact cached declarations are retained, with shared bytes deduplicated
and hashes checked in tests. All five governance/provenance declarations are
identical in 3.1.20 and 3.1.23.

- `governance_approved` and `governance_conditions` name `governance_aware` in
  descriptive agent capabilities, but omit a machine-readable
  `requires_capability` predicate. Any-of legitimately admits a seller that has
  `get_products`/`create_media_buy` without `sync_governance`. Protocol authors
  must declare the seller's governance contract and prerequisite/state flow.
- `provenance_audit_observation` still admits a signals-only controller through
  `required_tools: [get_products, sync_creatives, comply_test_controller]`.
  Publishing 3.1.23 does not remove this shape.
- The three provenance fixture products omit `format_ids`. The recorded
  seeded/readback responses reproduce that response-schema failure. Two of those
  storyboards already satisfy all-of on the seller, so reverting the selector
  would not repair them. Seed validation and complete fixture declarations need
  protocol-side correction; this patch does not suppress those failures.
- Routed controller seeding is already explicitly unsupported unless the caller
  provisions fixtures externally and sets `skip_controller_seeding: true`.
  Tests retain the complete declarations and assert the existing refusal for each
  declaration that enables controller seeding. A second matrix runs every authored
  phase with the explicit external-seeding option, against split and complete
  routed toolsets whose deterministic endpoints reject calls. Its exact selected,
  skipped (including failed prerequisite skips), and failed sets are committed in
  `test/fixtures/routed-applicability/routed-rejections.json`; none of the failures
  become passing/neutral results. Fixture seeding is not claimed to be implemented.

The independent routed matrix uses real discovery/dispatch through official SDK
clients with deterministic test servers. It asserts selected/skipped/failed step
sets for split prerequisites, complete first/secondary agents, overlap, explicit
overrides, missing routes, discovery failures, stale caller lists, account-mode
isolation, root/phase/conjunctive capabilities in reversed agent-map order,
stateful cascades, creative preflight, dynamic tasks, actual per-agent Authorization headers and anonymous overrides, and mixed MCP/A2A
transport with both run-level transport defaults. Additional tests cover OAuth
metadata probes, 404 cascades, and per-agent presence accounting, runtime adapters, validation-only rows, repeated
step IDs, implicit signing opt-in, fixture route failures and unavailable fixtures.
Versioned declaration tests cover both
selection seams and canonical storyboard IDs versus bundle aliases. Tests also
verify the full historical archives and the +43/+4 delta. These are negative
compatibility tests, not a claim that the authored governance/provenance flows
are now conformant or that all historical failures share an SDK root cause.

## Adoption boundary

This work does **not** close AdCP #7404. Hosted adoption separately requires
#7507's publication-manifest fix, #7506, deployment, and a complete heartbeat for
both reported agents. A green SDK build or a local reproduction is not hosted
adoption evidence. Auto-merge remains off. Mark Ready and request normal human
maintainer review only after clean exact-head qualification, independent review,
and terminal CI. No merge, npm publication, tag, or release is authorized.
