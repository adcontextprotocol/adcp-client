import { z } from 'zod';
import { nonemptyArray } from '../lib/validation/nonempty-array';
import { TargetingOverlayKeys, TargetingOverlaySupportKeys, type AssetVariant, type DaypartTarget } from '../lib';
import type { AssetVariant as TypesAsset, TargetingOverlay, TargetingOverlaySupport } from '../lib/types';
import { AssetVariantSchema, VideoBriefAssetSchema, type AssetVariant as SchemaAsset } from '../lib/schemas';

type Assert<T extends true> = T;
type _AllOverlayKeys = Assert<
  Exclude<keyof TargetingOverlay, (typeof TargetingOverlayKeys)[number]> extends never ? true : false
>;
type _AllSupportKeys = Assert<
  Exclude<keyof TargetingOverlaySupport, (typeof TargetingOverlaySupportKeys)[number]> extends never ? true : false
>;
declare const parsed: z.output<typeof AssetVariantSchema>;
const root: AssetVariant = parsed;
const types: TypesAsset = parsed;
const schemaExport: SchemaAsset = parsed;
const video: AssetVariant = VideoBriefAssetSchema.parse({
  asset_type: 'video_brief',
  segments: [{ order: 1, duration_ms: 1, prompt: 'x' }],
});
const hours: DaypartTarget = { days: ['monday'], start_hour: 6, end_hour: 10 };
const minutes: DaypartTarget = { days: ['monday'], start_time: '19:30', end_time: '23:00' };
// @ts-expect-error Dayparts require both endpoints.
const partial: DaypartTarget = { days: ['monday'], start_hour: 6 };
// @ts-expect-error Dayparts require one complete time form.
const absent: DaypartTarget = { days: ['monday'] };
const mixedTimes = { start_hour: 6, end_hour: 10, start_time: '19:30', end_time: '23:00' };
// @ts-expect-error Clock forms cannot be mixed even through structural assignment.
const mixed: DaypartTarget = { days: ['monday'], ...mixedTimes };
function duration(daypart: DaypartTarget): number {
  if (daypart.start_hour !== undefined) return daypart.end_hour - daypart.start_hour;
  return daypart.end_time.length + daypart.start_time.length;
}
void [root, types, schemaExport, video, hours, minutes, partial, absent, mixed, duration];

const boundedNonempty = nonemptyArray(z.string()).max(2);
const boundedOutput: [string, ...string[]] = boundedNonempty.parse(['value']);
const optionalNonempty = boundedNonempty.optional();
const optionalOutput: [string, ...string[]] | undefined = optionalNonempty.parse(undefined);
void [boundedOutput, optionalOutput];
