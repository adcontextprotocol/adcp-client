import { z } from 'zod';
import { CanonicalBudgetAllocationSchema as GeneratedCanonicalBudgetAllocationSchema } from '../types/schemas.generated';

/** Canonical allocation shape with the seller-optimized non-empty invariant. */
export const CanonicalBudgetAllocationSchema = GeneratedCanonicalBudgetAllocationSchema.superRefine(
  (allocation, ctx) => {
    if (allocation.mode === 'seller_optimized' && allocation.optimization_goals.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optimization_goals'],
        message: 'seller_optimized allocation requires at least one optimization goal',
      });
    }
  }
);
