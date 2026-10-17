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
and config; it cannot replace evaluator, account, auth or trust material. Use a
specific capability-ID predicate when a kind-only predicate is insufficient.
Full manifest schema validation runs before dispatch. Config requires a transformer;
provision its live parameter values and an appropriate output route. Library IDs,
transformers, source asset URLs, and account authorization are operator fixtures.

The automatic generation path requires a unique advertised build route,
supports_generation, technical_requirements_complete, a known non-custom kind,
empty params, and no unhandled declaration metadata (only display_name is inert).
It supplies the brief and `{format_kind: selectedKind, assets: {}}`. Otherwise a
matched recipe is required; omitted catalog operations still mean build and
missing legacy IDs remain discoverable but unaddressable. Non-build entries and
unsatisfiable routes do not prevent selecting a later satisfiable route.

Resolved records use fixture_type `creative_format`, the prefix as handle, exact
matched requirements, and seller_ids.capability_id. Unsatisfied whole runs have a
fixture_unsatisfied coverage gap and zero executed security validations; standalone
steps use skip_reason fixture_unsatisfied and canonical not_applicable, with detail
naming creative_format:<prefix>. This does not establish producer nonconformance
or passing security coverage. Malformed declarations/recipes throw. Routed and
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
