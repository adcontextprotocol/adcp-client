"""Installed Python buyer inspecting files delivered by the TypeScript runtime."""

import asyncio
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from adcp import ADCPClient, AgentConfig
from adcp.reporting import ExpectedReportingPeriod, ReportingInspectionContext, reconcile_reporting
from adcp.reporting.canonical_json import canonical_json_utf8_v1
from adcp.reporting_inspection import ManifestReportingInspector, ReportingInspectionCode, ReportingInspectionError
from adcp.types import ComplyTestControllerRequest, GetAdcpCapabilitiesRequest, GetMediaBuyDeliveryRequest, GetReportingStatusRequest, Protocol


stage = "initialization"
class BuyerGateError(ValueError): pass

def require(condition, label):
    if not condition:
        raise BuyerGateError(label)


def wire(model):
    return model.model_dump(mode="json", exclude_none=True, exclude_unset=True)


class GcsReader:
    """Independent official provider client; exact scope from saved host grant."""
    def __init__(self, root):
        from google.cloud import storage
        from google.oauth2.credentials import Credentials
        self.grant = json.loads((root / 'gcs-grant.json').read_bytes())
        token_file = Path(os.environ['REPORTING_INTEROP_GCS_READER_TOKEN'])
        require(token_file.stat().st_mode & 0o777 == 0o600, 'private reader token mode')
        token = json.loads(token_file.read_bytes())
        expiry = datetime.fromisoformat(token['expires_at'])
        require(expiry.tzinfo is not None and expiry.timestamp() > datetime.now(timezone.utc).timestamp() + 300, 'reader token lifetime')
        self.client = storage.Client(project=os.environ['REPORTING_INTEROP_GCS_PROJECT'], credentials=Credentials(token=token['token']))
        self.calls = 0
        self.native = {}
        self.observed = {}

    def provider_denial_controls(self, resource):
        from google.cloud import storage
        from google.api_core.exceptions import Forbidden
        bucket = self.client.bucket(self.grant['bucket'])
        def denied(work, label):
            try: work()
            except Forbidden: return
            raise BuyerGateError(label)
        denied(lambda: bucket.blob(self.grant['outsideObjects'][0]).reload(timeout=15, retry=None), 'provider sibling prefix denied')
        for outside in self.grant['outsideObjects'][1:]:
            denied(lambda: bucket.blob(outside).reload(timeout=15, retry=None), 'neighboring provider prefix denied')
        denied(lambda: bucket.blob(self.grant['objectPrefix'] + 'reader-write-denied').upload_from_string(b'Owned write denial control', if_generation_match=0, timeout=15, retry=None), 'reader writes denied')
        location = wire(resource)['location']
        key = urlsplit(location).path.split('/', 2)[2]
        from google.auth.credentials import AnonymousCredentials
        from google.auth.transport.requests import AuthorizedSession
        from google.api_core.exceptions import Unauthorized
        credentials = AnonymousCredentials()
        anonymous = storage.Client(project=os.environ['REPORTING_INTEROP_GCS_PROJECT'], credentials=credentials,
                                   _http=AuthorizedSession(credentials, refresh_status_codes=()))
        try: anonymous.bucket(self.grant['bucket']).blob(key).reload(timeout=15, retry=None)
        except (Forbidden, Unauthorized) as error: self.anonymous_status = int(error.code)
        else: raise BuyerGateError('anonymous manifest denied')


    def bind_manifest(self, resource):
        value = wire(resource)
        self.native[value['location']] = value['native_version_ref']

    async def read(self, locator, *, base=None, max_bytes):
        uri = urljoin(base, locator) if base else locator
        parsed = urlsplit(uri)
        require(parsed.scheme == 'https' and parsed.netloc == 'storage.googleapis.com' and not parsed.query and not parsed.fragment and '%' not in parsed.path, 'private provider URI')
        bucket, key = parsed.path.lstrip('/').split('/', 1)
        require(bucket == self.grant['bucket'] and any(key.startswith(self.grant[name]) for name in ['objectPrefix', 'contractPrefix']), 'saved bucket and prefix')
        require(not any(part in ['', '.', '..'] for part in key.split('/')), 'private object path')
        self.calls += 1
        def get():
            from google.api_core.exceptions import NotFound
            generation = self.native.get(uri)
            blob = self.client.bucket(bucket).blob(key, generation=int(generation) if generation else None)
            if key.startswith(self.grant['objectPrefix']) and key.endswith('/1'):
                require(generation is not None, 'manifest native generation pinned')
            blob.reload(timeout=15, retry=None)
            self.observed[key] = int(blob.generation)
            if blob.metadata and 'adcp_reporting_tombstone' in blob.metadata:
                raise FileNotFoundError('Reporting object revoked')
            require(blob.size <= max_bytes, 'provider byte limit')
            try:
                body = blob.download_as_bytes(if_generation_match=blob.generation, start=0, end=max_bytes, raw_download=True, timeout=15, retry=None)
                require(len(body) <= max_bytes, 'returned provider byte limit')
                return body
            except NotFound as error:raise FileNotFoundError('Reporting generation unavailable') from None
        try:return await asyncio.wait_for(asyncio.to_thread(get), timeout=30)
        except Exception as error:
            from google.api_core.exceptions import NotFound
            if isinstance(error, NotFound):raise FileNotFoundError('Reporting generation unavailable') from None
            raise


class LostResponse(RuntimeError):
    pass


class CorruptFileReader:
    """Change one delivered row byte without changing its advertised hash."""

    def __init__(self, reader):
        self.reader = reader
        self.changed = False

    async def read(self, locator, *, base=None, max_bytes):
        body = await self.reader.read(locator, base=base, max_bytes=max_bytes)
        if urlsplit(urljoin(base, locator) if base else locator).path.endswith("/0"):
            self.changed = True
            return body[:-2] + bytes([body[-2] ^ 1]) + body[-1:]
        return body


class DropCommittedResponse:
    """Discard one real committed response, preserving the authenticated call."""

    def __init__(self, client):
        self.client = client
        self.receipt_ids = []

    async def get_reporting_status(self, request):
        return await self.client.get_reporting_status(request)

    async def sync_reporting_receipts(self, request):
        result = await self.client.sync_reporting_receipts(request)
        require(result.status.value == "completed", "receipt committed before response loss")
        self.receipt_ids = [item.reporting_receipt_id for item in request.receipts]
        raise LostResponse("committed receipt response intentionally discarded")


async def run(url, destination, fixture_root, mode):
    global stage
    fixture = json.loads((fixture_root / "evidence-v1.json").read_bytes())
    expected_rows = [json.loads(line) for line in (fixture_root / "resources/rows.jsonl").read_text().splitlines()]
    billing = mode == "billing"
    account = {"brand": {"domain": "reporting.example.test"}, "operator": "test.example", "sandbox": True}
    period = {key: fixture["revision"]["period"][key] for key in ("start", "end")}
    request = GetReportingStatusRequest.model_validate({"account": account, "view": "periods", "period": period})
    expected = ExpectedReportingPeriod(
        f"{mode}-files", 1, fixture["revision"]["report_definition_id"], "billing" if billing else "analytics",
        fixture["revision"]["reporting_profile"], tuple(fixture["revision"]["media_buy_ids"]),
        fixture["revision"]["period"]["start"], fixture["revision"]["period"]["end"],
    )
    config = AgentConfig(id="installed-ts-seller", name="installed-ts-seller", agent_uri=url,
                         protocol=Protocol.MCP, auth_token=os.environ["ADCP_INTEROP_BUYER_TOKEN"],
                         auth_header="Authorization", auth_type="bearer")
    scenario = f"reliable_reporting_{'reconciled_billing' if billing else 'managed_delivery'}_probe"
    reader = None
    async with ADCPClient(config, adcp_version=fixture["adcp_schema_version"]) as client:
        prepared = await client.comply_test_controller(ComplyTestControllerRequest.model_validate({
            "account": account, "scenario": scenario, "params": {"operation": "prepare"},
        }))
        require(prepared.status.value == "completed", "controller prepare")
        capabilities = await client.get_adcp_capabilities(GetAdcpCapabilitiesRequest())
        reporting_capabilities = capabilities.data.media_buy.reporting_delivery
        reader = GcsReader(destination)
        stage = "compressed_provider_control"
        compressed = await reader.read('https://storage.googleapis.com/' + reader.grant['bucket'] + '/' + reader.grant['compressedObject'], max_bytes=64)
        require(len(compressed) <= 64 and compressed.startswith(b'\x1f\x8b'), 'compressed provider bytes stay raw and bounded')
        status = await client.get_reporting_status(request)
        ledger = wire(status.data)
        require(len(ledger["periods"]) == len(ledger["revisions"]) == len(ledger["materializations"]) == 1, "closed scope")
        revision = status.data.revisions[0]
        require(revision.schema_sha256 == fixture['revision']['schema_sha256'] and revision.report_definition_sha256 == fixture['revision']['report_definition_sha256'], 'independently saved contract hashes')
        materialization = status.data.materializations[0]
        exact = await client.get_media_buy_delivery(GetMediaBuyDeliveryRequest.model_validate({
            "account": account, "reporting_revision_id": revision.reporting_revision_id,
        }))
        delivery = wire(exact.data)
        require(delivery["reporting_rows"] == expected_rows, "exact revision rows")
        binding = {"reporting_revision_id": revision.reporting_revision_id, "row_count": len(expected_rows),
                   "control_totals": ledger["revisions"][0]["control_totals"], "reporting_rows": delivery["reporting_rows"]}
        require(hashlib.sha256(canonical_json_utf8_v1(binding)).hexdigest() == revision.revision_content_sha256,
                "independent exact revision binding")
        stage = "provider_denial_controls"
        reader.provider_denial_controls(materialization.resource)
        reader.bind_manifest(materialization.resource)
        context = ReportingInspectionContext(status.data.periods[0], revision, materialization)
        stage = "inspection"
        observation = await ManifestReportingInspector(reader)(context)
        require(observation.row_count == len(expected_rows), "independent manifest row count")
        stage = "corruption"
        corrupt = CorruptFileReader(reader)
        try:
            await ManifestReportingInspector(corrupt)(context)
        except ReportingInspectionError as error:
            require(corrupt.changed and error.code == ReportingInspectionCode.OBJECT_DIGEST_MISMATCH,
                    "tampered delivered file rejected")
        else:
            raise ValueError("tampered delivered file was accepted")
        if billing:
            require(observation.canonical_content_digest.value == fixture["revision"]["canonical_content_digest"]["value"],
                    "independent canonical row digest")
        stage = "receipt"
        dropped = DropCommittedResponse(client)
        if billing:
            try:
                await reconcile_reporting(dropped, request, resource_reader=reader, expected_periods=[expected],
                                          reporting_capabilities=reporting_capabilities,
                                          now=datetime.now(timezone.utc))
            except LostResponse:
                require(len(dropped.receipt_ids) == 1, "one committed receipt")
            else:
                raise ValueError("receipt response loss was not exercised")
        else:
            result = await reconcile_reporting(client, request, expected_periods=[expected],
                                               reporting_capabilities=reporting_capabilities, now=datetime.now(timezone.utc))
            require(result.definitive and not result.submitted_receipts, "Managed Delivery reconciliation")
    # A new official client repairs from authoritative PostgreSQL state after
    # the lost response. The private reader and saved capability pins persist;
    # this is a client reconnect, not a fresh buyer or seller process.
    async with ADCPClient(config, adcp_version=fixture["adcp_schema_version"]) as client:
        stage = "reconnect"
        repaired = await reconcile_reporting(client, request, resource_reader=reader, expected_periods=[expected],
                                              reporting_capabilities=reporting_capabilities,
                                              now=datetime.now(timezone.utc))
        require(repaired.definitive and not repaired.submitted_receipts, "reconnect repair without duplicate submission")
        receipts = wire((await client.get_reporting_status(request)).data).get("receipts", [])
        require(len(receipts) == (1 if billing else 0), "durable receipt count")
        if billing:
            require(receipts[0]["reporting_receipt_id"] == dropped.receipt_ids[0] and receipts[0]["status"] == "accepted",
                    "exact committed receipt survives reconnect")
        stage = "revocation"
        revoked = await client.comply_test_controller(ComplyTestControllerRequest.model_validate({
            "account": account, "scenario": scenario, "params": {"operation": "revoke_access"},
        }))
        require(wire(revoked.data)["simulated"]["access_revoked"] is True, "runtime revocation")
        try:
            await reader.read(str(materialization.resource.location), max_bytes=1024 * 1024)
        except FileNotFoundError:
            # The SDK reader must refuse the revoked resource.
            pass
        else:
            raise ValueError("revoked resource remains readable")
        # Bypass the SDK tombstone reader for this control: old provider bytes
        # themselves must be gone, even while the reader's prefix IAM survives.
        from google.api_core.exceptions import NotFound
        reporting_objects = {key: generation for key, generation in reader.observed.items() if key.startswith(reader.grant['objectPrefix'])}
        require(len(reporting_objects) == 2, 'manifest and rows observed before revocation')
        for old_key, old_generation in reporting_objects.items():
            try:
                reader.client.bucket(reader.grant['bucket']).blob(old_key, generation=old_generation).download_as_bytes(if_generation_match=old_generation, raw_download=True, start=0, end=1024, timeout=15, retry=None)
            except NotFound:
                # The native generation itself must be absent after revocation.
                pass
            else: raise BuyerGateError('old native provider generation unavailable')
        retained = await client.get_reporting_status(GetReportingStatusRequest.model_validate({
            "account": account, "view": "revision", "reporting_revision_id": revision.reporting_revision_id,
        }))
        require(retained.data.revision.reporting_revision_id == revision.reporting_revision_id, "metadata retention")
    return {"status": "passed", "mode": mode, "python_version": version("adcp"),
            "compressed_provider_bytes_raw_and_bounded": True, "anonymous_provider_status": reader.anonymous_status, "outside_prefix_provider_403": True, "reader_write_provider_403": True,
            "exact_revision_read": True, "independent_manifest_inspection": True,
            "resource_reads": reader.calls, "canonical_digest_verified": billing,
            "tampered_delivered_file_rejected": True,
            "accepted_receipt_count": len(receipts), "lost_response_repaired": billing,
            "duplicate_receipt_count": 0, "revoked_resource_unreadable": True, "old_native_generation_provider_404": True, "revoked_provider_generation_count": len(reporting_objects), "historical_metadata_retained": True}


if __name__ == "__main__":
    try:
        result = asyncio.run(run(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]))
    except Exception as error:
        # The owned runner scrubs its logs. Do not copy SDK/network diagnostics
        # into the aggregate output, where they could contain credentials.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__, "stage": stage, "gate": str(error) if isinstance(error, BuyerGateError) else None}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
