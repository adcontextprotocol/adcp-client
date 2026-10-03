import type { DecisioningPlatform } from '../../server/decisioning/platform';
import type { ReliableReportingPlatform } from '../../server/decisioning/specialisms/reporting';
import type { ReliableReportingServiceV1 } from './index';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// `install()` must hand back the caller's own platform type, not the base
// interface. `createAdcpServerFromPlatform` enforces specialism-required tools
// off the literal `capabilities.specialisms` tuple and the adopter's own
// members, so widening here silently disables that enforcement downstream.
declare const service: ReliableReportingServiceV1;

interface AdopterPlatform extends DecisioningPlatform<{ tenant: string }> {
  capabilities: { specialisms: ['sales-non-guaranteed']; config: { tenant: string } };
  sales: { getMediaBuyDelivery: () => Promise<never> };
  adopterOwnedSeam: { rebuildDenominator(): void };
}

declare const adopterPlatform: AdopterPlatform;
const installed = service.install(adopterPlatform);

export type InstallPreservesAdopterMembers = Assert<
  Equal<(typeof installed)['adopterOwnedSeam'], AdopterPlatform['adopterOwnedSeam']>
>;
export type InstallPreservesLiteralSpecialisms = Assert<
  Equal<(typeof installed)['capabilities']['specialisms'], ['sales-non-guaranteed']>
>;
export type InstallPreservesConfigType = Assert<
  Equal<(typeof installed)['capabilities']['config'], { tenant: string }>
>;
export type InstallProjectsReporting = Assert<
  Equal<(typeof installed)['reporting'], ReliableReportingPlatform<Record<string, unknown>>>
>;
// The base interface erases all of the above — guard against a regression to it.
export type InstallIsNotWidened = Assert<
  Equal<Equal<typeof installed, DecisioningPlatform<{ tenant: string }>>, false>
>;
