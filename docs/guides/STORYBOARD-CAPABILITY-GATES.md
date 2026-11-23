# Storyboard capability gates

A storyboard, or one of its phases, can declare which capabilities an agent
must advertise in `get_adcp_capabilities` for it to apply. When the agent does
not satisfy the gate, the runner grades the storyboard or phase
`not_applicable` instead of running it. This page lists the gate forms the
`@adcp/sdk` runner understands. `Storyboard.requires_capability` in
`src/lib/testing/storyboard/types.ts` holds the normative detail.

## Where gates go

| Field                                  | Scope           | Composition                                        |
| -------------------------------------- | --------------- | -------------------------------------------------- |
| `requires_capability`                  | storyboard root | one predicate                                      |
| `requires_all_capabilities`            | storyboard root | two or more predicates, all must pass; fail closed |
| `phases[].requires_capability`         | one phase       | one predicate; a skipped phase grades its steps `not_applicable` |

A predicate is either a path predicate or an `any_of` group.

## Which response gates read

Gates read the agent profile's `get_adcp_capabilities` response. On a run pinned
to a prerelease (for example `3.3.0-rc.3`), discovery first goes out unpinned.
When the agent lists that exact prerelease in `adcp.supported_versions`, the
runner asks again at the pin and builds the profile from the pinned answer, so
preview-only `experimental_features` gates apply. An agent that does not list
the prerelease is profiled from its unpinned answer.

## Path predicates

`path` is a dotted path into the raw `get_adcp_capabilities` response. Each
path predicate declares exactly one matcher.

| Matcher            | Passes when                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `equals: V`        | the value is declared and equals `V`                                           |
| `present: true`    | the value is present (not `undefined` or `null`)                               |
| `present: false`   | the value is absent                                                            |
| `contains: V`      | the value is an array with an entry that matches `V`                           |
| `not_contains: V`  | the value is an array with no entry that matches `V`                           |

An array entry matches `V` by structural JSON equality when `V` is a scalar or
an array. When `V` is an object, an entry matches when it is an object that
carries every key of `V` with an equal value. The entry may carry other keys.
Activation-method entries are open objects, so
`contains: { pattern: sync_audiences }` matches
`{ pattern: "sync_audiences", note: "crm only" }`.

`equals`, `contains` and `not_contains` resolve a schema default for an absent
path when the parent object is present. `present` never does, because absence
is what it tests.

## `any_of` groups

An `any_of` group lists two or more predicates, each a path predicate or a
nested `any_of` group. The group passes when at least one entry passes. It
cannot be combined with `path` or a matcher on the same object. It can appear
anywhere a predicate can, including as an entry of `requires_all_capabilities`.

This phase runs only for a seller that accepts inline audience member pushes:
`supported_activation_methods` is absent, as in 3.2, or it lists an entry
whose `pattern` is `sync_audiences`.

```yaml
phases:
  - id: audience_binding
    requires_capability:
      any_of:
        - path: media_buy.audience_targeting.supported_activation_methods
          present: false
        - path: media_buy.audience_targeting.supported_activation_methods
          contains: { pattern: sync_audiences }
```

When no entry passes, the skip detail names every alternative and why it
failed.

## Without raw capabilities

When the runner has no raw capabilities payload, it falls back the same way
for each path predicate, including each entry of an `any_of` group:

- `equals` gates skip when the agent does not advertise `get_adcp_capabilities`.
- Other matchers pass, except for the raw opt-ins `oauth.supported equals true`
  and `experimental_features contains trusted_match.core`.
- `requires_all_capabilities` fails closed: every predicate in it skips.

## Runner support

`any_of` groups and object-subset `contains` / `not_contains` ship in
`@adcp/sdk` releases after `17.0.0-beta.25`. Older runners keep working with
older bundles, which do not use either form. A bundle that uses them needs a
runner that supports them:

- **`any_of` on an older runner.** The predicate has no `path`. With raw
  capabilities available, the runner throws while resolving the missing path,
  so the storyboard errors instead of being graded. Without raw capabilities,
  it treats the gate as satisfied and runs the phase or storyboard.
- **Object-subset `contains` on an older runner.** Objects match only by exact
  structural equality, so an entry with extra keys does not match and the gate
  skips more often than intended.

The runner's loader validates every `any_of` group, and every
`requires_all_capabilities` entry, when it loads a storyboard. Legacy singular
path gates keep their historical, unvalidated loading.
