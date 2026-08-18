import { z } from 'zod';
import { BiddingPolicySchema as GeneratedBiddingPolicySchema } from '../types/schemas.generated';

const BIDDING_CONTROL_KEYS = ['automatic', 'bid_amount', 'max_bid', 'cost_per', 'roas'] as const;

/**
 * Generated structure plus the cross-field requirements from the AdCP 3.2
 * bidding-policy contract. Unknown extension fields retain the generated
 * schema's passthrough behavior, but do not count as a bidding control.
 */
export const BiddingPolicySchema = GeneratedBiddingPolicySchema.superRefine((policy, ctx) => {
  const presentControls = BIDDING_CONTROL_KEYS.filter(key => policy[key] !== undefined);

  if (presentControls.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'bidding policy must contain at least one bidding control',
    });
  }

  if (policy.automatic === true && presentControls.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automatic'],
      message: 'automatic must be the only bidding control',
    });
  }

  const positiveValues = [
    { path: ['bid_amount'], value: policy.bid_amount },
    { path: ['max_bid'], value: policy.max_bid },
    { path: ['cost_per', 'amount'], value: policy.cost_per?.amount },
    { path: ['roas', 'value'], value: policy.roas?.value },
  ] as const;
  for (const { path, value } of positiveValues) {
    if (value !== undefined && value <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: 'must be greater than zero',
      });
    }
  }

  if (
    policy.bid_amount !== undefined &&
    (policy.max_bid !== undefined || policy.cost_per !== undefined || policy.roas !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bid_amount'],
      message: 'bid_amount cannot be combined with max_bid, cost_per, or roas',
    });
  }

  if (policy.cost_per !== undefined && policy.roas !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['roas'],
      message: 'cost_per and roas cannot be combined',
    });
  }
});
