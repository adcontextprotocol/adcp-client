# Compiling vendor macros to AdCP universal macros

`compileUniversalMacroTemplate` converts a caller-selected source dialect into
canonical AdCP universal macros. It is the inverse-side companion to
`translateUniversalMacros`, which converts canonical AdCP macros to native
seller or ad-server syntax at delivery time.

The SDK intentionally does not contain vendor guesses. Applications own a
versioned registry of vendor mappings and the evidence that supports each
mapping. They select a dialect from trusted context—such as an explicitly
declared vendor or a documented tracker hostname—and pass its exact mappings to
the compiler.

```typescript
import { compileUniversalMacroTemplate } from '@adcp/sdk/substitution';

const result = compileUniversalMacroTemplate({
  template: 'https://pixel.vendor.example/i?device={{DEVICE}}',
  source_dialect: 'example-vendor',
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

Do not create a global mapping based only on a token's spelling. A token such as
`{{USER_ID}}` may mean a device advertising identifier for one vendor, a browser
cookie for another, and an account identifier for a third. Scope every mapping
to its source dialect and keep the supporting vendor documentation with the
registry entry.
