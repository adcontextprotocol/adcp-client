"""Qualify the wheel's standalone durable mixed-receipt submission API.

These pinned upstream controls use real Python PostgreSQL seller ingestion.
They do not claim TypeScript seller / Python adjustment-loop integration.
"""
import contextlib
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import xml.etree.ElementTree as ET

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("owned_runtime", here / "managed.py")
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)


def stop_group(process):
    # Pytest controls launch independent buyer children. Stop the entire owned
    # process group even when its original leader has already exited.
    if getattr(process, "_reporting_group_stopped", False):
        return
    process._reporting_group_stopped = True
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
    process.wait(timeout=10)


def worker(upstream, output):
    # -I plus importlib test loading and an empty pythonpath keep all SDK
    # execution in the verified wheel. The harness supplies test code only.
    import pytest
    modules = ("adcp.reporting.submissions", "adcp.reporting.submissions.models",
               "adcp.reporting.submissions.store", "adcp.reporting.submissions.pg",
               "adcp.reporting.submissions.submit", "adcp.reporting.receipts.pg")
    origins = {}
    for name in modules:
        module = importlib.import_module(name)
        origin = Path(module.__file__).resolve()
        owned.require("site-packages" in origin.parts and not origin.is_relative_to(upstream), "installed SDK origin")
        origins[name] = hashlib.sha256(origin.read_bytes()).hexdigest()
    (output / "installed-origins.json").write_text(json.dumps(origins, indent=2))
    result = pytest.main([
        str(upstream / "tests/conformance/reporting/test_reporting_buyer_submission_process.py"),
        "--confcutdir=" + str(upstream / "tests/conformance/reporting"),
        "--rootdir=" + str(upstream),
        "--import-mode=importlib", "--override-ini=pythonpath=", "--override-ini=addopts=",
        "--override-ini=asyncio_mode=auto", "-p", "no:cacheprovider", "-q",
        "-p", "pytest_asyncio.plugin",
        "--junitxml=" + str(output / "junit.xml"),
    ])
    raise SystemExit(result)


def run(upstream, output):
    output.mkdir()
    pins = json.loads((here / "pins.json").read_bytes())
    owned.require(importlib.metadata.version("adcp") == pins["python_version"], "installed Python version")
    admin = os.environ["REPORTING_INTEROP_PG_URL"]
    database = "adcp_buyer_submissions_" + secrets.token_hex(8)
    fields = conninfo_to_dict(admin)
    fields["dbname"] = database
    conninfo = make_conninfo(**fields)
    with contextlib.ExitStack() as owner:
        owner.callback(owned.scrub, output, (admin, conninfo, fields.get("password", "")))
        owner.callback(owned.drop, admin, database)
        with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(database)))
        # run.mjs supplies the blob-verified scripts/tests-only export. No SDK
        # source exists there for independent children to accidentally import.
        owned.require(not (upstream / "src/adcp").exists() and not (upstream / "adcp").exists(), "SDK source excluded")
        stdout = owner.enter_context((output / "pytest.stdout.log").open("wb"))
        stderr = owner.enter_context((output / "pytest.stderr.log").open("wb"))
        process = subprocess.Popen([sys.executable, "-I", "-u", str(Path(__file__).resolve()), "--worker", str(upstream), str(output)],
                                   stdout=stdout, stderr=stderr, start_new_session=True,
                                   cwd=output, env=owned.environment(ADCP_PG_TEST_URL=conninfo, PYTHONNOUSERSITE="1",
                                                                   PYTEST_DISABLE_PLUGIN_AUTOLOAD="1"))
        owner.callback(stop_group, process)
        timed_out = False
        try:
            process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop_group(process)
        owned.require(not timed_out, "durable buyer controls deadline")
        owned.require(process.returncode == 0, "installed durable buyer controls")
        suites = ET.parse(output / "junit.xml").getroot()
        cases = list(suites.iter("testcase"))
        owned.require(len(cases) == 11, "all ten crash boundaries and concurrent buyer control")
        points = ("before_intent", "scope_row", "intent_row", "intent_committed", "before_seller",
                  "seller_committed", "response_delivered", "confirmation_row", "confirmation_committed", "returned")
        expected = {f"test_process_death_preserves_exact_requests_and_confirmed_outcomes[{point}]" for point in points}
        expected.add("test_independent_concurrent_buyers_replay_one_reserved_seller_request")
        owned.require({case.attrib["name"] for case in cases} == expected, "exact durable control identities")
        owned.require(not any(case.find(tag) is not None for case in cases for tag in ("failure", "error", "skipped")),
                      "no failed or skipped durable buyer controls")
        return {"status": "passed", "python_version": importlib.metadata.version("adcp"),
                "scope": "standalone Python durable mixed revision/adjustment receipt submission",
                "seller": "installed Python PostgreSQL ingestion", "process_death_controls": 10,
                "concurrent_buyer_controls": 1,
                "pytest_version": importlib.metadata.version("pytest"),
                "pytest_asyncio_version": importlib.metadata.version("pytest-asyncio"),
                "sdk_source_excluded": True, "pytest_plugin_autoload_disabled": True,
                "installed_modules": json.loads((output / "installed-origins.json").read_bytes()),
                "test_cases": [case.attrib["name"] for case in cases]}


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, owned.interrupted)
    try:
        if sys.argv[1] == "--worker":
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            worker(*(Path(value).resolve() for value in sys.argv[2:4]))
        print(json.dumps(run(*(Path(value).resolve() for value in sys.argv[1:3]))))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, owned.GateError) else None}), file=sys.stderr)
        sys.exit(1)
