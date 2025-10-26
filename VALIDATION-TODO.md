# TODO: Add Runtime Schema Validation

## Current State
- ✅ Zod schemas exist in `src/lib/types/schemas.generated.ts`
- ✅ Schemas are correct per AdCP 2.2.0 spec
- ❌ Schemas are never used for validation
- ❌ Not all response types have schemas (e.g., GetProductsResponseSchema)

## Problem
Agent responses are not validated against AdCP schemas at runtime:
- Invalid products pass through silently  
- UI has to implement its own validation (which was incorrect)
- No enforcement of spec compliance

## Solution Needed
1. Generate missing response schemas (GetProductsResponse, etc.)
2. Use schemas in ResponseValidator or TaskExecutor
3. Validate responses before returning to caller
4. Log schema violations for observability

## Files to Update
- `src/lib/core/ResponseValidator.ts` - Add schema validation
- `src/lib/core/TaskExecutor.ts` - Call validator with schemas  
- `scripts/generate-types.ts` - Ensure all response types have schemas
- `src/lib/types/schemas.generated.ts` - Verify completeness

## Benefits
- Catch invalid agent responses early
- Remove need for UI-side validation
- Better error messages for spec violations
- Type safety at runtime, not just compile time
