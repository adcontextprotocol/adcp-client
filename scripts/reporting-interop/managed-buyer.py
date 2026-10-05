"""Installed Python buyer inspecting files delivered by the TypeScript runtime."""

import asyncio
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

from adcp import ADCPClient, AgentConfig
from adcp.reporting import ExpectedReportingPeriod, ReportingInspectionContext, reconcile_reporting
from adcp.reporting.canonical_json import canonical_json_utf8_v1
from adcp.reporting_inspection import ManifestReportingInspector, ReportingInspectionCode, ReportingInspectionError
from adcp.types import ComplyTestControllerRequest, GetAdcpCapabilitiesRequest, GetMediaBuyDeliveryRequest, GetReportingStatusRequest, Protocol


def require(condition, label):
    if not condition:
        raise ValueError(label)


def wire(model):
    return model.model_dump(mode="json", exclude_none=True, exclude_unset=True)


class FileReader:
    def __init__(self, root):
        self.root = root.resolve()
        self.contracts = json.loads((root / "contracts.json").read_bytes())
        self.calls = 0

    async def read(self, locator, *, base=None, max_bytes):
        uri = urljoin(base, locator) if base else locator
        if uri in self.contracts:
            target = self.root / "contracts" / self.contracts[uri]
        else:
            parsed = urlsplit(uri)
            require(parsed.scheme == "https" and parsed.netloc == "reports.example.test", "resource origin")
            require(not parsed.query and not parsed.fragment, "resource URL")
            target = self.root / unquote(parsed.path).lstrip("/")
        target = target.resolve()
        require(target.is_relative_to(self.root), "resource containment")
        self.calls += 1
        with target.open("rb") as resource:
            body = resource.read(max_bytes + 1)
        require(len(body) <= max_bytes, "resource byte limit")
        return body


class LostResponse(RuntimeError):
    pass


class CorruptFileReader:
    """Change one delivered row byte without changing its advertised hash."""

    def __init__(self, reader):
        self.reader = reader
        self.changed = False

    async def read(self, locator, *, base=None, max_bytes):
        body = await self.reader.read(locator, base=base, max_bytes=max_bytes)
        if urlsplit(urljoin(base, locator) if base else locator).path.endswith("/rows.jsonl"):
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
        reader = FileReader(destination)
        status = await client.get_reporting_status(request)
        ledger = wire(status.data)
        require(len(ledger["periods"]) == len(ledger["revisions"]) == len(ledger["materializations"]) == 1, "closed scope")
        revision = status.data.revisions[0]
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
        context = ReportingInspectionContext(status.data.periods[0], revision, materialization)
        observation = await ManifestReportingInspector(reader)(context)
        require(observation.row_count == len(expected_rows), "independent manifest row count")
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
        dropped = DropCommittedResponse(client)
        if billing:
            try:
                result = await reconcile_reporting(dropped, request, resource_reader=reader, expected_periods=[expected],
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
    # the lost response; no retained in-memory buyer state can mask duplication.
    async with ADCPClient(config, adcp_version=fixture["adcp_schema_version"]) as client:
        repaired = await reconcile_reporting(client, request, resource_reader=reader, expected_periods=[expected],
                                              reporting_capabilities=reporting_capabilities,
                                              now=datetime.now(timezone.utc))
        require(repaired.definitive and not repaired.submitted_receipts, "restart repair without duplicate submission")
        receipts = wire((await client.get_reporting_status(request)).data).get("receipts", [])
        require(len(receipts) == (1 if billing else 0), "durable receipt count")
        if billing:
            require(receipts[0]["reporting_receipt_id"] == dropped.receipt_ids[0] and receipts[0]["status"] == "accepted",
                    "exact committed receipt survives restart")
        revoked = await client.comply_test_controller(ComplyTestControllerRequest.model_validate({
            "account": account, "scenario": scenario, "params": {"operation": "revoke_access"},
        }))
        require(wire(revoked.data)["simulated"]["access_revoked"] is True, "runtime revocation")
        try:
            await reader.read(str(materialization.resource.location), max_bytes=1024 * 1024)
        except FileNotFoundError:
            pass
        else:
            raise ValueError("revoked resource remains readable")
        retained = await client.get_reporting_status(GetReportingStatusRequest.model_validate({
            "account": account, "view": "revision", "reporting_revision_id": revision.reporting_revision_id,
        }))
        require(retained.data.revision.reporting_revision_id == revision.reporting_revision_id, "metadata retention")
    return {"status": "passed", "mode": mode, "python_version": version("adcp"),
            "exact_revision_read": True, "independent_manifest_inspection": True,
            "resource_reads": reader.calls, "canonical_digest_verified": billing,
            "tampered_delivered_file_rejected": True,
            "accepted_receipt_count": len(receipts), "lost_response_repaired": billing,
            "duplicate_receipt_count": 0, "revoked_resource_unreadable": True, "historical_metadata_retained": True}


if __name__ == "__main__":
    try:
        result = asyncio.run(run(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]))
    except Exception as error:
        # The owned runner scrubs its logs. Do not copy SDK/network diagnostics
        # into the aggregate output, where they could contain credentials.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}), file=sys.stderr)
        raise
    print(json.dumps(result))
