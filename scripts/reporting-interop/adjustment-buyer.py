"""Pinned test control composing installed APIs over real MCP.

SQL hooks, adapter ingress and private plan bytes target the exact 8.0.0 wheel;
these diagnostics are harness internals, not a general adopter interface.

This bounded reference application is deliberately separate from the SDK's
reconcile_reporting facade. MCP ingress is decoded mapping evidence, not a
claim to preserve the HTTP byte spelling or detect upstream duplicate keys.
"""
import asyncio
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import sys
from datetime import datetime, timezone

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from adcp import ADCPClient, AgentConfig
from adcp.reporting import ReportingInspectionContext, build_reporting_receipt
from adcp.reporting.adjustment_evidence import (
    ReportingAdjustmentReceiptContext, ReportingAdjustmentScope,
    build_reporting_adjustment_receipt, capture_reporting_adjustment_evidence,
)
from adcp.reporting.canonical_json import canonical_json_utf8_v1
from adcp.reporting.submissions import (
    PgReportingSubmissionIntentStore, ReportingSubmissionScope, submit_reporting_receipts,
)
from adcp.reporting_inspection import ManifestReportingInspector
from adcp.types import (
    GetMediaBuyDeliveryRequest, GetReportingStatusRequest, GetReportingStatusResponse,
    ReportingAdjustment, Protocol,
)

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("file_inspection", here / "managed-buyer.py")
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)
sha = lambda body: hashlib.sha256(body).hexdigest()


class GateError(ValueError):
    """Static fixture stage, never an SDK/network diagnostic."""


def require(condition, label):
    if not condition:
        raise GateError(label)


async def main(settings):
    output = Path(settings["output"])
    origins = {}
    for name in ("adcp.reporting.adjustment_evidence", "adcp.reporting.submissions.submit",
                 "adcp.reporting.submissions.pg", "adcp.reporting_inspection", "adcp.protocols.mcp"):
        origin = Path(importlib.import_module(name).__file__).resolve()
        require("site-packages" in origin.parts, "installed SDK origin")
        origins[name] = sha(origin.read_bytes())
    scope = ReportingSubmissionScope(settings["seller_id"], "reporting_core_lab", settings["consumer_id"])
    config = AgentConfig(id="installed-adjustment-seller", name="installed-adjustment-seller",
                         agent_uri=settings["url"], protocol=Protocol.MCP,
                         auth_token=settings["token"], auth_header="Authorization", auth_type="bearer")
    fixture = json.loads((here.parents[1] / "test/fixtures/reporting-interop/evidence-v1.json").read_bytes())
    calls = []

    async def pause(point):
        if settings.get("pause") == point or point in settings.get("pauses", []):
            print(json.dumps({"point": point}), flush=True)
            command = json.loads(await asyncio.to_thread(sys.stdin.readline))
            require(command == {"continue": True}, "owned continuation")

    class Connection(AsyncConnection):
        async def execute(self, query, params=None, **kwargs):
            result = await super().execute(query, params, **kwargs)
            if isinstance(query, str) and query.startswith("UPDATE reporting_buyer_submission_intents"):
                await pause("confirmation_row")
            return result

    class Store(PgReportingSubmissionIntentStore):
        async def reserve(self, proposed):
            await pause("before_intent")
            result = await super().reserve(proposed)
            await pause("intent_committed")
            return result

        async def confirm(self, scope, submission_id, chunk, response):
            result = await super().confirm(scope, submission_id, chunk, response)
            await pause("confirmation_committed")
            return result

    async with AsyncConnectionPool(settings["conninfo"], open=False, min_size=1, max_size=2,
                                    connection_class=Connection,
                                    kwargs={"options": "-c search_path=" + settings["schema"] + " -c statement_timeout=15000"}) as pool:
        store = Store(pool=pool)
        async with ADCPClient(config, adcp_version=fixture["adcp_schema_version"]) as official:
            class Client:
                async def sync_reporting_receipts(self, request):
                    body = canonical_json_utf8_v1(request.model_dump(mode="json", exclude_none=True))
                    calls.append({"sha256": sha(body), "idempotency_key": request.idempotency_key})
                    (output / f"request-{len(calls)}.json").write_bytes(body)
                    await pause("before_seller")
                    response = await official.sync_reporting_receipts(request)
                    require(response.success and response.status == "completed", "real receipt response")
                    require(all(item.result in ("recorded", "unchanged") for item in response.data.results),
                            "seller recorded every verified receipt")
                    await pause("seller_committed")
                    return response

            client = Client()

            async def authorize(candidate):
                require(candidate is client and official.agent_config is config and
                        str(config.agent_uri) == settings["url"] and config.auth_token == settings["token"],
                        "trusted client authorization binding")
                return scope

            request = GetReportingStatusRequest.model_validate({
                "account": {"account_id": scope.account_id}, "view": "periods",
                "period": {key: fixture["revision"]["period"][key] for key in ("start", "end")},
            })
            receipts = None
            evidence_hashes = {}
            if not settings.get("resume"):
                # Capture the official adapter's decoded values before any
                # reporting model conversion; never model_dump inbound evidence.
                ingress = await official.adapter.get_reporting_status(request.model_dump(mode="json", exclude_none=True))
                require(ingress.success and isinstance(ingress.data, dict), "authenticated MCP ingress")
                raw = ingress.data
                require(len(canonical_json_utf8_v1(raw)) <= 1024 * 1024, "bounded status ingress")
                require(raw.get("pagination", {}).get("has_more") is False, "complete bounded history")
                (output / "ingress.json").write_bytes(canonical_json_utf8_v1(raw))
                ledger = GetReportingStatusResponse.model_validate(raw)
                require(len(ledger.periods) == len(ledger.revisions) == len(ledger.materializations) == 1,
                        "one complete obligation and official revision")
                obligation, revision, materialization = ledger.periods[0], ledger.revisions[0], ledger.materializations[0]
                require(obligation.reporting_obligation_id == "obligation-billing" and
                        obligation.account_id == revision.account_id == scope.account_id and
                        revision.reporting_revision_id == fixture["revision"]["reporting_revision_id"], "selected owned scope")
                require(revision.finality == "official" and revision.revision_content_sha256 == fixture["revision"]["revision_content_sha256"],
                        "immutable official revision")
                adjustment_scope = ReportingAdjustmentScope(scope.seller_id, scope.account_id, scope.consumer_id,
                                                             obligation.reporting_obligation_id)
                context = ReportingAdjustmentReceiptContext.from_selection(
                    adjustment_scope, obligation=obligation, revision=revision,
                    revision_owner=obligation.reporting_obligation_id,
                )
                require(obligation.adjustment_count == len(raw.get("adjustments", [])), "complete adjustment history")
                adjustment_ids = [item["reporting_adjustment_id"] for item in raw["adjustments"]]
                require(len(adjustment_ids) == len(set(adjustment_ids)), "unique adjustment identities")
                expected = [value["adjustment"] for value in fixture["adjustments"]
                            if value["id"] in ("integer_delta", "exact_decimal", "unicode_composed")]
                require(set(adjustment_ids) in ({item["reporting_adjustment_id"] for item in expected[:2]},
                                               {item["reporting_adjustment_id"] for item in expected}), "expected committed adjustments")
                now = datetime.now(timezone.utc)
                receipts = []
                # No supersession is needed in this controlled history. Refuse
                # an ambiguous/rejected chain rather than guessing a leaf.
                previous = ledger.receipts or []
                require(len(previous) <= 1 and all(item.status == "accepted" and
                        item.reporting_revision_id == revision.reporting_revision_id and
                        item.reporting_materialization_id == materialization.reporting_materialization_id and
                        item.supersedes_reporting_receipt_id is None for item in previous), "terminal revision leaf")
                if not previous:
                    exact_request = GetMediaBuyDeliveryRequest.model_validate({
                        "account": {"account_id": scope.account_id}, "reporting_revision_id": revision.reporting_revision_id,
                    })
                    exact = await official.adapter.get_media_buy_delivery(exact_request.model_dump(mode="json", exclude_none=True))
                    require(exact.success and exact.status == "completed" and isinstance(exact.data, dict), "exact revision read")
                    require(len(canonical_json_utf8_v1(exact.data)) <= 1024 * 1024, "exact revision admission limit")
                    binding = {"reporting_revision_id": revision.reporting_revision_id, "row_count": raw["revisions"][0]["row_count"],
                               "control_totals": raw["revisions"][0]["control_totals"],
                               "reporting_rows": exact.data["reporting_rows"]}
                    require(sha(canonical_json_utf8_v1(binding)) == revision.revision_content_sha256, "exact revision digest")
                    inspection = ReportingInspectionContext(obligation, revision, materialization)
                    observation = await ManifestReportingInspector(files.FileReader(Path(settings["destination"])))(inspection)
                    receipt = build_reporting_receipt(inspection, observation,
                        reporting_receipt_id=settings["proposal"] + "-revision", observed_at=now)
                    require(receipt.status == "accepted", "verified revision receipt")
                    receipts.append(receipt)
                leaves = ledger.adjustment_receipts or []
                require(len({item.reporting_adjustment_id for item in leaves}) == len(leaves) and
                        all(item.status == "accepted" and item.supersedes_reporting_receipt_id is None and
                            item.reporting_adjustment_id in adjustment_ids and
                            item.adjusts_reporting_revision_id == revision.reporting_revision_id for item in leaves),
                        "complete terminal adjustment leaves")
                for item in raw["adjustments"]:
                    require(item in expected, "exact committed adjustment mapping")
                    evidence = capture_reporting_adjustment_evidence(item,
                        typed_adjustment=ReportingAdjustment.model_validate(item), scope=adjustment_scope)
                    require(evidence.observed_adjustment_sha256 == item["canonical_adjustment_sha256"], "independent adjustment digest")
                    evidence_hashes[item["reporting_adjustment_id"]] = evidence.observed_adjustment_sha256
                    current = [leaf for leaf in leaves if leaf.reporting_adjustment_id == item["reporting_adjustment_id"]]
                    require(not current or current[0].observed_adjustment_sha256 == evidence.observed_adjustment_sha256,
                            "accepted leaf digest")
                    if not current:
                        receipt = build_reporting_adjustment_receipt(evidence, context,
                            reporting_receipt_id=settings["proposal"] + "-" + item["reporting_adjustment_id"], observed_at=now)
                        require(receipt.status == "accepted", "verified adjustment receipt")
                        receipts.append(receipt)
                require(bool(receipts), "fresh receipt plan")
            result = await submit_reporting_receipts(client, authorizer=authorize, store=store, receipts=receipts)
            require(not result.pending and all(item.result in ("recorded", "unchanged") for item in result.outcomes),
                    "confirmed durable receipt outcomes")
            after = await official.get_reporting_status(request)
            require(after.success and after.status == "completed", "authoritative repair read")
            (output / "after-status.json").write_bytes(canonical_json_utf8_v1(after.data.model_dump(mode="json", exclude_none=True)))
            require(after.data.periods[0].reconciliation_status == "accepted", "all current receipts reconcile the period")
            await pause("returned")
            return {"point": "done", "pending": result.pending, "proposal_deferred": result.proposal_deferred,
                    "submission_id": result.submission.submission_id, "plan_sha256": sha(result.submission._plan),
                    "outcomes": [item.result for item in result.outcomes], "calls": calls,
                    "evidence_sha256": evidence_hashes, "installed_modules": origins,
                    "revision_sha256": after.data.revisions[0].revision_content_sha256,
                    "reconciliation_status": after.data.periods[0].reconciliation_status}


if __name__ == "__main__":
    try:
        settings = json.loads(sys.stdin.readline())
        print(json.dumps(asyncio.run(main(settings))), flush=True)
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, GateError) else None}), file=sys.stderr)
        sys.exit(1)
