import type { CreativeApprovalStatus, ListCreativesResponse } from '../lib/types/tools.generated';

type ListedCreative = ListCreativesResponse['creatives'][number];
type Assignments = NonNullable<ListedCreative['assignments']>;
type AssignedPackage = NonNullable<Assignments['assigned_packages']>[number];

declare const assignment: AssignedPackage;

const packageId: string = assignment.package_id;
const assignedDate: string = assignment.assigned_date;
const mediaBuyId: string | undefined = assignment.media_buy_id;
const approvalStatus: CreativeApprovalStatus | undefined = assignment.approval_status;
const rejectionReason: string | undefined = assignment.rejection_reason;
const approvalScopes: AssignedPackage['approval_scopes'] = assignment.approval_scopes;
const indicators: AssignedPackage['indicators'] = assignment.indicators;

void [packageId, assignedDate, mediaBuyId, approvalStatus, rejectionReason, approvalScopes, indicators];
