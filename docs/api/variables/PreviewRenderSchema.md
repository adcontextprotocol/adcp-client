[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PreviewRenderSchema

# Variable: PreviewRenderSchema

> `const` **PreviewRenderSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `render_id`: `ZodString`; `output_format`: `ZodLiteral`\<`"url"`\>; `preview_url`: `ZodString`; `role`: `ZodString`; `dimensions`: `ZodOptional`\<`ZodObject`\<\{ `width`: `ZodNumber`; `height`: `ZodNumber`; \}, `$strip`\>\>; `embedding`: `ZodOptional`\<`ZodObject`\<\{ `recommended_sandbox`: `ZodOptional`\<`ZodString`\>; `requires_https`: `ZodOptional`\<`ZodBoolean`\>; `supports_fullscreen`: `ZodOptional`\<`ZodBoolean`\>; `csp_policy`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `render_id`: `ZodString`; `output_format`: `ZodLiteral`\<`"html"`\>; `preview_html`: `ZodString`; `role`: `ZodString`; `dimensions`: `ZodOptional`\<`ZodObject`\<\{ `width`: `ZodNumber`; `height`: `ZodNumber`; \}, `$strip`\>\>; `embedding`: `ZodOptional`\<`ZodObject`\<\{ `recommended_sandbox`: `ZodOptional`\<`ZodString`\>; `requires_https`: `ZodOptional`\<`ZodBoolean`\>; `supports_fullscreen`: `ZodOptional`\<`ZodBoolean`\>; `csp_policy`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `render_id`: `ZodString`; `output_format`: `ZodLiteral`\<`"both"`\>; `preview_url`: `ZodString`; `preview_html`: `ZodString`; `role`: `ZodString`; `dimensions`: `ZodOptional`\<`ZodObject`\<\{ `width`: `ZodNumber`; `height`: `ZodNumber`; \}, `$strip`\>\>; `embedding`: `ZodOptional`\<`ZodObject`\<\{ `recommended_sandbox`: `ZodOptional`\<`ZodString`\>; `requires_https`: `ZodOptional`\<`ZodBoolean`\>; `supports_fullscreen`: `ZodOptional`\<`ZodBoolean`\>; `csp_policy`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:738](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L738)
