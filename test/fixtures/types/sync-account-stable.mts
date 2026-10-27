import type { AccountStore, SyncAccountsResultRow } from '@adcp/sdk/server';
interface ExtendedRow extends SyncAccountsResultRow {
  upstreamId?: string;
}
const row: ExtendedRow = {
  account_id: 'account-3466',
  account: { account_id: 'account-3466' },
  brand: { domain: 'brand.example' },
  operator: 'agency.example',
  action: 'updated',
  status: 'active',
  operator_unit: { id: 'seat' },
  revision: 3,
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  identity_change: { status: 'pending_approval', requested_operator_identity: { operator: 'destination.example' } },
};
const brand: string = row.brand.domain;
const operator: string = row.operator;
const status: string = row.status;
const upsert: NonNullable<AccountStore['upsert']> = async () => [row];
void [brand, operator, status, upsert];
