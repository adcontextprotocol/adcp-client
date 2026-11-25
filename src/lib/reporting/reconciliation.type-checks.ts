import type {
  ExpectedReportingBuyCoverage,
  ExpectedReportingCoverage,
  ExpectedReportingMembership,
  ExpectedReportingPeriod,
  ExpectedReportingSellerPackageMembership,
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
declare const buyCoverage: ExpectedReportingBuyCoverage;

const membership: ExpectedReportingMembership = { kind: 'media_buy_ids' };
export const explicitMembershipPeriod: ExpectedReportingPeriod = {
  ...base,
  membership,
  mediaBuyIds: ['buy-1'],
  coverage: fullCoverage,
  verificationProfile: 'native_commit',
};

export function fixedBuyPeriod(
  membership: Extract<ExpectedReportingMembership, { kind: 'media_buy_ids' }>
): ExpectedReportingPeriod {
  return {
    ...base,
    membership,
    mediaBuyIds: ['buy-1'],
    coverage: fullCoverage,
    verificationProfile: 'native_commit',
  };
}

declare const sellerPackageMembership: ExpectedReportingSellerPackageMembership;
export const sellerPackagePeriod: ExpectedReportingPeriod = {
  ...base,
  membership: sellerPackageMembership,
  mediaBuyIds: ['buy-1'],
  coverage: buyCoverage,
  verificationProfile: 'native_commit',
};

export function membershipFromPeriod(period: ExpectedReportingPeriod): ExpectedReportingMembership | undefined {
  return period.membership;
}
