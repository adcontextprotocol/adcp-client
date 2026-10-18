# Creative evaluator build probes

A storyboard may opt into `creative_build_probe: {context_prefix: build,
message: "Create one sandbox creative"}`. The full runner and standalone step
runner prepare one route/input binding before controller seeding or dispatch,
and then enable `creative_build_probe_runner`. Author the gated steps with
`requires_contract: creative_build_probe_runner` so older engines give no
executed security credit.

Provision the sandbox account, build entitlement, task authorization, and
accepted evaluator endpoint separately. Complete format metadata does not prove
these account/task prerequisites. The resolver does not issue a hidden build.

`test_kit.creative_build_probes` accepts recipes `{match: [...], input: {...}}`.
Match clauses use the existing fixture-resolution DSL against the catalog entry.
The operator asserts that the input is valid for **every** matched route for this
account. Input can contain message, creative_manifest, creative_id, transformer_id,
config and legacy target_format_id; it cannot replace evaluator, account, auth or trust material. Use a
specific capability-ID predicate when a kind-only predicate is insufficient.
Full manifest schema validation runs before dispatch. Config requires a transformer;
provision its live parameter values and an appropriate output route. Library IDs,
transformers, source asset URLs, and account authorization are operator fixtures.

The automatic generation path requires a unique advertised build route,
supports_generation, technical_requirements_complete, a known non-custom kind,
empty params, and no unhandled declaration metadata (descriptive identity/preference/channel metadata is inert).
It supplies the brief and `{format_kind: selectedKind, assets: {}}`. Otherwise a
matched recipe is required; omitted catalog operations still mean build and
missing catalog IDs remain discoverable but unaddressable through capability-ID routing. Non-build entries and
unsatisfiable routes do not prevent selecting a later satisfiable route.

Resolved records use fixture_type `creative_format`, the prefix as handle, exact
matched requirements, and seller_ids.capability_id or seller_ids.format_id. Unsatisfied whole runs have a
fixture_unsatisfied coverage gap and zero executed security validations; standalone
steps use skip_reason fixture_unsatisfied and canonical not_applicable, with detail
naming creative_format:<prefix>. This does not establish producer nonconformance
or passing security coverage. Malformed catalogs produce a structured failed validation; malformed operator recipes throw authoring errors during applicable preparation
with the required schemas available. Unavailable catalog/schema prerequisites
can return a zero-credit fixture gap before exhaustive recipe diagnostics. Routed and
replicated runs currently report an explicit gap before seeding; run each agent
independently. Unopted storyboards retain their existing behavior and counters.

The protocol-side harness contract and consuming fixture are tracked in
[adcp#8240](https://github.com/adcontextprotocol/adcp/issues/8240).

## Payload-bound authorization limitation

Current probe preparation requires a sandbox build fixture that does not need
a per-request signed governance_context. The runner detects an advertised
build_creative signed_context enforcement claim and reports fixture_unsatisfied
with zero security credit; static recipes cannot pre-sign the fresh request.
Other governed tasks do not disable this build probe. Preparing fresh governed
probe authorizations is a separate runner integration, not a protocol decision.

Recipe fields stay exactly as provisioned: omitting message does not add the
storyboard's generation brief. The automatic source manifest is validated too.
Descriptive metadata (display_name, seller_preference, experimental,
sample_render_url, format_option_id, publisher_domain, applies_to_channels,
canonical_formats_only) does not remove security coverage. Unknown metadata and
constraint-bearing extensions require an operator recipe. The probe-local
unambiguous-source/config rules do not add restrictions to build_creative wire
requests in other modes, including refinement.

Operator recipe authoring is bounded to 100,000 traversed nodes, 4 MiB of UTF-8
string/key bytes, and the existing JSON depth bound per recipe. Repeated aliases
count on every visit, before match normalization. These are harness configuration
limits, not producer catalog requirements. Missing required selected-version
validators yield a zero-credit harness gap; they never authorize a dispatch.


## Selected-version routing

The runner uses the existing guarded capabilities-echo authority for catalog
interpretation. A same-major release-precision echo must be listed in the
response's supported_versions and have an available bundled or supplied schema
root. Invalid, missing, unlisted or unavailable echoes retain the pin. Supplied
servedReleaseSchemaRoots apply to the catalog only. The runner captures build
request, source-manifest and target-FormatID validators from the pin before
activating any served catalog root, including overlapping version aliases.
The public five-argument resolveCreativeBuildProbe works on an already selected
creative catalog and uses its supplied pin only; it has no full capabilities
response from which to select an echo. Full and standalone runners use the
internal preparation path for guarded served-release selection.

Catalog kind, parameter, ID and operation semantics follow that served release;
build selectors and source inputs retain the request pin. Canonical route IDs
and automatic generation require canonical routing in both releases. Otherwise
use a provisioned legacy selector and pinned-valid input; do not synthesize a
named format or upgrade the request. An advertised 3.2 legacy reference's density
constraints still apply when a 3.1 request treats pixel_ratio as an opaque
extension: the old request cannot establish a 2x parameterized binding by adding
that field. An incompatible binding is a fixture gap, not producer failure.

The reverse direction retains the older catalog's parameter rules. A 3.1
reference cannot establish density through an omitted or opaque pixel_ratio
field. Actual named-format requirements still apply: the published 3.1 narrowing
rule uses an any-value baseline only where the projected legacy requirements
impose no constraint. A provisioned, live-valid 3.2 target at 2x can
therefore match a 3.1 reference with no ratio, even if the old payload carries
an opaque ratio extension. The resolver does not union property sets or invent
a 1x default for that older catalog. The operator must still provision a valid
named-format mapping and input for the selected account.

Local schema diagnostics display at most eight AJV error entries and 2048
escaped characters. Control characters are escaped for display; producer
catalogs and failed validation outcomes remain unchanged.

Read the selected capabilities schema's format reference and selected build request
selector. A 3.2 recipe normally binds the advertised capability ID; a provisioned legacy selector remains supported when the selected request declares it. A 3.1 recipe must supply
an existing schema-valid `target_format_id` and assert that its discovered or
provisioned named format maps to every matched catalog route. The resolver never
constructs a named format from a capability ID. Missing legacy capability IDs are
legal. Without a provisioned legacy selector there is a coverage gap; an unknown
extra `target_capability_id` is not a valid 3.1 routing contract. Automatic generation
is restricted to capability-ID routing. Unknown 3.1 canonical kinds remain intact
as unsupported routes while resolution continues to understood routes. Older
catalogs do not acquire 3.2 ID-pattern or operations-field producer requirements.

Transformer-only recipes need no dummy brief/source manifest. Provision valid live
configuration and matching transformer output_capability_ids (3.2) or
output_format_ids (legacy). Recipe messages are trusted operator-authored input and
remain exactly as supplied; banning a brief would not prevent a dishonest fixture
author from biasing other input content. Credential-key and URL checks reject known
aliases but cannot prove opaque values or custom encodings secret-free. Operators
must provision non-secret fixture content. A malformed recipe throws an authoring
error after the runner closes any receiver/connections it owns.


An explicit legacy selector recipe is also supported on newer versions that retain
`target_format_id`; bind exactly one selector. Recipes cannot override
`canonical_formats_only: true` or contradict an advertised `v1_format_ref` pairing.
Reference agent URLs use existing canonicalization, and declared dimensions/duration
must agree. Incompatible pairs are unavailable; continue to another usable route.


Resolution certifies preparation of the selected route/input, not complete catalog
conformance. Unknown legacy kinds remain unvalidated local unsupported routes;
the consuming storyboard must retain its required whole-response discovery schema
validation. A standalone boundary step grades its selected probe, not unrelated
catalog metadata. The evaluator storyboard keeps that independent required check.


The provisioned brief is sent as `build_creative.message` to the agent under test,
where its model may read it as instructions. Author ordinary creative direction;
do not include instructions about evaluator behavior or expected test verdicts.
An explicit runner `test_kit` overrides the storyboard's declared kit as a whole:
include recipes in that override when also supplying auth. Hosted auth defaults
preserve recipes explicitly supplied by the operator; they do not merge missing
recipes from a separately declared brand kit.

The normal hosted HTTP/UI flow does not expose arbitrary recipe uploads. Use trusted
programmatic runner options or the local CLI for operator-provisioned recipes.

The preparer checks the selected route/input binding. It does not certify all
unselected recipe matches or remote account entitlements; narrow the operator
match predicates when an input is valid for only one route.
