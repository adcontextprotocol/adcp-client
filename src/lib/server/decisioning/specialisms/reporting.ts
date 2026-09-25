import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { AdcpToolMap } from '../../create-adcp-server';
import type { ReportingDeliveryCapabilities } from '../../../types/tools.generated';

type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

/**
 * Reliable Reporting Core platform surface.
 *
 * Adopters normally receive this object from
 * `createReliableReportingService(...).install(platform)`. Keeping reporting
 * separate from `SalesPlatform.getMediaBuyDelivery` lets the framework route
 * exact ledger revisions without replacing an adopter's ordinary live
 * delivery handler.
 *
 * @public
 */
export interface ReliableReportingPlatform<TCtxMeta = Record<string, unknown>> {
  /** Capability document derived from the reporting components installed. */
  readonly capabilities: ReportingDeliveryCapabilities;

  /** Snapshot-stable reads from the authoritative reporting ledger. */
  getReportingStatus(
    request: AdcpToolMap['get_reporting_status']['params'],
    context: Ctx<TCtxMeta>
  ): Promise<AdcpToolMap['get_reporting_status']['result']>;

  /** Exact immutable revision reads; requests must carry reporting_revision_id. */
  getMediaBuyDelivery(
    request: AdcpToolMap['get_media_buy_delivery']['params'],
    context: Ctx<TCtxMeta>
  ): Promise<AdcpToolMap['get_media_buy_delivery']['result']>;

  /** Present only when authenticated consumer identity resolution is installed. */
  syncReportingStatus?(
    request: AdcpToolMap['sync_reporting_status']['params'],
    context: Ctx<TCtxMeta>
  ): Promise<AdcpToolMap['sync_reporting_status']['result']>;

  /** Present only for reconciled-billing offerings with authenticated consumer identity. */
  syncReportingReceipts?(
    request: AdcpToolMap['sync_reporting_receipts']['params'],
    context: Ctx<TCtxMeta>
  ): Promise<AdcpToolMap['sync_reporting_receipts']['result']>;

  /**
   * The identity `syncReportingStatus` deposits a receipt for, exposed so the
   * framework can scope `sync_reporting_status` replay by the same value the
   * receipt is recorded under. Present exactly when `syncReportingStatus` is.
   *
   * Without it the framework falls back to the caller's credential identity,
   * which is wrong whenever an adopter maps two operator seats sharing one
   * OAuth `client_id` to different reporting consumers: the second seat would
   * be served the first's cached response and deposit nothing.
   */
  readonly resolveConsumerId?: (context: Ctx<TCtxMeta>) => string | Promise<string>;
}
