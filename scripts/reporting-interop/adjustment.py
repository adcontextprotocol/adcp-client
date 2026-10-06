"""Pinned test control owning a TS seller and independent buyer processes.

PostgreSQL plan inspection targets the exact Python 8.0.0 storage format.
"""
import asyncio
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import secrets
import select
import signal
import socket
import subprocess
import sys
import time

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg_pool import AsyncConnectionPool
from adcp import ADCPClient, AgentConfig
from adcp.reporting.submissions import PgReportingSubmissionIntentStore
from adcp.reporting.canonical_json import canonical_json_utf8_v1
from adcp.types import ComplyTestControllerRequest, GetReportingStatusRequest, Protocol

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("owned_adjustment_runtime", here / "managed.py")
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)
require = owned.require
sha = lambda body: hashlib.sha256(body).hexdigest()
POINTS = ("before_intent", "intent_committed", "before_seller", "seller_committed",
          "confirmation_row", "confirmation_committed", "returned")


class Buyer:
    def __init__(self, owner, settings, output):
        output.mkdir()
        self.events = []
        self.buffer = b""
        self.stdout_path = output / "events.json"
        stderr = owner.enter_context((output / "stderr.log").open("wb"))
        self.process = subprocess.Popen([sys.executable, "-I", "-u", str(here / "adjustment-buyer.py")],
            cwd=output, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
            env=owned.environment(), bufsize=0)
        owner.callback(self.close)
        self.send({**settings, "output": str(output)})

    def send(self, value):
        self.process.stdin.write(json.dumps(value).encode() + b"\n")

    def event(self, point):
        deadline = time.monotonic() + 120
        while b"\n" not in self.buffer:
            require(time.monotonic() < deadline, "buyer event deadline")
            ready = select.select([self.process.stdout], [], [], min(1, max(0, deadline - time.monotonic())))[0]
            if ready:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                require(bool(chunk), "buyer exited before expected event")
                self.buffer += chunk
                require(len(self.buffer) <= 1024 * 1024, "buyer event byte bound")
        line, self.buffer = self.buffer.split(b"\n", 1)
        value = json.loads(line)
        require(value["point"] == point, "exact buyer boundary")
        self.events.append(value)
        self.stdout_path.write_text(json.dumps(self.events, indent=2))
        return value

    def kill(self):
        self.process.kill()
        self.process.wait(timeout=10)

    def done(self):
        result = self.event("done")
        require(self.process.wait(timeout=15) == 0, "buyer completed normally")
        return result

    def close(self):
        try:
            owned.stop(self.process)
        finally:
            for pipe in (self.process.stdin, self.process.stdout):
                pipe.close()


async def schemas(conninfo, names):
    for name in names:
        async with AsyncConnectionPool(conninfo, open=False, min_size=1, max_size=1,
                                       kwargs={"options": "-c search_path=" + name}) as pool:
            await PgReportingSubmissionIntentStore(pool=pool).create_schema()


def snapshot(conninfo, schema, consumer):
    with psycopg.connect(conninfo, connect_timeout=10, options="-c statement_timeout=15000") as connection:
        plans = connection.execute(sql.SQL("SELECT canonical_plan,pending FROM {}.reporting_buyer_submission_intents").format(
            sql.Identifier(schema))).fetchall()
        counts = connection.execute(
            "SELECT (SELECT count(*) FROM seller.adcp_reporting_receipts WHERE consumer_id=%s),"
            " (SELECT count(*) FROM seller.adcp_reporting_receipt_batches WHERE consumer_id=%s)",
            (consumer, consumer)).fetchone()
        return {"plans": [{"sha256": sha(body.encode()), "pending": pending,
                           "request_sha256": {request["idempotency_key"]: sha(canonical_json_utf8_v1(request))
                                              for request in json.loads(body)["requests"]}} for body, pending in plans],
                "receipts": counts[0], "batches": counts[1]}


async def inspect(url, principal, *, append=False):
    fixture = json.loads((here.parents[1] / "test/fixtures/reporting-interop/evidence-v1.json").read_bytes())
    config = AgentConfig(id="adjustment-control", name="adjustment-control", agent_uri=url, protocol=Protocol.MCP,
                         auth_token=principal["token"], auth_header="Authorization", auth_type="bearer")
    async with ADCPClient(config, adcp_version=fixture["adcp_schema_version"]) as client:
        if append:
            result = await client.comply_test_controller(ComplyTestControllerRequest.model_validate({
                "account": {"brand": {"domain": "reporting.example.test"}, "operator": "test.example", "sandbox": True},
                "scenario": "reliable_reporting_reconciled_billing_probe", "params": {"operation": "publish_adjustment"},
            }))
            require(result.success and result.status == "completed", "later adjustment committed")
        result = await client.get_reporting_status(GetReportingStatusRequest.model_validate({
            "account": {"account_id": "reporting_core_lab"}, "view": "periods",
            "period": {key: fixture["revision"]["period"][key] for key in ("start", "end")},
        }))
        require(result.success and result.status == "completed", "authoritative scoped read")
        require(result.data.pagination.has_more is False, "complete authoritative repair history")
        return result.data.model_dump(mode="json", exclude_none=True)


def run(installation, node, output):
    output.mkdir()
    destination = output / "destination"
    destination.mkdir()
    audit = output / "seller-requests.jsonl"
    audit.touch(exist_ok=False)
    pins = json.loads((here / "pins.json").read_bytes())
    require(importlib.metadata.version("adcp") == pins["python_version"], "installed Python version")
    package = json.loads((installation / "node_modules/@adcp/sdk/package.json").read_bytes())
    lock = json.loads((installation / "package-lock.json").read_bytes())["packages"]["node_modules/@adcp/sdk"]
    require(package["version"] == lock["version"], "installed TypeScript artifact")
    admin = os.environ["REPORTING_INTEROP_PG_URL"]
    database = "adcp_adjustment_loop_" + secrets.token_hex(8)
    fields = conninfo_to_dict(admin)
    fields["dbname"] = database
    conninfo = make_conninfo(**fields)
    url = owned.node_database_url(fields)
    names = [*POINTS, "concurrent"]
    principals = [{"id": name, "consumer_id": "https://buyer.example.test/adcp/" + name,
                   "token": secrets.token_urlsafe(32), "controller": name == "returned"} for name in names]
    private = [admin, conninfo, url, fields.get("password", ""), *(entry["token"] for entry in principals)]
    proof = secrets.token_urlsafe(32)
    private.append(proof)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    ready_file = output / "ready.json"
    with contextlib.ExitStack() as owner:
        owner.callback(owned.scrub, output, private)
        owner.callback(owned.drop, admin, database)
        with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(database)))
        with psycopg.connect(conninfo, autocommit=True, connect_timeout=10) as connection:
            for name in names:
                connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier("buyer_" + name)))
        asyncio.run(schemas(conninfo, ["buyer_" + name for name in names]))
        stderr = owner.enter_context((output / "seller.stderr.log").open("wb"))
        stdout = owner.enter_context((output / "seller.stdout.log").open("wb"))
        seller = subprocess.Popen([str(node), str(here / "adjustment-seller.cjs")],
            cwd=output, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
            env=owned.environment(DATABASE_URL=url, REPORTING_INTEROP_DESTINATION=str(destination)))
        owner.callback(owned.stop, seller)
        seller.stdin.write(json.dumps({"installation": str(installation), "port": port, "ready": str(ready_file),
                                      "integrity": lock["integrity"], "proof": proof, "audit": str(audit),
                                      "principals": principals}).encode() + b"\n")
        seller.stdin.close()
        deadline = time.monotonic() + 60
        while True:
            require(seller.poll() is None, "seller exited before readiness")
            require(time.monotonic() < deadline, "seller readiness deadline")
            if ready_file.exists():
                try:
                    ready = json.loads(ready_file.read_bytes())
                    break
                except json.JSONDecodeError:
                    pass
            time.sleep(0.1)
        require(ready["pid"] == seller.pid and ready["port"] == port and ready["integrity"] == lock["integrity"] and
                ready["version"] == package["version"],
                "owned installed seller")
        require(ready["startup_proof_sha256"] == sha(proof.encode()) and
                ready["auth_bindings"] == [{"id": value["id"], "sha256": sha(value["token"].encode())} for value in principals],
                "private startup and credential bindings")
        endpoint = f"http://127.0.0.1:{port}/mcp"
        def settings(principal, **extra):
            return {"seller_id": "https://seller.example.test/adcp", "url": endpoint, "token": principal["token"],
                    "consumer_id": principal["consumer_id"], "conninfo": conninfo,
                    "schema": "buyer_" + principal["id"], "destination": str(destination),
                    "proposal": "receipt-" + secrets.token_hex(8), **extra}
        controls = []
        for principal in principals[:-1]:
            point = principal["id"]
            first = Buyer(owner, settings(principal, pause=point), output / (point + "-first"))
            first.event(point)
            before = snapshot(conninfo, "buyer_" + point, principal["consumer_id"])
            committed = point != "before_intent"
            confirmed = point in ("confirmation_committed", "returned")
            seller_committed = point in ("seller_committed", "confirmation_row", "confirmation_committed", "returned")
            require(len(before["plans"]) == int(committed) and
                    all(plan["pending"] != confirmed for plan in before["plans"]), "durable intent boundary")
            require(before["receipts"] == 3 * int(seller_committed) and before["batches"] == int(seller_committed),
                    "actual seller commit boundary")
            first.kill()
            resumed = Buyer(owner, settings(principal, resume=committed), output / (point + "-restart"))
            result = resumed.done()
            after = snapshot(conninfo, "buyer_" + point, principal["consumer_id"])
            require(after["receipts"] == 3 and after["batches"] == 1 and len(after["plans"]) == 1 and
                    not after["plans"][0]["pending"], "one durable mixed receipt batch")
            require(result["plan_sha256"] == after["plans"][0]["sha256"] and
                    (not committed or before["plans"][0]["sha256"] == result["plan_sha256"]), "same frozen recovered plan")
            require(len(result["calls"]) == int(not confirmed), "cached confirmations avoid another send")
            observed_so_far = [json.loads(line) for line in audit.read_text().splitlines()
                               if json.loads(line)["consumer_id"] == principal["consumer_id"]]
            require(len(observed_so_far) == int(seller_committed) + len(result["calls"]) and
                    len({item["idempotency_key"] for item in observed_so_far}) == 1, "actual seller send count and replay identity")
            for item in observed_so_far:
                body = next((request.read_bytes() for folder in (output / (point + "-first"), output / (point + "-restart"))
                            for request in folder.glob("request-*.json")
                            if json.loads(request.read_bytes())["idempotency_key"] == item["idempotency_key"]), None)
                require(body is not None, "seller-observed key has a buyer send file")
                require(item["request_sha256"] == sha(body) == after["plans"][0]["request_sha256"][item["idempotency_key"]],
                        "seller saw the frozen canonical request from PostgreSQL")
            controls.append({"point": point, "before": before, "after": after, "result": result})
        principal = principals[-1]
        concurrent_principal = principal
        a = Buyer(owner, settings(principal, pauses=["before_intent", "before_seller"]), output / "concurrent-first")
        b = Buyer(owner, settings(principal, pauses=["before_intent", "before_seller"]), output / "concurrent-second")
        a.event("before_intent")
        b.event("before_intent")
        require(not snapshot(conninfo, "buyer_concurrent", principal["consumer_id"])["plans"], "reservation race starts without an intent")
        a.send({"continue": True})
        b.send({"continue": True})
        a.event("before_seller")
        b.event("before_seller")
        a.send({"continue": True})
        b.send({"continue": True})
        first, second = a.done(), b.done()
        require({first["proposal_deferred"], second["proposal_deferred"]} == {False, True} and
                first["submission_id"] == second["submission_id"] and first["plan_sha256"] == second["plan_sha256"] and
                first["calls"] == second["calls"] and len(first["calls"]) == 1,
                "concurrent independent buyers reuse the reserved request")
        concurrent = snapshot(conninfo, "buyer_concurrent", principal["consumer_id"])
        require(concurrent["receipts"] == 3 and concurrent["batches"] == 1 and len(concurrent["plans"]) == 1 and
                not concurrent["plans"][0]["pending"],
                "concurrent seller deduplication")
        # A new post-official correction reopens a previously reconciled
        # period. Accept only its fresh receipt, preserving every old fact.
        controller = principals[-2]
        initial = asyncio.run(inspect(endpoint, controller))
        reopened = asyncio.run(inspect(endpoint, controller, append=True))
        require(initial["periods"][0]["reconciliation_status"] == "accepted" and
                reopened["periods"][0]["reconciliation_status"] == "pending" and
                reopened["periods"][0]["adjustment_count"] == 3 and
                initial["revisions"] == reopened["revisions"], "later correction reopens immutable official evidence")
        later = Buyer(owner, settings(controller), output / "later-adjustment")
        later_result = later.done()
        require(len(later_result["outcomes"]) == 1, "only the new adjustment is acknowledged")
        final = asyncio.run(inspect(endpoint, controller))
        require(final["revisions"] == initial["revisions"] and final["receipts"] == initial["receipts"] and
                len(final["adjustment_receipts"]) == 3 and final["periods"][0]["reconciliation_status"] == "accepted",
                "repair preserves official and previous accepted receipts")
        prior_adjustments = {item["reporting_receipt_id"]: item for item in initial["adjustment_receipts"]}
        final_adjustments = {item["reporting_receipt_id"]: item for item in final["adjustment_receipts"]}
        require(all(final_adjustments.get(identifier) == item for identifier, item in prior_adjustments.items()) and
                len(final_adjustments.keys() - prior_adjustments.keys()) == 1 and
                next(item for identifier, item in final_adjustments.items() if identifier not in prior_adjustments)["reporting_adjustment_id"]
                    == "adjustment-unicode_composed", "exact prior adjustment receipts and new subject survive repair")
        later_state = snapshot(conninfo, "buyer_returned", controller["consumer_id"])
        require(later_state["receipts"] == 4 and later_state["batches"] == 2 and len(later_state["plans"]) == 2 and
                all(not plan["pending"] for plan in later_state["plans"]), "both adjustment generations durably confirmed")
        (output / "later-status.json").write_text(json.dumps({"before": initial, "reopened": reopened, "after": final}, indent=2))
        # Match the seller-observed canonical bodies to the exact SDK-reserved
        # bodies, including account/version/idempotency. No receipt echo proof.
        observed = [json.loads(line) for line in audit.read_text().splitlines()]
        requests = {}
        reserved_requests = {}
        for principal in principals:
            state = snapshot(conninfo, "buyer_" + principal["id"], principal["consumer_id"])
            for plan in state["plans"]:
                for key, digest in plan["request_sha256"].items():
                    require(key not in reserved_requests, "globally distinct fixture reservation identities")
                    reserved_requests[key] = digest
        for folder in output.iterdir():
            if folder.is_dir():
                for request in folder.glob("request-*.json"):
                    body = json.loads(request.read_bytes())
                    key, digest = body["idempotency_key"], sha(request.read_bytes())
                    require(key not in requests or requests[key] == digest, "every replay preserves canonical request bytes")
                    require(reserved_requests.get(key) == digest, "each buyer send is bound to its persisted PostgreSQL plan")
                    requests[key] = digest
        require(bool(observed) and all(item["request_sha256"] == requests[item["idempotency_key"]] == reserved_requests[item["idempotency_key"]]
                                      for item in observed),
                "seller saw the exact durable canonical request")
        require(sum(item["consumer_id"] == concurrent_principal["consumer_id"] for item in observed) == 2, "two concurrent seller sends")
        require(sum(item["consumer_id"] == controller["consumer_id"] for item in observed) == 2, "one send per correction generation")
        with psycopg.connect(conninfo, connect_timeout=10) as connection:
            pg_version = connection.execute("SHOW server_version").fetchone()[0]
            count, duplicate_receipts = connection.execute(
                "SELECT count(*),count(*)-count(DISTINCT (consumer_id,receipt_kind,subject_id)) FROM seller.adcp_reporting_receipts"
            ).fetchone()
            require(count == len(principals) * 3 + 1 and duplicate_receipts == 0, "exact final seller receipt inventory")
        return {"status": "passed", "seller_version": package["version"], "python_version": pins["python_version"],
                "postgres_version": pg_version, "scope": "reference composition of installed Python APIs with TypeScript seller",
                "ingress_evidence_kind": "official MCP decoded mapping before reporting model parsing",
                "process_death_controls": controls, "concurrent_buyers": {"first": first, "second": second, "seller": concurrent},
                "later_adjustment": later_result, "observed_receipt_requests": len(observed),
                "seller_observed_exact_reserved_requests": True, "duplicate_receipts": duplicate_receipts,
                "seller_request_evidence": "decoded MCP request after official schema validation",
                "concurrent_reservation_race": True,
                "facade_integration": False}


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, owned.interrupted)
    try:
        print(json.dumps(run(*(Path(value).resolve() for value in sys.argv[1:4]))))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, owned.GateError) else None}), file=sys.stderr)
        sys.exit(1)
