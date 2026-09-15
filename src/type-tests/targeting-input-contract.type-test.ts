import {
  applyTargetingInput,
  hasTargetingClears,
  resolveTargetingInput,
  type BuyProductsRequest,
  type ProposalPurchase,
  type ResolvedTargetingInput,
} from '../lib';
import * as server from '../lib/server';
import * as mediaBuy from '../lib/media-buy';

type Input = NonNullable<BuyProductsRequest['purchases'][number]['targeting_overlay']>;
type Snapshot = NonNullable<ProposalPurchase['targeting_overlay']>;
declare const input: Input;
declare const prior: Snapshot | undefined;

const resolved: ResolvedTargetingInput<Input> | undefined = resolveTargetingInput(input);
const strictResolved: Snapshot | undefined = resolved;
const patched: Snapshot | undefined = applyTargetingInput(prior, input);
// Explicit overlay typing preserves the public helper's existing inference
// contract when there is no prior value from which to infer TOverlay.
const seeded: Snapshot | undefined = applyTargetingInput<Snapshot>(undefined, input);
const cleared: Snapshot | undefined = applyTargetingInput(prior, null);
const noPatch: Snapshot | undefined = applyTargetingInput(prior, undefined);
const hasClears: boolean = hasTargetingClears(input);

const serverResolve: typeof resolveTargetingInput = server.resolveTargetingInput;
const serverApply: typeof applyTargetingInput = server.applyTargetingInput;
const serverHas: typeof hasTargetingClears = server.hasTargetingClears;
const mediaResolve: typeof resolveTargetingInput = mediaBuy.resolveTargetingInput;
const mediaApply: typeof applyTargetingInput = mediaBuy.applyTargetingInput;
const mediaHas: typeof hasTargetingClears = mediaBuy.hasTargetingClears;

// @ts-expect-error Resolution removes top-level null commands from the result.
const invalidResolved: NonNullable<typeof resolved> = { language: null };
// @ts-expect-error Replacement keeps the schema's nonempty array contract.
applyTargetingInput<Snapshot>(undefined, { language: [] });
// @ts-expect-error Device platforms are arrays even without a prior overlay.
applyTargetingInput<Snapshot>(undefined, { device_platform: 'ios' });

void [strictResolved, patched, seeded, cleared, noPatch, hasClears, serverResolve, serverApply, serverHas];
void [mediaResolve, mediaApply, mediaHas, invalidResolved];
