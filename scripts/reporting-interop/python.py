"""Inspect the peer's exact manifest bytes and construct SDK-native receipts.

Run with an isolated installed-wheel interpreter (-I); no source-tree imports.
"""

import asyncio
import base64
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

from adcp import get_adcp_spec_version
# The interoperability gate installs the SHA-pinned wheel in pins.json,
# whose internal resolver applies the same stable-patch wire compatibility.
from adcp._version import resolve_adcp_version
from adcp.reporting import ReportingInspectionContext, ReportingObservation, build_reporting_receipt
from adcp.reporting.adjustment_evidence import (
    ReportingAdjustmentReceiptContext,
    ReportingAdjustmentScope,
    build_reporting_adjustment_receipt,
    capture_reporting_adjustment_evidence,
)
from adcp.reporting.canonical_json import canonical_json_utf8_v1
from adcp.reporting_inspection import ManifestReportingInspector
from adcp.types import (
    ReportingAdjustment, ReportingAdjustmentReceipt, ReportingMaterialization,
    ReportingObligation, ReportingRevision,
)

ADCP_VERSION = get_adcp_spec_version()


def require(condition, label):
    if not condition:
        raise ValueError(label)


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def wire(model):
    # Omit absent protocol fields, preserving fields explicitly emitted by the
    # builder. Pydantic's JSON serializer emits UTC instants using the wire Z.
    return model.model_dump(mode="json", exclude_none=True, exclude_unset=True)


async def run(fixture_root, peer=None):
    fixture = json.loads((fixture_root / "reporting-interop/evidence-v1.json").read_bytes())
    require(fixture["contract"] == "reporting_evidence_interop_v1", "fixture contract")
    require(fixture["version"] == 1, "fixture version")
    require(re.fullmatch(r"\d+\.\d+\.\d+", fixture["adcp_schema_version"]) is not None, "stable schema version")
    require(
        resolve_adcp_version(ADCP_VERSION) == resolve_adcp_version(fixture["adcp_schema_version"]),
        "schema version",
    )
    vectors = json.loads((fixture_root / "reporting-interop/canonical-json-v1.json").read_bytes())
    for vector in vectors["vectors"]:
        body = canonical_json_utf8_v1(vector["value"])
        require(body.hex() == vector["canonical_utf8_hex"], vector["name"])
        require(sha256(body) == vector["sha256"], vector["name"])
    revision_bytes = canonical_json_utf8_v1(fixture["revision_binding"]["value"])
    require(revision_bytes.hex() == fixture["revision_binding"]["canonical_utf8_hex"], "revision bytes")
    require(sha256(revision_bytes) == fixture["revision_binding"]["sha256"], "revision digest")
    require(sha256(revision_bytes) == fixture["revision"]["revision_content_sha256"], "revision binding")

    resource_dir = fixture_root / "reporting-interop/resources"
    pins = json.loads((resource_dir / "fixture.json").read_bytes())
    resources = {}
    for name in ("manifest.json", "rows.jsonl", "row-schema.json", "report-definition.json", "canonicalization.json"):
        body = (resource_dir / name).read_bytes()
        require(sha256(body) == pins["files"][name]["sha256"], name)
        require(len(body) == pins["files"][name]["size_bytes"], name)
        resources[name] = body
    manifest = canonical_json_utf8_v1(json.loads(resources["manifest.json"]))
    manifest_digest = sha256(manifest)
    if peer:
        require(peer["contract"] == fixture["contract"], "peer contract")
        require(peer["version"] == fixture["version"], "peer version")
        require(peer["adcp_schema_version"] == fixture["adcp_schema_version"], "peer schema version")
        require(base64.b64decode(peer["manifest_utf8_base64"], validate=True) == manifest, "peer manifest bytes")
        require(peer["manifest_sha256"] == manifest_digest, "peer manifest digest")
    resources["manifest.json"] = manifest if peer is None else base64.b64decode(peer["manifest_utf8_base64"])
    materialization = dict(fixture["materialization"])
    materialization["resource"] = {**materialization["resource"], "manifest_sha256": manifest_digest}
    context = ReportingInspectionContext(
        ReportingObligation.model_validate(fixture["obligation"]),
        ReportingRevision.model_validate(fixture["revision"]),
        ReportingMaterialization.model_validate(materialization),
    )
    locations = {
        str(context.revision.schema_uri): "row-schema.json",
        str(context.revision.report_definition_uri): "report-definition.json",
        str(context.revision.canonical_content_digest.canonicalization_uri): "canonicalization.json",
        str(context.materialization.resource.location): "manifest.json",
        urljoin(str(context.materialization.resource.location), "rows.jsonl"): "rows.jsonl",
    }

    class Reader:
        async def read(self, locator, *, base=None, max_bytes):
            location = urljoin(base, locator) if base else locator
            body = resources[locations[location]]
            require(len(body) <= max_bytes, "resource limit")
            return body

    observation = await ManifestReportingInspector(Reader())(context)
    require(observation.row_count == pins["expected"]["row_count"], "row count")
    require([wire(total) for total in observation.control_totals] == pins["expected"]["control_totals"], "control totals")
    require(observation.canonical_content_digest.value == pins["expected"]["canonical_content_sha256"], "canonical digest")
    observed_at = datetime.fromisoformat(fixture["observed_at"].replace("Z", "+00:00"))
    revision_receipts = []
    for delta in (0, 1):
        changed = ReportingObservation(
            row_count=observation.row_count + delta, control_totals=observation.control_totals,
            canonical_content_digest=observation.canonical_content_digest, manifest_sha256=observation.manifest_sha256,
        )
        revision_receipts.append(wire(build_reporting_receipt(
            context, changed, reporting_receipt_id=f"receipt-revision-{delta}", observed_at=observed_at,
        )))
    require(revision_receipts[0]["status"] == "accepted", "accepted revision receipt")
    require(revision_receipts[1]["status"] == "rejected", "rejected revision receipt")
    scope = ReportingAdjustmentScope(**fixture["scope"])
    receipt_context = ReportingAdjustmentReceiptContext.from_selection(
        scope, obligation=context.obligation, revision=context.revision,
        revision_owner=scope.reporting_obligation_id,
    )
    adjustments = []
    for vector in fixture["adjustments"]:
        raw = vector["adjustment"]
        evidence = capture_reporting_adjustment_evidence(
            json.dumps(raw, ensure_ascii=False).encode("utf-8"),
            typed_adjustment=ReportingAdjustment.model_validate(raw), scope=scope,
        )
        require(evidence.canonical_json.hex() == vector["canonical_utf8_hex"], vector["id"])
        require(evidence.observed_adjustment_sha256 == vector["sha256"], vector["id"])
        current = ReportingAdjustmentReceipt.model_validate(vector["current_receipt"]) if "current_receipt" in vector else None
        receipt = wire(build_reporting_adjustment_receipt(
            evidence, receipt_context, reporting_receipt_id=vector["expected_receipt"]["reporting_receipt_id"],
            observed_at=observed_at, current_receipt=current,
        ))
        require(receipt == vector.get("expected_python_receipt", vector["expected_receipt"]), f"{vector['id']} receipt")
        adjustments.append({"id": vector["id"], "canonical_utf8_hex": evidence.canonical_json.hex(), "receipt": receipt})
    # Evidence retains the fixture contract; run.mjs records the tested SDK pin.
    output = {
        "contract": fixture["contract"], "version": fixture["version"], "adcp_schema_version": fixture["adcp_schema_version"],
        "manifest_utf8_base64": base64.b64encode(manifest).decode("ascii"), "manifest_sha256": manifest_digest,
        "revision_content_utf8_base64": base64.b64encode(revision_bytes).decode("ascii"),
        "revision_receipts": revision_receipts, "adjustments": adjustments,
    }
    if peer:
        expected_peer = {**output, "adjustments": [
            {"id": vector["id"], "canonical_utf8_hex": vector["canonical_utf8_hex"], "receipt": vector["expected_receipt"]}
            for vector in fixture["adjustments"]
        ]}
        require(expected_peer == peer, "cross-SDK evidence/receipt mismatch")
    return output


if __name__ == "__main__":
    fixture_root = Path(sys.argv[1]).resolve()
    peer = json.loads(Path(sys.argv[2]).read_bytes()) if len(sys.argv) > 2 else None
    print(json.dumps(asyncio.run(run(fixture_root, peer)), ensure_ascii=False))
