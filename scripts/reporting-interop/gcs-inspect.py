"""Inspect real private GCS objects using the installed Python SDK HTTPS reader."""
import asyncio
from datetime import datetime, timezone
from importlib.metadata import version
import hashlib
import json
from pathlib import Path
import platform
import sys
from urllib.parse import urljoin

from adcp.reporting import ReportingInspectionContext, build_reporting_receipt
from adcp.reporting_inspection import HttpsReportingResourceReader, ManifestReportingInspector, ReportingInspectionError, ReportingInspectionCode
from adcp.types import ReportingObligation, ReportingRevision, ReportingMaterialization

def require(value, label):
    if not value:
        raise ValueError(label)


async def fails(work, code, message=None):
    try:
        await work()
    except ReportingInspectionError as error:
        require(error.code == code, "negative control error code")
        if message:
            require(message in str(error), "negative control HTTP status")
        return
    raise ValueError("negative control unexpectedly passed")


async def main(node, phase):
    require(node in ("node20", "node24"), "runtime label")
    require(phase in ("positive", "tampered", "revoked"), "phase")
    ROOT = Path(sys.argv[1]).resolve()
    raw = json.loads((ROOT / "evidence" / (node + "-context.json")).read_text())
    expected = json.loads((ROOT / "evidence/expected.json").read_text())
    token_file = ROOT / "reader-token.json"
    require(token_file.stat().st_mode & 0o777 == 0o600, "private token file mode")
    private_bytes = token_file.read_bytes()
    private = json.loads(private_bytes)
    context = ReportingInspectionContext(ReportingObligation.model_validate(raw["obligation"]),
        ReportingRevision.model_validate(raw["revision"]), ReportingMaterialization.model_validate(raw["materialization"]))
    async def credentials(_url):
        return {"Authorization": "Bearer " + private["token"]}
    reader = HttpsReportingResourceReader(credentials, trusted_origins=["https://storage.googleapis.com"], timeout_seconds=15)
    location = str(context.materialization.resource.location)
    inspector = ManifestReportingInspector(reader)
    if phase == "positive":
        observation = await inspector(context)
        require(observation.row_count == expected["row_count"], "row count")
        require([x.model_dump(mode="json", exclude_none=True) for x in observation.control_totals] == expected["control_totals"], "control totals")
        require(observation.canonical_content_digest.value == expected["canonical_content_sha256"], "canonical digest")
        receipt = build_reporting_receipt(context, observation, reporting_receipt_id="receipt-gcs-qualified",
            observed_at=datetime(2026, 9, 2, 1, tzinfo=timezone.utc))
        require(receipt.status.value == "accepted", "accepted receipt")
        await fails(lambda: reader.read(location, max_bytes=1), ReportingInspectionCode.RESOURCE_TOO_LARGE)
        anonymous = HttpsReportingResourceReader(trusted_origins=["https://storage.googleapis.com"])
        await fails(lambda: anonymous.read(location, max_bytes=65536), ReportingInspectionCode.RESOURCE_UNAVAILABLE, "HTTP 403")
        outside = "/".join(location.split("/")[:4]) + "/outside/rows.jsonl"
        await fails(lambda: reader.read(outside, max_bytes=65536), ReportingInspectionCode.RESOURCE_UNAVAILABLE, "HTTP 403")
        await fails(lambda: reader.read("https://unauthorized.example.test/private", max_bytes=65536), ReportingInspectionCode.UNSAFE_RESOURCE)
        checks = dict(authenticated_network_inspection=True, canonical_digest_verified=True, accepted_receipt=True,
            response_byte_limit_enforced=True, anonymous_access_denied_403=True, outside_prefix_denied_403=True,
            untrusted_origin_refused=True, contract_digest_checks="sdk_builtin_inspector")
    elif phase == "tampered":
        await fails(lambda: inspector(context), ReportingInspectionCode.OBJECT_DIGEST_MISMATCH)
        checks = dict(network_object_tampering_rejected=True)
    elif phase == "revoked":
        expires = datetime.fromisoformat(private["expires_at"].replace("Z", "+00:00"))
        require(expires.tzinfo is not None, "token expiry timezone required")
        require(expires.timestamp() > datetime.now(timezone.utc).timestamp() + 60, "token unexpired")
        objects = ["manifest.json", "rows.jsonl", "row-schema.json", "report-definition.json", "canonicalization.json"]
        for name in objects:
            await fails(lambda: reader.read(urljoin(location, name), max_bytes=65536), ReportingInspectionCode.RESOURCE_UNAVAILABLE, "HTTP 403")
        checks = dict(revoked_retained_token_denied_403=True, token_unexpired=True, revoked_objects_denied_403=objects)
    else:
        raise ValueError("unknown phase")
    return dict(status="passed", language="python", python_sdk_version=version("adcp"), python=platform.python_version(),
        paired_runtime=node, reader_credential_file_sha256=hashlib.sha256(private_bytes).hexdigest(), phase=phase, **checks)


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(main(*sys.argv[2:]))))
    except Exception as error:
        code = getattr(error, "code", None)
        phase = sys.argv[3] if len(sys.argv) == 4 and sys.argv[3] in ("positive", "tampered", "revoked") else "invalid"
        print(json.dumps({"status": "failed", "phase": phase, "error_type": type(error).__name__,
            "code": code.value if isinstance(code, ReportingInspectionCode) else None}), file=sys.stderr)
        sys.exit(1)
