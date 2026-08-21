# Compiling vendor macros to AdCP universal macros

`compileUniversalMacroTemplate` converts a caller-selected source dialect into
canonical AdCP universal macros. For macros in URL query-parameter values, it
pairs with `translateUniversalMacros`, which converts canonical AdCP macros to
native seller or ad-server syntax at delivery time. Compilation can also cover
paths, keys, fragments, and creative markup, but those positions require a
renderer that supports them; `translateUniversalMacros` intentionally does not.

The SDK intentionally does not contain vendor guesses. Applications own a
versioned registry of vendor mappings and the evidence that supports each
mapping. They select a dialect from trusted context—such as an explicitly
declared vendor or a documented tracker hostname—and pass its exact mappings to
the compiler. They also declare the syntaxes used by that dialect so scanning is
limited to the selected grammar. If a host language uses the same delimiters,
compile only the relevant field or provide exact mappings for every candidate.

```typescript
import { compileUniversalMacroTemplate } from '@adcp/sdk/substitution';

const result = compileUniversalMacroTemplate({
  template: 'https://pixel.vendor.example/i?device={{DEVICE}}',
  source_dialect: 'example-vendor',
  source_syntaxes: ['double_brace'],
  mappings: [
    {
      source_token: '{{DEVICE}}',
      universal_macro: '{DEVICE_ID}',
      source_dialect: 'example-vendor',
      semantic: 'resettable_device_advertising_id',
      documentation: [
        {
          title: 'Example vendor macro documentation',
          url: 'https://vendor.example/macros',
          retrieved_at: '2026-08-21',
        },
      ],
    },
  ],
});

if (!result.publishable) {
  // Keep the source artifact and surface result.diagnostics for resolution.
  throw new Error('The template has unresolved or unsupported macros');
}
```

The result retains the original and canonical templates, one record per macro
occurrence with source offsets, documentation and runtime requirements, and
structured diagnostics. Unknown tokens remain unchanged and make the artifact
unpublishable. Replacement is single-pass, so a mapping cannot trigger a second
round of macro expansion.

`source_syntaxes` is required even when `mappings` is empty. It controls which
unknown token shapes are scanned. The built-in values are `double_brace`
(`{{NAME}}`), `percent` (`%%NAME%%`), `dollar_brace` (`${NAME}`), `bracket`
(`[NAME]`), and `adcp` (`{NAME}`). Bracket and single-brace discovery is limited
to upper-snake names, avoiding collisions with IPv6 literals, URL array keys,
lowercase URI templates, and JavaScript/CSS blocks. Exact configured mappings
still have to match their declared syntax. A dialect that uses lowercase or
otherwise non-upper-snake bracket/single-brace tokens must declare those braces
as a custom scanner; this ensures an unknown or misspelled token cannot pass
through as ordinary text. Dialects with other delimiters work the same way:

```typescript
source_syntaxes: [{ name: 'hash', open: '##', close: '##' }];
// Occurrences report syntax: 'custom:hash'.

source_syntaxes: [{ name: 'lower-bracket', open: '[', close: ']' }];
// Discovers both mapped [status] and unknown [stauts] tokens.
```

Supported `{ADCP_MACRO}` tokens are not automatically trusted in a vendor
artifact. Set `allow_canonical_macros: true` only when trusted context proves
that the input can already contain canonical AdCP macros. Upper-snake
single-brace tokens are always surfaced because leaving one untouched would
make it active during delivery translation. Unsupported names remain unknown
even with the opt-in. Declare `adcp` as a source syntax when a vendor itself uses
single braces. An exact mapping takes precedence when a vendor token collides
with canonical spelling.

The complete selected-dialect mapping set is validated before compilation,
including unused entries. By default every mapping needs at least one valid
HTTP(S) documentation reference. Universal macro targets, documentation, and
runtime requirement records are also checked at runtime so JavaScript callers
receive the same fail-closed behavior as TypeScript callers.

Runtime requirements gate `publishable`. A caller must attest each satisfied
`{ kind, value? }` pair through `satisfied_requirements`; otherwise the source
token remains unchanged and an `unsatisfied_requirement` diagnostic is
returned. The compiler verifies the attestation, while the caller remains
responsible for actually performing the documented setup.

Do not create a global mapping based only on a token's spelling. A token such as
`{{USER_ID}}` may mean a device advertising identifier for one vendor, a browser
cookie for another, and an account identifier for a third. Scope every mapping
to its source dialect and keep the supporting vendor documentation with the
registry entry.
