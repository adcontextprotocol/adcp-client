import type {
  ExpectedReportingBuyCoverage,
  ExpectedReportingCoverage,
  ExpectedReportingMembership,
  ExpectedReportingPeriod,
} from './reconciliation';

type Assert<T extends true> = T;

export type PackagePinsAreRejected = Assert<
  ExpectedReportingCoverage extends ExpectedReportingBuyCoverage ? false : true
>;
export type PackageIdsRemainReadable = Assert<
  ExpectedReportingBuyCoverage['package_ids'] extends undefined ? true : false
>;

declare const base: Omit<
  ExpectedReportingPeriod,
  'membership' | 'mediaBuyIds' | 'coverage' | 'verificationProfile' | 'canonicalization'
>;
declare const fullCoverage: ExpectedReportingCoverage;

const membership: ExpectedReportingMembership = { kind: 'media_buy_ids' };
export const explicitMembershipPeriod: ExpectedReportingPeriod = {
  ...base,
  membership,
  mediaBuyIds: ['buy-1'],
  coverage: fullCoverage,
  verificationProfile: 'native_commit',
};
