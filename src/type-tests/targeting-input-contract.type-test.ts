import {
  applyTargetingInput,
  hasTargetingClears,
  resolveTargetingInput,
  type BuyProductsRequest,
  type ControlMediaBuyRequest,
  type CreateTargetingInput,
  type ProposalPurchase,
  type ResolvedTargetingInput,
  type UpdateTargetingInput,
} from '../lib';
import * as server from '../lib/server';
import * as mediaBuy from '../lib/media-buy';
import { TargetingOverlayInputSchema, TargetingOverlaySchema } from '../lib/schemas';

type CreatePath = BuyProductsRequest['purchases'][number]['targeting_overlay'];
type UpdatePath = NonNullable<ControlMediaBuyRequest['packages']>[number]['targeting_overlay'];
type Input = NonNullable<CreatePath>;
type Snapshot = NonNullable<ProposalPurchase['targeting_overlay']>;
type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _CreateAliasMatchesRequest = Assert<Equal<CreateTargetingInput, CreatePath>>;
type _UpdateAliasMatchesRequest = Assert<Equal<UpdateTargetingInput, UpdatePath>>;
declare const input: Input;
declare const prior: Snapshot | undefined;

const createInput: CreateTargetingInput = input;
const updateInput: UpdateTargetingInput = input;
const omittedCreate: CreateTargetingInput = undefined;
const omittedUpdate: UpdateTargetingInput = undefined;
const serverCreate: server.CreateTargetingInput = createInput;
const serverUpdate: server.UpdateTargetingInput = updateInput;
const mediaCreate: mediaBuy.CreateTargetingInput = createInput;
const mediaUpdate: mediaBuy.UpdateTargetingInput = updateInput;

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
const pickedTargeting = TargetingOverlaySchema.pick({ geo_countries: true });
const omittedTargeting = TargetingOverlayInputSchema.omit({ geo_countries: true });
const extendedTargeting = TargetingOverlaySchema.extend({ seller_extension: TargetingOverlaySchema });
const targetingShape = TargetingOverlayInputSchema.shape;

// @ts-expect-error Resolution removes top-level null commands from the result.
const invalidResolved: NonNullable<typeof resolved> = { language: null };
// @ts-expect-error Replacement keeps the schema's nonempty array contract.
applyTargetingInput<Snapshot>(undefined, { language: [] });
// @ts-expect-error Device platforms are arrays even without a prior overlay.
applyTargetingInput<Snapshot>(undefined, { device_platform: 'ios' });

void [
  createInput,
  updateInput,
  omittedCreate,
  omittedUpdate,
  serverCreate,
  serverUpdate,
  mediaCreate,
  mediaUpdate,
  strictResolved,
  patched,
  seeded,
  cleared,
  noPatch,
  hasClears,
  serverResolve,
  serverApply,
  serverHas,
];
void [mediaResolve, mediaApply, mediaHas, invalidResolved];
void [pickedTargeting, omittedTargeting, extendedTargeting, targetingShape];
